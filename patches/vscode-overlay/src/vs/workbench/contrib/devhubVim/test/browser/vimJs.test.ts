/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: `:js` / `:jsdo` run in the local extension host, and never in an
// untrusted workspace (browser/vimJs.ts).

import assert from 'assert';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { UNTRUSTED_MESSAGE, VimJsCommands } from '../../browser/vimJs.js';

suite('DevHub Vim: :js and :jsdo', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const make = (trusted: boolean, answer: unknown = { registers: {} }) => {
		const ran: unknown[][] = [];
		const commands = new VimJsCommands(
			new class extends mock<IWorkspaceTrustManagementService>() { override isWorkspaceTrusted() { return trusted; } },
			new class extends mock<ICommandService>() { override async executeCommand(...args: unknown[]) { ran.push(args); return answer as never; } },
		);
		return { commands, ran };
	};

	test('an untrusted workspace runs no JavaScript: E12, and the extension is not asked', async () => {
		const t = make(false);
		await assert.rejects(t.commands.run({ kind: 'exec', code: 'require("child_process")', from: 'file:///w/a.ts' }), new RegExp(UNTRUSTED_MESSAGE.replace(/[()]/g, '\\$&')));
		assert.deepStrictEqual(t.ran, []);
	});

	test('a trusted one hands the code, the file, the mode, the registers and the lines to devhub-vim-js', async () => {
		const t = make(true, { lines: ['X'], registers: {} });
		const r = await t.commands.run({ kind: 'do', code: 'return "X"', from: 'vscode-remote://ssh-remote+box/w/a.ts', mode: 'normal', registers: { a: { text: 'x', type: 'char' } }, lines: ['a'], firstLine: 3 });
		assert.deepStrictEqual(r, { lines: ['X'], registers: {} });
		assert.deepStrictEqual(t.ran, [['_devhubVim.js.run', { kind: 'do', code: 'return "X"', uri: 'vscode-remote://ssh-remote+box/w/a.ts', mode: 'normal', registers: { a: { text: 'x', type: 'char' } }, lines: ['a'], firstLine: 3 }]]);
		await assert.rejects(make(true, null).commands.run({ kind: 'exec', code: '1' }), /devhub-vim-js/);
	});
});
