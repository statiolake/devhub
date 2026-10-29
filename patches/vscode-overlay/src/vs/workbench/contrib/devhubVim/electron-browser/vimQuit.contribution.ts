/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: Vim quitting is DevHub closing the Workspace.
//
// `:qa` `:wqa` `:xa`, and `:q` `:wq` `:x` `ZZ` `CTRL-W q` in the last window
// of the last tab page (browser/vimTabPages.ts quitWindow), leave the
// workbench as Vim leaves the editor, in Neovim's order:
//
// 1. Scratch is never closed; there, and where there is no DevHub to ask, it
//    is Vim's E444 ("Cannot close last window"), and nothing is discarded
//    (main is asked first, `probe`).
// 2. `:qa!` (`{ discard: 'all' }`) drops every unsaved change of the
//    workbench; `:q!` (`{ discard: 'active' }`) those of the current editor
//    (Vim's `:q!` abandons the current buffer).
// 3. A modified buffer left stops the quit, as Neovim's check_changed_any
//    does: E37 / E162 naming it, and it is made current in its window
//    (browser/vimBuffers.ts refuseQuit) — for `:q!` only one no window
//    shows (a hidden buffer). DevHub's close sheet never asks about it.
// 4. Otherwise DevHub's main process runs the Workspace's close button
//    (apps/desktop/src/main/shell/workbenchCloseRequests.ts, then
//    AppController.closeWorkspaceOrWorktree), the one close path: it may still
//    ask on its sheet about what is not an editor's (a busy Agent, a dirty
//    worktree), and cancelling it leaves everything as it was. The same as
//    terminal mode's shell `exit` in the editor area.

import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { CLOSE_WORKSPACE_COMMAND, E444 } from '../common/vimEx.js';
import { VimBuffers } from '../browser/vimBuffers.js';

/** main's half: apps/desktop/src/main/shell/workbenchCloseRequests.ts (the same name). */
const CLOSE_WORKSPACE_REQUEST = 'vscode:devhubCloseWorkspace';

/** What main answers: `closable` to a probe, `closing` once the close is asked for, else why not. */
type CloseAnswer = 'closable' | 'closing' | 'scratch' | 'unknown';

async function ask(mode: 'probe' | 'close'): Promise<CloseAnswer> {
	const answer = await ipcRenderer.invoke(CLOSE_WORKSPACE_REQUEST, mode);
	return answer === 'closable' || answer === 'closing' || answer === 'scratch' ? answer : 'unknown';
}

function refusal(answer: CloseAnswer): Error {
	return new Error(answer === 'scratch' ? `${E444}: Scratch is never closed` : E444);
}

CommandsRegistry.registerCommand({
	id: CLOSE_WORKSPACE_COMMAND,
	metadata: { description: 'Vim: quit: DevHub closes the Workspace (its close button). { discard?: "all" | "active" } drops unsaved changes first (`:qa!`, `:q!`); a modified buffer left stops it (E37 / E162, the buffer made current). E444 for Scratch.' },
	handler: async (accessor, args?: unknown) => {
		const discard = typeof args === 'object' && args !== null ? (args as { discard?: unknown }).discard : undefined;
		const workingCopyService = accessor.get(IWorkingCopyService);
		const editorService = accessor.get(IEditorService);
		const probe = await ask('probe');
		if (probe !== 'closable') {
			throw refusal(probe);
		}
		if (discard === 'all') {
			await Promise.allSettled(workingCopyService.modifiedWorkingCopies.map(workingCopy => workingCopy.revert()));
		} else {
			if (discard === 'active') {
				const editor = editorService.activeEditorPane;
				if (editor?.input.isDirty()) {
					await editor.input.revert(editor.group.id);
				}
			}
			await VimBuffers.instance?.refuseQuit(discard === 'active');
		}
		const answer = await ask('close');
		if (answer !== 'closing') {
			throw refusal(answer);
		}
	},
});
