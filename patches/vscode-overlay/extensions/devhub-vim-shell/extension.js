/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

// The commands DevHub Vim's workbench calls (contrib/devhubVim/browser/vimShell.ts):
//
//   _devhubVim.shell.run { id, cmd, cwd?, input? }  -> { stdout, stderr, code, signal, cancelled, error? }
//   _devhubVim.shell.cancel { id }                  stops that run
//   _devhubVim.shell.tempFile { text }              -> the path of a file holding text
//
// They are internal (no contribution, no palette entry), and plain
// JavaScript: nothing to compile, so the extension is the same in the app
// and in the remote server.

const vscode = require('vscode');
const { runShell, writeTempFile } = require('./shell.js');

/** @type {Map<string, () => void>} */
const running = new Map();

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('_devhubVim.shell.run', async (/** @type {any} */ args) => {
			const id = String(args?.id ?? '');
			try {
				return await runShell({ cmd: String(args?.cmd ?? ''), cwd: typeof args?.cwd === 'string' ? args.cwd : undefined, input: typeof args?.input === 'string' ? args.input : undefined }, cancel => {
					if (id) {
						running.set(id, cancel);
					}
				});
			} finally {
				running.delete(id);
			}
		}),
		vscode.commands.registerCommand('_devhubVim.shell.cancel', (/** @type {any} */ args) => {
			running.get(String(args?.id ?? ''))?.();
		}),
		vscode.commands.registerCommand('_devhubVim.shell.tempFile', (/** @type {any} */ args) => writeTempFile(String(args?.text ?? ''))),
		{ dispose: () => { for (const cancel of running.values()) { cancel(); } running.clear(); } },
	);
}

function deactivate() { }

module.exports = { activate, deactivate };
