/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the shell. Two internal commands the engine's `:!`
// `:{range}!` `:r !` `:w !` (vimEngine.ts exShell) run, where the workspace
// is: on this machine for a local folder, on the remote machine or in the
// container for a remote one.
//
//   _devhubVim.shell { cmd, input?, from }
//       `:!{cmd}`, `:[range]w !{cmd}`: a terminal in the editor area (a tab
//       in the active group) running `$SHELL -c {cmd}` (no profile, no shell
//       integration) in the current directory, `input` on its stdin; when it
//       ends, "Press any key to close" (with Vim's "shell returned N"), and
//       the key closes it and puts the focus back on the editor. The
//       terminal's cwd is the workspace folder's URI, so a remote one runs on
//       the remote side (the terminal backend of that URI). Resolves once the
//       terminal is closed, so what comes after it in a macro waits, as Vim
//       waits for the key.
//   _devhubVim.filter { cmd, input?, from } -> { stdout, stderr, code, cancelled }
//       `:{range}!{cmd}`, `:r !{cmd}`: run by the built-in extension
//       devhub-vim-shell (extensions/devhub-vim-shell, extensionKind
//       "workspace": it runs where the workspace is), child_process with
//       stdin / stdout / stderr. While it runs, a notification (after half a
//       second) has Cancel, and CTRL-C in the editor (`devhubVim.shellRunning`)
//       cancels it too.
//
// `%` in the command is the current file (relative to the current directory
// when it is in it; `%:p` `%:h` `%:t` `%:r` `%:e`); `!` (the previous command)
// is the engine's. The current directory is `:e`'s (vimEdit.ts
// resolveFileBase): the workspace folder of the file.

import { localize } from '../../../../nls.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { ACTIVE_GROUP } from '../../../services/editor/common/editorService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { expandShellPercent } from '../common/vimEx.js';
import { resolveFileBase, VimFileCommands } from './vimEdit.js';

export const VIM_SHELL_COMMANDS = ['_devhubVim.shell', '_devhubVim.filter'] as const;

/** What a filter answers. */
export interface VimShellResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number | null;
	readonly cancelled: boolean;
}

/** The command `_devhubVim.cancelShell` (CTRL-C) cancels: one at a time, the last started. */
export const VIM_SHELL_RUNNING = new RawContextKey<boolean>('devhubVim.shellRunning', false, localize('devhubVim.shellRunning', "A Vim filter (:{range}!{cmd}, :r !{cmd}) is running; CTRL-C cancels it."));

let sequence = 0;
const running = new Map<string, () => void>();

/** Where a shell command runs: the cwd as a URI (for the terminal) and as a path on that machine (for the extension). */
export function shellCwd(cwd: URI): { readonly uri: URI; readonly path: string } {
	if (cwd.scheme !== Schemas.file && cwd.scheme !== Schemas.vscodeRemote) {
		throw new Error(localize('devhubVim.shell.noShell', "A shell command needs a local or remote folder, not one in {0}:", cwd.scheme));
	}
	return { uri: cwd, path: cwd.path };
}

/** The terminal's launch: `$SHELL -c cmd` (stdin from `stdin`, a file that is removed after), through /bin/sh to read $SHELL there. */
export function shellLaunch(cmd: string, stdin: string | undefined): { executable: string; args: string[] } {
	return stdin === undefined
		? { executable: '/bin/sh', args: ['-c', 'exec "${SHELL:-/bin/sh}" -c "$1"', 'devhub-vim', cmd] }
		: { executable: '/bin/sh', args: ['-c', '"${SHELL:-/bin/sh}" -c "$1" < "$2"; s=$?; rm -rf "$(dirname "$2")"; exit $s', 'devhub-vim', cmd, stdin] };
}

export class VimShellCommands {

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@ICommandService private readonly commandService: ICommandService,
		@IProgressService private readonly progressService: IProgressService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	/** The command with `%` expanded, and where it runs. */
	private async prepare(args: Record<string, unknown>): Promise<{ cmd: string; cwd: { uri: URI; path: string } }> {
		const current = this.instantiationService.createInstance(VimFileCommands).current(args.from);
		const base = await resolveFileBase(this.workspaceService, this.pathService, current);
		const expanded = expandShellPercent(typeof args.cmd === 'string' ? args.cmd : '', base.ctx);
		if ('error' in expanded) {
			throw new Error(expanded.error);
		}
		return { cmd: expanded.cmd, cwd: shellCwd(base.cwd) };
	}

	/** `:!{cmd}` / `:[range]w !{cmd}`: see the comment at the top. */
	async terminal(args: unknown): Promise<void> {
		const a = record(args);
		const { cmd, cwd } = await this.prepare(a);
		let stdin: string | undefined;
		if (Array.isArray(a.input)) {
			stdin = await this.commandService.executeCommand<string>('_devhubVim.shell.tempFile', { text: a.input.map(String).join('\n') + '\n' });
			if (typeof stdin !== 'string') {
				throw new Error(localize('devhubVim.shell.noExtension', "The shell extension (devhub-vim-shell) does not run here"));
			}
		}
		const group = this.editorGroupsService.activeGroup;
		const instance = await this.terminalService.createTerminal({
			location: { viewColumn: ACTIVE_GROUP },
			cwd: cwd.uri,
			config: {
				name: `!${cmd}`,
				...shellLaunch(cmd, stdin),
				isTransient: true,
				ignoreShellIntegration: true,
				waitOnExit: (code: number) => (code ? `\r\nshell returned ${code}\r\n` : '\r\n') + localize('devhubVim.shell.anyKey', "Press any key to close the terminal."),
			},
		});
		await new Promise<void>(resolve => {
			const done = instance.onDisposed(() => {
				done.dispose();
				// the key closed it: back to the editor the command came from
				this.editorGroupsService.getGroup(group.id)?.focus();
				resolve();
			});
		});
	}

	/** `:{range}!{cmd}` / `:r !{cmd}`: see the comment at the top. */
	async filter(args: unknown): Promise<VimShellResult> {
		const a = record(args);
		const { cmd, cwd } = await this.prepare(a);
		const id = `vim-shell-${++sequence}`;
		const key = VIM_SHELL_RUNNING.bindTo(this.contextKeyService);
		const cancel = () => void this.commandService.executeCommand('_devhubVim.shell.cancel', { id });
		running.set(id, cancel);
		key.set(true);
		try {
			const run = this.commandService.executeCommand<VimShellResult & { error?: string }>('_devhubVim.shell.run', { id, cmd, cwd: cwd.path, input: typeof a.input === 'string' ? a.input : '' });
			const result = await this.progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('devhubVim.shell.running', "Running !{0}", cmd),
				cancellable: localize('devhubVim.shell.cancel', "Cancel (CTRL-C)"),
				delay: 500,
			}, () => run, () => cancel());
			if (!result) {
				throw new Error(localize('devhubVim.shell.noExtension', "The shell extension (devhub-vim-shell) does not run here"));
			}
			if (result.error) {
				throw new Error(localize('devhubVim.shell.failed', "Cannot run the shell: {0}", result.error));
			}
			return { stdout: result.stdout, stderr: result.stderr, code: result.code, cancelled: result.cancelled };
		} finally {
			running.delete(id);
			key.set(running.size > 0);
		}
	}
}

function record(args: unknown): Record<string, unknown> {
	return typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
}

/** CTRL-C while a filter runs: cancel the last one started. */
export function cancelShell(): void {
	const last = [...running.values()].pop();
	last?.();
}

CommandsRegistry.registerCommand('_devhubVim.shell', (accessor, args: unknown) => accessor.get(IInstantiationService).createInstance(VimShellCommands).terminal(args));
CommandsRegistry.registerCommand('_devhubVim.filter', (accessor, args: unknown) => accessor.get(IInstantiationService).createInstance(VimShellCommands).filter(args));
KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'devhubVim.cancelShell',
	// CTRL-C, as in Vim (Control on macOS too: Cmd+C stays copy)
	primary: KeyMod.WinCtrl | KeyCode.KeyC,
	mac: { primary: KeyMod.WinCtrl | KeyCode.KeyC },
	when: ContextKeyExpr.and(ContextKeyExpr.equals('config.devhub.vim.enabled', true), VIM_SHELL_RUNNING),
	weight: KeybindingWeight.WorkbenchContrib + 60,
	handler: () => cancelShell(),
	metadata: { description: localize('devhubVim.cmd.cancelShell', "Vim: cancel the running filter (:{range}!{cmd}, :r !{cmd})") },
});
