/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: `:!` and the filters run where the workspace is
// (browser/vimShell.ts): a terminal in the editor area whose cwd is the
// workspace folder's URI (a remote one runs on the remote side), and
// devhub-vim-shell (a workspace extension) given that folder's path there.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { VimShellCommands, cancelShell, shellCwd, shellLaunch } from '../../browser/vimShell.js';

const REMOTE = URI.parse('vscode-remote://ssh-remote+box/home/dev/proj');
const FILE = URI.joinPath(REMOTE, 'src/main.ts').toString();

function setup(answers: Record<string, (args: Record<string, unknown>) => unknown> = {}, folder = REMOTE) {
	const created: ICreateTerminalOptions[] = [];
	const ran: [string, Record<string, unknown>][] = [];
	const focused: number[] = [];
	const disposed = new Emitter<ITerminalInstance>();
	let cancelProgress: (() => void) | undefined;
	const instantiation = new class extends mock<IInstantiationService>() {
		override createInstance(ctor: unknown) {
			// VimFileCommands: only `current(from)` is used
			return { current: (from: unknown) => typeof from === 'string' ? URI.parse(from) : undefined } as never;
		}
	};
	const commands = new VimShellCommands(
		new class extends mock<ITerminalService>() {
			override async createTerminal(options: ICreateTerminalOptions) {
				created.push(options);
				return { onDisposed: disposed.event } as unknown as ITerminalInstance;
			}
		},
		new class extends mock<IEditorGroupsService>() {
			override get activeGroup() { return { id: 7 } as IEditorGroup; }
			override getGroup(id: number) { return { focus: () => focused.push(id) } as unknown as IEditorGroup; }
		},
		new class extends mock<IWorkspaceContextService>() {
			override getWorkspace(): IWorkspace { return { id: 'w', folders: [{ uri: folder, name: 'proj', index: 0 } as unknown as IWorkspaceFolder] } as unknown as IWorkspace; }
			override getWorkspaceFolder() { return { uri: folder, name: 'proj', index: 0 } as unknown as IWorkspaceFolder; }
		},
		new class extends mock<IPathService>() { override userHome = (async () => URI.parse('vscode-remote://ssh-remote+box/home/dev')) as unknown as IPathService['userHome']; },
		new class extends mock<ICommandService>() {
			override async executeCommand(id: string, args: Record<string, unknown>) {
				ran.push([id, args]);
				return answers[id]?.(args) as never;
			}
		},
		new class extends mock<IProgressService>() {
			override withProgress = ((_options: unknown, task: () => Promise<unknown>, onDidCancel?: () => void) => {
				cancelProgress = onDidCancel;
				return task();
			}) as unknown as IProgressService['withProgress'];
		},
		new MockContextKeyService() as unknown as IContextKeyService,
		instantiation,
	);
	return { commands, created, ran, focused, disposed, cancel: () => cancelProgress?.() };
}

suite('DevHub Vim: :! and filters run where the workspace is', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test(':!cmd: a terminal tab in the active group, $SHELL -c in the workspace folder (its remote URI), % expanded; the focus comes back', async () => {
		const t = setup();
		const done = t.commands.terminal({ cmd: 'wc -l % %:p', from: FILE });
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(t.created.length, 1);
		const o = t.created[0];
		const config = o.config as IShellLaunchConfig;
		assert.deepStrictEqual(o.location, { viewColumn: -1 });
		assert.strictEqual((o.cwd as URI).toString(), REMOTE.toString());
		assert.strictEqual(config.executable, '/bin/sh');
		assert.deepStrictEqual(config.args, ['-c', 'exec "${SHELL:-/bin/sh}" -c "$1"', 'devhub-vim', 'wc -l src/main.ts /home/dev/proj/src/main.ts']);
		assert.strictEqual(config.name, '!wc -l src/main.ts /home/dev/proj/src/main.ts');
		assert.strictEqual(config.isTransient, true);
		assert.ok(typeof config.waitOnExit === 'function' && config.waitOnExit(2).includes('shell returned 2') && !config.waitOnExit(0).includes('returned'));
		// it resolves when the terminal is closed (any key), and the editor's group gets the focus back
		let resolved = false;
		void done.then(() => resolved = true);
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(resolved, false);
		t.disposed.fire(undefined!);
		await done;
		assert.deepStrictEqual(t.focused, [7]);
		t.disposed.dispose();
	});

	test(':w !cmd: the lines in a temp file the shell extension makes on the workspace side, read as stdin and removed', async () => {
		const t = setup({ '_devhubVim.shell.tempFile': () => '/tmp/devhub-vim-x/stdin' });
		const done = t.commands.terminal({ cmd: 'wc -l', input: ['a', 'b'], from: FILE });
		await new Promise(r => setTimeout(r, 0));
		assert.deepStrictEqual(t.ran, [['_devhubVim.shell.tempFile', { text: 'a\nb\n' }]]);
		assert.deepStrictEqual((t.created[0].config as IShellLaunchConfig).args, shellLaunch('wc -l', '/tmp/devhub-vim-x/stdin').args);
		assert.ok((shellLaunch('x', '/t/stdin').args[1] as string).includes('< "$2"'));
		t.disposed.fire(undefined!);
		await done;
		t.disposed.dispose();
	});

	test(':{range}!cmd: the extension gets the folder\'s path on the remote side and the input; Cancel and CTRL-C stop it', async () => {
		let finish: (r: unknown) => void = () => { };
		const t = setup({
			'_devhubVim.shell.run': () => new Promise(r => finish = r),
		});
		const p = t.commands.filter({ cmd: 'sort %:t', input: 'b\na\n', from: FILE });
		await new Promise(r => setTimeout(r, 0));
		const [id, args] = t.ran[0];
		assert.strictEqual(id, '_devhubVim.shell.run');
		assert.deepStrictEqual({ ...args, id: undefined }, { id: undefined, cmd: 'sort main.ts', cwd: '/home/dev/proj', input: 'b\na\n' });
		// the notification's Cancel, then CTRL-C (the last one started)
		t.cancel();
		cancelShell();
		assert.deepStrictEqual(t.ran.slice(1).map(([c, a]) => [c, a.id]), [['_devhubVim.shell.cancel', args.id], ['_devhubVim.shell.cancel', args.id]]);
		finish({ stdout: '', stderr: '', code: null, signal: 'SIGTERM', cancelled: true });
		assert.deepStrictEqual(await p, { stdout: '', stderr: '', code: null, cancelled: true });
	});

	test('no shell extension, or a workspace with no shell: a message, not a hang', async () => {
		const t = setup();
		await assert.rejects(t.commands.filter({ cmd: 'ls', from: FILE }), /devhub-vim-shell/);
		assert.throws(() => shellCwd(URI.parse('vscode-vfs://github/x/y')), /local or remote folder/);
		assert.deepStrictEqual(shellCwd(URI.file('/Users/me/proj')).path, '/Users/me/proj');
		const virtual = setup({}, URI.parse('vscode-vfs://github/x/y'));
		await assert.rejects(virtual.commands.terminal({ cmd: 'ls', from: 'vscode-vfs://github/x/y/a.ts' }), /local or remote folder/);
	});
});
