// A cap on how many Node processes a VS Code gulp build runs at once, for
// scripts/reh_in_container.sh. Loaded with `node --require` into the gulp
// process only (never through NODE_OPTIONS, which every child would inherit).
//
// Why: `bundle-non-native-extensions-build` (build/lib/extensions.ts) starts
// every built-in extension at once — for each, `node esbuild.mts` and, through
// build/lib/tsgo.ts, `node <@typescript/native>/bin/tsc --noEmit` for each of
// its build roots: some 170 Node processes and as many esbuild and tsgo
// programs side by side, with no option upstream to run fewer. On a machine
// with 8 GB that is killed for memory; upstream's agents have more.
//
// How: with DEVHUB_BUILD_JOBS=N and DEVHUB_BUILD_GATE_DIR set, every
// asynchronous spawn/execFile of this same `node` becomes
// `flock <dir>/<slot> node ...`, slots handed out in turn, so at most N run
// and the rest wait in flock (a few hundred KB each) with nothing started.
// Output, exit codes and the returned ChildProcess are flock's, which passes
// all three through. The children run with DEVHUB_BUILD_GATE_HELD=1 and do
// not gate their own children, so a gated process can never wait on a slot
// held by itself. Synchronous calls (execFileSync, spawnSync) are left alone:
// they block this process and cannot pile up. A child killed by SIGKILL is
// written to <dir>/killed (see markKilled).
'use strict';

const jobs = Number.parseInt(process.env.DEVHUB_BUILD_JOBS || '', 10);
const dir = process.env.DEVHUB_BUILD_GATE_DIR;

if (jobs > 0 && dir && !process.env.DEVHUB_BUILD_GATE_HELD) {
	const cp = require('child_process');
	const fs = require('fs');
	const path = require('path');
	fs.mkdirSync(dir, { recursive: true });

	const flock = process.env.DEVHUB_BUILD_GATE_FLOCK || 'flock';
	let next = 0;

	const isNode = (file) => file === process.execPath || file === process.argv[0];

	// [args, options, rest] of spawn(file, [args], [options]) and
	// execFile(file, [args], [options], [callback]).
	function split(rest) {
		let args = [];
		if (Array.isArray(rest[0])) {
			args = rest[0];
			rest = rest.slice(1);
		} else if (rest[0] == null && rest.length > 1) {
			rest = rest.slice(1);
		}
		let options = {};
		if (rest[0] && typeof rest[0] === 'object') {
			options = rest[0];
			rest = rest.slice(1);
		} else if (rest[0] == null && rest.length > 1) {
			rest = rest.slice(1);
		}
		return [args, options, rest];
	}

	function gate(original) {
		return function (file, ...rest) {
			const [args, options, tail] = split(rest);
			if (!isNode(file) || options.shell) {
				return original.call(this, file, ...rest);
			}
			const slot = path.join(dir, String(next++ % jobs));
			const env = { ...(options.env || process.env), DEVHUB_BUILD_GATE_HELD: '1' };
			const child = original.call(this, flock, [slot, file, ...args], { ...options, env }, ...tail);
			child.on('exit', (code, signal) => {
				if (code === 137 || signal === 'SIGKILL') {
					markKilled(file, args);
				}
			});
			return child;
		};
	}

	// A child SIGKILLed (flock passes it on as 137) was, in a build, almost
	// certainly the kernel's OOM killer. Gulp reports that only as a failed
	// task, so the file tells reh_in_container.sh what the failure was.
	function markKilled(file, args) {
		try {
			fs.appendFileSync(path.join(dir, 'killed'), [file, ...args].join(' ') + '\n');
		} catch {
			// the build's own error still stops it
		}
	}

	cp.spawn = gate(cp.spawn);
	cp.execFile = gate(cp.execFile);
	// `import * as cp from 'child_process'` and named imports read these.
	require('module').syncBuiltinESMExports();
}
