/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

// `_devhubVim.js.run` for DevHub Vim's `:js` / `:jsdo` (see run.js). Internal
// (no contribution, no palette entry), in the local extension host
// (extensionKind "ui"), and never in an untrusted workspace
// (capabilities.untrustedWorkspaces.supported: false; the workbench checks
// Workspace Trust before it calls this, too). A multi-line `:js =` value goes
// to the "Vim :js" output channel.

const vscode = require('vscode');
const { runJs } = require('./run.js');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	/** @type {vscode.OutputChannel | undefined} */
	let channel;
	context.subscriptions.push(
		vscode.commands.registerCommand('_devhubVim.js.run', async (/** @type {any} */ args) => {
			const kind = args?.kind === 'eval' || args?.kind === 'do' ? args.kind : 'exec';
			const result = await runJs(vscode, { ...args, kind, code: String(args?.code ?? '') });
			if (result.value !== undefined && result.value.includes('\n')) {
				if (!channel) {
					channel = vscode.window.createOutputChannel('Vim :js');
					context.subscriptions.push(channel);
				}
				channel.appendLine(`:js =${args.code}`);
				channel.appendLine(result.value);
				channel.show(true);
				return { ...result, output: true };
			}
			return result;
		}),
	);
}

function deactivate() { }

module.exports = { activate, deactivate };
