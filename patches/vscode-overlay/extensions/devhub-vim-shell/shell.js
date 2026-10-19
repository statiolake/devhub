/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

// DevHub Vim's filters (`:{range}!{cmd}`) and `:r !{cmd}`: the command run by
// the user's shell (`$SHELL -c`, /bin/sh without one), in the workspace
// folder, with `input` on stdin, stdout and stderr collected. This extension
// runs where the workspace is (extensionKind "workspace"): on this machine
// for a local folder, on the remote machine or in the container for a remote
// one, so the command sees the same files the editor shows.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * @typedef {{ stdout: string; stderr: string; code: number | null; signal: string | null; cancelled: boolean; error?: string }} ShellResult
 */

/**
 * Run `cmd`. `onCancel` is handed a function that stops it, and every
 * process it started (SIGTERM to its process group, then SIGKILL a second
 * later); the result then says `cancelled`.
 * @param {{ cmd: string; cwd?: string; input?: string; shell?: string; env?: NodeJS.ProcessEnv }} options
 * @param {(cancel: () => void) => void} [onCancel]
 * @returns {Promise<ShellResult>}
 */
function runShell(options, onCancel) {
	return new Promise(resolve => {
		const shell = options.shell || process.env.SHELL || '/bin/sh';
		let cwd = options.cwd;
		if (cwd && !fs.existsSync(cwd)) {
			cwd = undefined;
		}
		/** @type {Buffer[]} */
		const out = [];
		/** @type {Buffer[]} */
		const err = [];
		let cancelled = false;
		let settled = false;
		/** @param {ShellResult} r */
		const done = r => {
			if (!settled) {
				settled = true;
				resolve(r);
			}
		};
		let child;
		try {
			// a process group of its own, so that cancelling stops the whole pipeline, not just the shell
			child = spawn(shell, ['-c', options.cmd], { cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
		} catch (e) {
			done({ stdout: '', stderr: '', code: null, signal: null, cancelled: false, error: e instanceof Error ? e.message : String(e) });
			return;
		}
		const proc = child;
		proc.stdout.on('data', d => out.push(d));
		proc.stderr.on('data', d => err.push(d));
		proc.on('error', e => done({ stdout: '', stderr: Buffer.concat(err).toString('utf8'), code: null, signal: null, cancelled, error: e.message }));
		proc.on('close', (code, signal) => done({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code, signal, cancelled }));
		// a command that does not read its input (or stops early) is no error
		proc.stdin.on('error', () => { });
		proc.stdin.end(options.input ?? '');
		onCancel?.(() => {
			if (settled) {
				return;
			}
			cancelled = true;
			/** @param {NodeJS.Signals} signal */
			const kill = signal => {
				try {
					process.kill(-(/** @type {number} */ (proc.pid)), signal);
				} catch {
					proc.kill(signal);
				}
			};
			kill('SIGTERM');
			setTimeout(() => {
				if (!settled) {
					kill('SIGKILL');
				}
			}, 1000).unref();
		});
	});
}

/**
 * `:w !{cmd}` in a terminal: the lines in a file of their own where the
 * shell runs (the terminal reads it as stdin and removes it).
 * @param {string} text
 * @returns {string}
 */
function writeTempFile(text) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-vim-'));
	const file = path.join(dir, 'stdin');
	fs.writeFileSync(file, text, { mode: 0o600 });
	return file;
}

module.exports = { runShell, writeTempFile };
