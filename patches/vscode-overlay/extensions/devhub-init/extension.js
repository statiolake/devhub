/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

// DevHub's init.ts (see init.js): `<config dir>/init.ts`, the user's own file
// in DevHub's config directory (never a workspace's, so a folder cannot add
// code here, and it runs in an untrusted workspace as well), run in the local
// extension host (extensionKind "ui": on this Mac in a remote window too) at
// startup, and again when it changes (saved in the editor, or changed on disk:
// polled every second), with no window reload. A run that fails keeps the
// previous run's commands; errors go to a notification and the "DevHub
// init.ts" output channel, with the stack in init.ts's lines.
//
// The JavaScript of the last run is kept in globalState under the file's hash,
// so a start with an unchanged init.ts does not load TypeScript (which is
// VS Code's own copy, extensions/node_modules/typescript).
//
// For IntelliSense, `<config dir>/.types/` gets the API's types (vscode.d.ts)
// and devhub.d.ts on every start, and `<config dir>/tsconfig.json` is written
// when there is none (never overwritten).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const init = require('./init.js');

const CACHE_KEY = 'devhubInit.compiled';
const POLL_MS = 1000;
// VS Code's own (extensions/node_modules/typescript), loaded only to compile.
const TYPESCRIPT = 'typescript';

const TEMPLATE = `// DevHub init.ts: commands only (defineCommand). Saved = reloaded.
import * as vscode from "vscode";
import { defineCommand } from "devhub";

defineCommand("user.helloWorld", () => {
	vscode.window.showInformationMessage("Hello from init.ts");
}, { title: "Hello World" });
`;

const TSCONFIG = `{
	// Written by DevHub for init.ts's IntelliSense, only when there is no
	// tsconfig.json here; yours from then on.
	"compilerOptions": {
		"target": "ES2022",
		"lib": ["ES2022", "DOM"],
		"module": "commonjs",
		"strict": true,
		"noEmit": true,
		"skipLibCheck": true,
		"types": []
	},
	"files": ["init.ts", ".types/vscode.d.ts", ".types/devhub.d.ts"]
}
`;

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
	const configDir = init.configDirectory(process.env, os.homedir());
	const initPath = path.join(configDir, init.FILE_NAME);
	const version = String(context.extension?.packageJSON?.version ?? '');

	/** @type {vscode.OutputChannel | undefined} */
	let channel;
	const log = (/** @type {string} */ line) => {
		if (!channel) {
			channel = vscode.window.createOutputChannel('DevHub init.ts');
			context.subscriptions.push(channel);
		}
		channel.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
		return channel;
	};

	/**
	 * @param {string} what
	 * @param {unknown} e
	 * @param {(stack: string) => string} [mapStack]
	 */
	const report = (what, e, mapStack) => {
		const stack = e instanceof Error ? (e.stack ?? e.message) : String(e);
		log(`${what}:\n${mapStack ? mapStack(stack) : stack}`);
		void vscode.window.showErrorMessage(`init.ts: ${what}: ${init.errorText(e)}`, 'Show Output', 'Open init.ts').then(choice => {
			if (choice === 'Show Output') {
				channel?.show(true);
			} else if (choice === 'Open init.ts') {
				void vscode.commands.executeCommand('devhubInit.open');
			}
		});
	};

	/** @type {vscode.Disposable[]} */
	let registered = [];
	/** @type {import('./init.js').UserCommand[]} */
	let commands = [];
	/** @type {string | undefined} what the last run ran (undefined: no file) */
	let loadedText;
	let firstLoad = true;

	const unregister = () => {
		for (const d of registered) {
			d.dispose();
		}
		registered = [];
		commands = [];
	};
	context.subscriptions.push({ dispose: unregister });

	/** @param {string} text */
	const compile = (text) => {
		const hash = crypto.createHash('sha256').update(`${version}\0${initPath}\0${text}`).digest('hex');
		const cached = context.globalState.get(CACHE_KEY);
		if (cached && typeof cached === 'object' && /** @type {any} */ (cached).hash === hash) {
			return { code: String(/** @type {any} */(cached).code), map: String(/** @type {any} */(cached).map) };
		}
		const compiled = init.transpile(require(TYPESCRIPT), text, initPath);
		void context.globalState.update(CACHE_KEY, { hash, ...compiled });
		return compiled;
	};

	/** @param {boolean} force */
	const load = async (force) => {
		/** @type {string | undefined} */
		let text;
		try {
			text = await fs.promises.readFile(initPath, 'utf8');
		} catch (e) {
			if (/** @type {any} */ (e)?.code !== 'ENOENT') {
				report('cannot read it', e);
				return;
			}
		}
		if (!force && !firstLoad && text === loadedText) {
			return;
		}
		const quiet = firstLoad;
		firstLoad = false;
		loadedText = text;
		if (text === undefined) {
			if (registered.length) {
				log(`${initPath} is gone: its commands are too`);
			}
			unregister();
			return;
		}
		/** @type {ReturnType<typeof init.runInit>} */
		let result;
		try {
			result = init.runInit(compile(text), initPath, vscode);
		} catch (e) {
			report(commands.length ? `not loaded (the previous run's ${commands.length} command(s) stay)` : 'not loaded', e);
			return;
		}
		unregister();
		const { mapStack } = result;
		for (const c of result.commands) {
			try {
				registered.push(vscode.commands.registerCommand(c.id, async (...args) => {
					try {
						return await c.handler(...args);
					} catch (e) {
						report(`${c.id} failed`, e, mapStack);
						throw e;
					}
				}));
				commands.push(c);
			} catch (e) {
				report(`${c.id} not registered`, e);
			}
		}
		log(`loaded ${initPath}: ${commands.length ? commands.map(c => c.id).join(', ') : 'no commands'}`);
		if (!quiet) {
			vscode.window.setStatusBarMessage(`init.ts: ${commands.length} command(s)`, 3000);
		}
		void ensureTypes().catch(e => log(`types not written: ${init.errorText(e)}`));
	};

	// One load at a time, in order.
	let queue = Promise.resolve();
	const reload = (/** @type {boolean} */ force) => (queue = queue.then(() => load(force)));

	const ensureTypes = async () => {
		const typesDir = path.join(configDir, '.types');
		await fs.promises.mkdir(typesDir, { recursive: true });
		const shipped = path.join(__dirname, 'types', 'vscode.d.ts');
		const vscodeDts = fs.existsSync(shipped) ? shipped : path.join(vscode.env.appRoot, 'src', 'vscode-dts', 'vscode.d.ts');
		for (const [from, name] of [[vscodeDts, 'vscode.d.ts'], [path.join(__dirname, 'types', 'devhub.d.ts'), 'devhub.d.ts']]) {
			const want = await fs.promises.readFile(from, 'utf8').catch(() => undefined);
			if (want === undefined) {
				log(`types: no ${from}`);
				continue;
			}
			const to = path.join(typesDir, name);
			const have = await fs.promises.readFile(to, 'utf8').catch(() => undefined);
			if (have !== want) {
				await fs.promises.writeFile(to, want);
			}
		}
		await fs.promises.writeFile(path.join(configDir, 'tsconfig.json'), TSCONFIG, { flag: 'wx' }).catch(e => {
			if (e?.code !== 'EEXIST') {
				throw e;
			}
		});
	};

	/** @type {(curr: fs.Stats, prev: fs.Stats) => void} */
	const onPoll = (curr, prev) => {
		if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
			void reload(false);
		}
	};
	fs.watchFile(initPath, { interval: POLL_MS, persistent: false }, onPoll);
	context.subscriptions.push(
		{ dispose: () => fs.unwatchFile(initPath, onPoll) },
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (doc.uri.scheme === 'file' && doc.uri.fsPath === initPath) {
				void reload(false);
			}
		}),
		vscode.commands.registerCommand('devhubInit.reload', () => reload(true)),
		vscode.commands.registerCommand('devhubInit.open', async () => {
			await fs.promises.mkdir(configDir, { recursive: true });
			await fs.promises.writeFile(initPath, TEMPLATE, { flag: 'wx' }).catch(e => {
				if (e?.code !== 'EEXIST') {
					throw e;
				}
			});
			await ensureTypes().catch(e => log(`types not written: ${init.errorText(e)}`));
			await vscode.window.showTextDocument(vscode.Uri.file(initPath));
		}),
		vscode.commands.registerCommand('devhubInit.runCommand', async () => {
			if (!commands.length) {
				const choice = await vscode.window.showInformationMessage(`${initPath} defines no commands.`, 'Open init.ts');
				if (choice) {
					await vscode.commands.executeCommand('devhubInit.open');
				}
				return;
			}
			const pick = await vscode.window.showQuickPick(
				commands.map(c => ({ label: c.title ?? c.id, description: c.title ? c.id : undefined, id: c.id })),
				{ placeHolder: 'init.ts command to run' },
			);
			if (pick) {
				await vscode.commands.executeCommand(pick.id);
			}
		}),
	);

	await reload(false);
}

function deactivate() { }

module.exports = { activate, deactivate };
