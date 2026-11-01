/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the `<C-w>` window commands (devhubVim.contribution.ts
// registers them and their keys while `devhubVim.mode == 'nav'`).

import { CLOSE_WINDOW_COMMAND, QUIT_WINDOW_COMMAND } from './vimEx.js';

/**
 * Where a nav command first treats the focus as a window of its own
 * (vimWindows.ts). `comment`: in a comment widget it goes back to the
 * widget's editor (`leave`) or closes the widget (`close`) instead of running
 * its commands. `editorFirst`: outside the editor groups (side bar, panel,
 * terminal, ...) it goes back to the active group instead. `back`: to the
 * window the focus was in before, its commands only when there is none (in a
 * comment widget, `leave` only then).
 */
export interface NavWindows {
	readonly comment?: 'leave' | 'close';
	readonly editorFirst?: boolean;
	readonly back?: boolean;
}

/** `<C-w>{key}`: [command id suffix, key (by character, US notation, as the keymap; registered on the JIS keys), also with Ctrl held, commands it runs, NavWindows]. */
export const NAV_COMMANDS: readonly [string, string, boolean, readonly string[], NavWindows?][] = [
	['left', 'h', true, ['workbench.action.navigateLeft']],
	['down', 'j', true, ['workbench.action.navigateDown'], { comment: 'leave' }],
	['up', 'k', true, ['workbench.action.navigateUp'], { comment: 'leave' }],
	['right', 'l', true, ['workbench.action.navigateRight']],
	['leftArrow', 'left', false, ['workbench.action.navigateLeft']],
	['downArrow', 'down', false, ['workbench.action.navigateDown'], { comment: 'leave' }],
	['upArrow', 'up', false, ['workbench.action.navigateUp'], { comment: 'leave' }],
	['rightArrow', 'right', false, ['workbench.action.navigateRight']],
	['next', 'w', true, ['workbench.action.focusNextGroup'], { comment: 'leave', editorFirst: true }],
	['previous', 'shift+w', false, ['workbench.action.focusPreviousGroup'], { comment: 'leave', editorFirst: true }],
	['lastAccessed', 'p', true, ['workbench.action.focusPreviousGroup'], { comment: 'leave', back: true }],
	['top', 't', true, ['workbench.action.focusFirstEditorGroup']],
	['bottom', 'b', true, ['workbench.action.focusLastEditorGroup']],
	['split', 's', true, ['workbench.action.splitEditorUp']],
	['splitShift', 'shift+s', false, ['workbench.action.splitEditorUp']],
	['vsplit', 'v', true, ['workbench.action.splitEditorLeft']],
	['new', 'n', true, ['workbench.action.splitEditorUp', 'workbench.action.files.newUntitledFile']],
	// the window (editor group), its buffers hidden; the last window of a tab page closes the tab
	// page; the last of the last one: `c` E444, `q` the Workspace's close (vimTabPages.ts quitWindow)
	['close', 'c', false, [CLOSE_WINDOW_COMMAND], { comment: 'close' }],
	['quit', 'q', true, [QUIT_WINDOW_COMMAND], { comment: 'close' }],
	['moveToNewTabPage', 'shift+t', false, ['devhubVim.tabpage.moveEditorToNew']],
	['only', 'o', true, ['workbench.action.closeEditorsInOtherGroups']],
	['equalize', '=', false, ['workbench.action.evenEditorWidths']],
	['maximizeHeight', 'shift+-', false, ['workbench.action.toggleMaximizeEditorGroup']],
	['maximizeWidth', 'shift+\\', false, ['workbench.action.toggleMaximizeEditorGroup']],
	['increaseHeight', 'shift+=', false, ['workbench.action.increaseViewHeight']],
	['decreaseHeight', '-', false, ['workbench.action.decreaseViewHeight']],
	['decreaseWidth', 'shift+,', false, ['workbench.action.decreaseViewWidth']],
	['increaseWidth', 'shift+.', false, ['workbench.action.increaseViewWidth']],
	['moveFarLeft', 'shift+h', false, ['workbench.action.moveActiveEditorGroupLeft']],
	['moveFarDown', 'shift+j', false, ['workbench.action.moveActiveEditorGroupDown']],
	['moveFarUp', 'shift+k', false, ['workbench.action.moveActiveEditorGroupUp']],
	['moveFarRight', 'shift+l', false, ['workbench.action.moveActiveEditorGroupRight']],
	// Neovim: <C-w>d / <C-w><C-d> show the diagnostic at the cursor (CTRL-W_d-default)
	['diagnostic', 'd', true, ['editor.action.showHover']],
	// 'tagfunc' is the language server's: <C-w>] splits to the definition, <C-w>} previews it
	['definitionSplit', ']', true, ['editor.action.revealDefinitionAside']],
	['definitionPreview', 'shift+]', false, ['editor.action.peekDefinition']],
];

/**
 * Every command DevHub binds to a key while `<C-w>` waits: the terminal lets
 * them past the shell (terminal.ts DEFAULT_COMMANDS_TO_SKIP_SHELL), as the
 * workbench's other navigation commands, so that a prefix entered from the
 * terminal (`{ "terminal": true }`) gets its key.
 */
export const VIM_NAV_COMMAND_IDS: readonly string[] = [
	...NAV_COMMANDS.map(([name]) => `devhubVim.nav.${name}`),
	'devhubVim.nav.cmdline',
	'devhubVim.nav.escape',
];
