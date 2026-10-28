/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: Vim quitting is DevHub closing the Workspace.
//
// `:qa` `:wqa` `:xa`, and `:q` `:wq` `:x` `ZZ` `CTRL-W q` in the last window
// of the last tab page (browser/vimTabPages.ts quitWindow), leave the
// workbench as Vim leaves the editor: they ask DevHub's main process to run
// the Workspace's close button (apps/desktop/src/main/shell/
// workbenchCloseRequests.ts, then AppController.closeWorkspaceOrWorktree),
// the one close path: a Workspace with nothing to lose closes, one with
// something to lose (unsaved editors, a busy Agent, a dirty worktree) asks on
// the same sheet the button raises, and cancelling it leaves everything as it
// was. The same as terminal mode's shell `exit` in the editor area.
//
// Scratch is never closed; there, and where there is no DevHub to ask, it is
// Vim's E444 ("Cannot close last window"), and nothing is discarded.
//
// `:qa!` (`{ discard: 'all' }`) drops every unsaved change of the workbench
// first, `:q!` (`{ discard: 'active' }`) those of the current editor (Vim's
// `:q!` abandons the current buffer; another modified one still stops the
// quit, here the close's own sheet asks about it). Only after main has said
// the Workspace can be closed, so an E444 never loses anything.

import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { CLOSE_WORKSPACE_COMMAND, E444 } from '../common/vimEx.js';

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
	metadata: { description: 'Vim: quit: DevHub closes the Workspace (its close button; it asks when something would be lost). { discard?: "all" | "active" } drops unsaved changes first (`:qa!`, `:q!`). E444 for Scratch.' },
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
		} else if (discard === 'active') {
			const editor = editorService.activeEditorPane;
			if (editor?.input.isDirty()) {
				await editor.input.revert(editor.group.id);
			}
		}
		const answer = await ask('close');
		if (answer !== 'closing') {
			throw refusal(answer);
		}
	},
});
