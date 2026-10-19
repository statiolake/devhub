/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// node --test extensions/devhub-init/test/*.test.js
//
// Needs TypeScript: VS Code's (extensions/node_modules/typescript, in the
// vscode checkout) or DevHub's own (node_modules/.pnpm/typescript@*, run from
// patches/vscode-overlay/ in a checkout with node_modules), or the one
// DEVHUB_TEST_TYPESCRIPT names; skipped without any.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { test } = require('node:test');
const init = require('../init.js');

function findTypeScript() {
	const here = path.join(__dirname, '..');
	const candidates = [process.env['DEVHUB_TEST_TYPESCRIPT'] ?? '', path.join(here, '..', 'node_modules', 'typescript')].filter(Boolean);
	for (let dir = here; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
		const pnpm = path.join(dir, 'node_modules', '.pnpm');
		if (fs.existsSync(pnpm)) {
			for (const name of fs.readdirSync(pnpm).filter(n => n.startsWith('typescript@')).sort().reverse()) {
				candidates.push(path.join(pnpm, name, 'node_modules', 'typescript'));
			}
		}
	}
	return candidates.find(c => fs.existsSync(path.join(c, 'package.json')));
}
const tsPath = findTypeScript();
const skip = tsPath ? false : 'no TypeScript to transpile with';
const ts = tsPath ? require(tsPath) : undefined;

test('the config directory is the profile\'s, as model/profile.ts says', () => {
	assert.strictEqual(init.configDirectory({}, '/h'), '/h/.config/devhub');
	assert.strictEqual(init.configDirectory({ DEVHUB_PROFILE: 'default' }, '/h'), '/h/.config/devhub');
	assert.strictEqual(init.configDirectory({ DEVHUB_PROFILE: 'dev' }, '/h'), '/h/.config/devhub-dev');
	assert.strictEqual(init.configDirectory({ DEVHUB_PROFILE: 'dev', XDG_CONFIG_HOME: '/x' }, '/h'), '/x/devhub-dev');
	assert.strictEqual(init.configDirectory({ XDG_CONFIG_HOME: 'relative' }, '/h'), '/h/.config/devhub');
	assert.strictEqual(init.configDirectory({ DEVHUB_CONFIG_DIR: '/c/devhub-x', DEVHUB_PROFILE: 'dev' }, '/h'), '/c/devhub-x');
});

test('transpile + run: vscode and devhub to import, defineCommand collects, nothing else is in the way', { skip }, () => {
	const file = '/cfg/init.ts';
	const fakeVscode = { version: 'fake' };
	const src = [
		'import * as vscode from "vscode";',
		'import { defineCommand } from "devhub";',
		'interface Foo { a: number }',
		'const n: Foo = { a: 1 };',
		'defineCommand("user.one", (x: number) => x + n.a + vscode.version.length, { title: "One" });',
		'defineCommand("user.two.Sub-x_1", () => "two");',
		'export const unused = 1;',
	].join('\n');
	const { commands } = init.runInit(init.transpile(ts, src, file), file, fakeVscode);
	assert.deepStrictEqual(commands.map(c => [c.id, c.title]), [['user.one', 'One'], ['user.two.Sub-x_1', undefined]]);
	assert.strictEqual(commands[0].handler(1), 6);
	assert.strictEqual(commands[1].handler(), 'two');
	// Node's require from the config directory
	const { commands: c2 } = init.runInit(init.transpile(ts, 'import { defineCommand } from "devhub"; import * as p from "path"; defineCommand("user.p", () => p.join(__dirname, "x"));', file), file, fakeVscode);
	assert.strictEqual(c2[0].handler(), '/cfg/x');
});

test('defineCommand: user.<name> only, once each, only while init.ts runs', { skip }, () => {
	const file = '/cfg/init.ts';
	const run = (/** @type {string} */ src) => init.runInit(init.transpile(ts, `import { defineCommand } from "devhub";\n${src}`, file), file, {});
	assert.throws(() => run('defineCommand("editor.action.x", () => 1);'), /"editor\.action\.x" is not a user command id/);
	assert.throws(() => run('defineCommand("user.", () => 1);'), /not a user command id/);
	assert.throws(() => run('defineCommand("user.a", 1 as any);'), /not a function/);
	assert.throws(() => run('defineCommand("user.a", () => 1); defineCommand("user.a", () => 2);'), /user\.a is defined twice/);
	const { commands } = run('defineCommand("user.late", () => defineCommand("user.later", () => 1));');
	assert.throws(() => commands[0].handler(), /while init\.ts runs/);
});

test('errors name init.ts\'s own lines: syntax, a throw while it runs, a throw in a command', { skip }, () => {
	const file = '/cfg/init.ts';
	assert.throws(() => init.transpile(ts, 'const a: number = ;\n', file), (/** @type {Error} */ e) => {
		assert.match(e.message, /^\/cfg\/init\.ts:1:19: Expression expected\./);
		return true;
	});
	// types are erased, so the generated lines are not init.ts's
	const src = [
		'import { defineCommand } from "devhub";',
		'type A = { a: string };',
		'interface B {',
		'  b: number;',
		'}',
		'defineCommand("user.boom", () => {',
		'  const x: A = { a: "" };',
		'  throw new Error("boom" + x.a);',
		'});',
		'if ((globalThis as any).__devhubInitThrow) { throw new TypeError("at load"); }',
	].join('\n');
	const compiled = init.transpile(ts, src, file);
	const { commands, mapStack } = init.runInit(compiled, file, {});
	let stack = '';
	try {
		commands[0].handler();
	} catch (e) {
		stack = mapStack(/** @type {Error} */(e).stack ?? '');
	}
	assert.match(stack, /\/cfg\/init\.ts:8:9\b/);
	/** @type {any} */ (globalThis).__devhubInitThrow = true;
	try {
		assert.throws(() => init.runInit(compiled, file, {}), (/** @type {Error} */ e) => {
			assert.ok(e instanceof TypeError);
			assert.match(e.stack ?? '', /\/cfg\/init\.ts:10:52\b/);
			return true;
		});
	} finally {
		delete (/** @type {any} */ (globalThis).__devhubInitThrow);
	}
});

test('a source map\'s mappings decode', () => {
	// line 0: [0,0,0] then +4 cols / +0 / +4; line 1 empty; line 2: [2, 1, 0]
	const map = JSON.stringify({ mappings: 'AAAA,IAAI;;EACJ' });
	assert.deepStrictEqual(init.decodeMappings(map), [[[0, 0, 0], [4, 0, 4]], [], [[2, 1, 0]]]);
	const decoded = init.decodeMappings(map);
	assert.deepStrictEqual(init.originalPosition(decoded, 1, 6), { line: 1, column: 5 });
	assert.deepStrictEqual(init.originalPosition(decoded, 3, 1), { line: 2, column: 1 });
	assert.strictEqual(init.originalPosition(decoded, 2, 1), undefined);
});

// The extension against a fake `vscode`: the file's commands are registered,
// a changed file replaces them, a failing one keeps them and says why.
test('extension: load, reload replaces, errors reported and the previous commands kept', { skip }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-init-'));
	const initPath = path.join(dir, 'init.ts');
	/** @type {Map<string, Function>} */
	const registry = new Map();
	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const output = [];
	/** @type {Function[]} */
	const saveListeners = [];
	const disposable = (/** @type {() => void} */ f) => ({ dispose: f });
	const fakeVscode = {
		version: '1.0',
		env: { appRoot: path.join(__dirname, 'no-app-root') },
		Uri: { file: (/** @type {string} */ p) => ({ fsPath: p, scheme: 'file' }) },
		commands: {
			registerCommand(/** @type {string} */ id, /** @type {Function} */ f) {
				if (registry.has(id)) {
					throw new Error(`command '${id}' already exists`);
				}
				registry.set(id, f);
				return disposable(() => registry.delete(id));
			},
			async executeCommand(/** @type {string} */ id, /** @type {any[]} */ ...args) {
				const f = registry.get(id);
				if (!f) {
					throw new Error(`command '${id}' not found`);
				}
				return f(...args);
			},
		},
		window: {
			createOutputChannel: () => ({ appendLine: (/** @type {string} */ l) => output.push(l), show() { }, dispose() { } }),
			showErrorMessage: (/** @type {string} */ m) => { errors.push(m); return Promise.resolve(undefined); },
			showInformationMessage: () => Promise.resolve(undefined),
			setStatusBarMessage: () => disposable(() => { }),
		},
		workspace: {
			onDidSaveTextDocument: (/** @type {Function} */ f) => { saveListeners.push(f); return disposable(() => { }); },
		},
	};
	const resolve = /** @type {any} */ (Module)._resolveFilename;
	/** @type {any} */ (Module)._resolveFilename = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
		if (request === 'vscode') {
			return 'vscode';
		}
		if (request === 'typescript') {
			return resolve.call(this, tsPath, ...rest);
		}
		return resolve.call(this, request, ...rest);
	};
	require.cache['vscode'] = /** @type {any} */ ({ id: 'vscode', filename: 'vscode', loaded: true, exports: fakeVscode });
	const previousDir = process.env['DEVHUB_CONFIG_DIR'];
	process.env['DEVHUB_CONFIG_DIR'] = dir;
	/** @type {Map<string, unknown>} */
	const state = new Map();
	const context = {
		subscriptions: /** @type {{ dispose(): void }[]} */ ([]),
		globalState: { get: (/** @type {string} */ k) => state.get(k), update: async (/** @type {string} */ k, /** @type {unknown} */ v) => { state.set(k, v); } },
		extension: { packageJSON: { version: '1.0.0' } },
	};
	try {
		const extension = require('../extension.js');
		const save = async () => {
			for (const f of saveListeners) {
				f({ uri: { scheme: 'file', fsPath: initPath } });
			}
			// the reload the save started, then nothing (the text is the same)
			await new Promise(r => setTimeout(r, 200));
		};
		fs.writeFileSync(initPath, [
			'import * as vscode from "vscode";',
			'import { defineCommand } from "devhub";',
			'defineCommand("user.a", (n: number) => `a${n}${vscode.version}`);',
			'defineCommand("user.b", () => "b");',
		].join('\n'));
		await extension.activate(/** @type {any} */ (context));
		assert.strictEqual(await fakeVscode.commands.executeCommand('user.a', 1), 'a11.0');
		assert.strictEqual(await fakeVscode.commands.executeCommand('user.b'), 'b');
		assert.deepStrictEqual(errors, []);
		assert.ok(output.some(l => l.includes('loaded') && l.includes('user.a, user.b')));
		// IntelliSense files: devhub.d.ts, and a tsconfig.json only when missing
		await new Promise(r => setTimeout(r, 100));
		assert.match(fs.readFileSync(path.join(dir, '.types', 'devhub.d.ts'), 'utf8'), /declare module 'devhub'/);
		assert.match(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf8'), /"init\.ts"/);

		// changed: user.b is gone, user.c is there, user.a is the new one
		fs.writeFileSync(initPath, 'import { defineCommand } from "devhub";\ndefineCommand("user.a", () => "new a");\ndefineCommand("user.c", () => {\n  throw new Error("c failed");\n});\n');
		await save();
		assert.strictEqual(await fakeVscode.commands.executeCommand('user.a'), 'new a');
		assert.ok(!registry.has('user.b'));
		await assert.rejects(fakeVscode.commands.executeCommand('user.c'), /c failed/);
		assert.match(errors.pop() ?? '', /^init\.ts: user\.c failed: c failed$/);
		assert.ok(output.some(l => /user\.c failed:[\s\S]*init\.ts:4:9/.test(l)), output.join('\n'));

		// broken: reported, the previous commands stay
		fs.writeFileSync(initPath, 'import { defineCommand } from "devhub";\ndefineCommand("user.a", () => "newer a")\nconst = 1;\n');
		await save();
		assert.match(errors.pop() ?? '', /^init\.ts: not loaded \(the previous run's 2 command\(s\) stay\): .*init\.ts:3:/);
		assert.strictEqual(await fakeVscode.commands.executeCommand('user.a'), 'new a');
		// DevHub: Reload init.ts runs it again, unchanged or not
		await fakeVscode.commands.executeCommand('devhubInit.reload');
		assert.match(errors.pop() ?? '', /^init\.ts: not loaded/);
		assert.deepStrictEqual(errors, []);
		fs.writeFileSync(initPath, 'import { defineCommand } from "devhub";\ndefineCommand("other.x", () => 1);\n');
		await save();
		assert.match(errors.pop() ?? '', /"other\.x" is not a user command id/);
		assert.ok(registry.has('user.c'));

		// a clash with somebody else's command is reported; the others load
		registry.set('user.taken', () => 'theirs');
		fs.writeFileSync(initPath, 'import { defineCommand } from "devhub";\ndefineCommand("user.taken", () => 1);\ndefineCommand("user.ok", () => "ok");\n');
		await save();
		assert.match(errors.pop() ?? '', /user\.taken not registered: command 'user\.taken' already exists/);
		assert.strictEqual(await fakeVscode.commands.executeCommand('user.ok'), 'ok');
		assert.ok(!registry.has('user.a'));

		// gone: so are its commands
		fs.rmSync(initPath);
		await save();
		assert.ok(!registry.has('user.ok'));

		// a second start with the same file uses the kept JavaScript
		fs.writeFileSync(initPath, 'import { defineCommand } from "devhub";\ndefineCommand("user.cached", () => 1);\n');
		await save();
		const cached = /** @type {any} */ (state.get('devhubInit.compiled'));
		assert.match(cached.code, /user\.cached/);
		assert.deepStrictEqual(errors, []);
	} finally {
		for (const d of context.subscriptions) {
			d.dispose();
		}
		/** @type {any} */ (Module)._resolveFilename = resolve;
		delete require.cache['vscode'];
		if (previousDir === undefined) {
			delete process.env['DEVHUB_CONFIG_DIR'];
		} else {
			process.env['DEVHUB_CONFIG_DIR'] = previousDir;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
