/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the windows `<C-w>` moves between.
//
// A window is where the keyboard focus can stay: an editor group (Vim's
// windows within a tab page), a comment thread's widget in an editor (VS
// Code's review zone widget: a window of its own below the line it is
// anchored on, as a split would be), the side bar, the panel (the terminal
// with it) and the secondary side bar. Anything else that takes the focus
// for a moment (quick input, the `:` prompt line, a menu, a dialog, a
// notification) is not one, so leaving it is not a window change.
//
// * `<C-w>p` goes back to the window the focus was in before this one,
//   where in it the focus was (VimWindowHistory), as Vim's previous window.
// * `<C-w>w` / `<C-w>W` from outside the editor groups (the side bar, the
//   panel, a terminal, a comment widget) first go back to the active editor
//   group, and cycle through the groups only from one of them.
// * A comment widget belongs to its editor: `<C-w>p k j w W` go back to the
//   editor, on the thread's lines (leaveCommentWindow), and `:q` `:close`
//   `<C-w>c` `<C-w>q` close the widget (closeCommentWindow). Entering it
//   ends the editor's visual mode, as entering another window does in Vim:
//   the thread took the selection as its lines.

import { getActiveElement } from '../../../../base/browser/dom.js';
import { ICodeEditor, isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IRange, Range } from '../../../../editor/common/core/range.js';
import { CommentThreadCollapsibleState } from '../../../../editor/common/languages.js';
import { CommentThreadWidget } from '../../comments/browser/commentThreadWidget.js';
import { SimpleCommentEditor } from '../../comments/browser/simpleCommentEditor.js';

/** VS Code's review zone widget: one comment thread in an editor. */
const COMMENT_WINDOW = '.review-widget';
const GROUP_WINDOW = '.editor-group-container';
const PART_WINDOW = '.part.sidebar, .part.panel, .part.auxiliarybar';

/** The window an element is in, if it is in one. */
export function windowOf(element: Element | null | undefined): Element | undefined {
	return element?.closest(COMMENT_WINDOW) ?? element?.closest(GROUP_WINDOW) ?? element?.closest(PART_WINDOW) ?? undefined;
}

/** In an editor group itself, not in a comment widget of one of its editors nor outside the editor area. */
export function inEditorGroup(element: Element | null | undefined): boolean {
	const window = windowOf(element);
	return !!window && window.matches(GROUP_WINDOW);
}

/** The window the focus was in before the current one, and where in it (`<C-w>p`). */
export class VimWindowHistory {

	private current: { readonly window: Element; readonly focus: HTMLElement } | undefined;
	private previous: { readonly window: Element; readonly focus: HTMLElement } | undefined;

	/** The focus moved to `element` (a `focusin`); outside every window it changes nothing. */
	focused(element: HTMLElement): void {
		const window = windowOf(element);
		if (!window) {
			return;
		}
		if (this.current && this.current.window !== window) {
			this.previous = this.current;
		}
		this.current = { window, focus: element };
	}

	/** Where the focus was in the previous window, while that element is still there. */
	previousFocus(): HTMLElement | undefined {
		return this.previous?.focus.isConnected ? this.previous.focus : undefined;
	}
}

/** A comment thread's widget with the focus in it, and the editor it is in. */
export interface CommentWindow {
	readonly editor: ICodeEditor;
	/** The thread's widget; none when nothing in it is an input (a thread that takes no reply). */
	readonly thread: CommentThreadWidget<IRange> | undefined;
}

/** The comment widget `element` is in, among `editors` (every code editor: the comment inputs are ones too). */
export function commentWindowAt(element: Element | null | undefined, editors: readonly ICodeEditor[]): CommentWindow | undefined {
	const zone = element?.closest(COMMENT_WINDOW);
	if (!zone) {
		return undefined;
	}
	let thread: CommentThreadWidget<IRange> | undefined;
	let editor: ICodeEditor | undefined;
	for (const e of editors) {
		const node = e.getContainerDomNode();
		if (zone.contains(node)) {
			// the reply input or a comment being edited: its thread is the widget's
			const parent = e instanceof SimpleCommentEditor ? e.getParentThread() : undefined;
			if (parent instanceof CommentThreadWidget && isCodeEditor(parent._parentEditor)) {
				thread = parent as CommentThreadWidget<IRange>;
				editor = parent._parentEditor;
			}
		} else if (!editor && e.getDomNode()?.contains(zone)) {
			editor = e;
		}
	}
	return editor ? { editor, thread } : undefined;
}

/** The comment widget the keyboard focus is in, if any. */
export function focusedCommentWindow(editors: readonly ICodeEditor[]): CommentWindow | undefined {
	return commentWindowAt(getActiveElement(), editors);
}

/**
 * The line the editor's cursor goes to when the focus leaves a thread for it:
 * where it is when that is one of the thread's lines (a thread added on a
 * selection, a reply from its line), else the line the widget is anchored on
 * (its last).
 */
export function lineForThread(cursorLine: number | undefined, range: IRange | undefined): number | undefined {
	if (!range || (cursorLine !== undefined && cursorLine >= range.startLineNumber && cursorLine <= range.endLineNumber)) {
		return undefined;
	}
	return range.endLineNumber;
}

/** `<C-w>p k j w W` in a comment widget: the focus goes back to its editor, on the thread's lines; the widget stays. */
export function leaveCommentWindow(w: CommentWindow): void {
	const range = w.thread?.commentThread.range;
	const line = lineForThread(w.editor.getPosition()?.lineNumber, range && Range.isIRange(range) ? range : undefined);
	const model = w.editor.getModel();
	if (line !== undefined && model && line <= model.getLineCount()) {
		w.editor.setPosition({ lineNumber: line, column: model.getLineFirstNonWhitespaceColumn(line) || 1 });
		w.editor.revealLineInCenterIfOutsideViewport(line);
	}
	w.editor.focus();
}

/**
 * `:q` `:close` `<C-w>c` `<C-w>q` in a comment widget: the widget closes and the
 * focus goes back to its editor. VS Code drops a new thread that has nothing
 * typed in it; a reply being typed stays in the closed thread, as when VS Code
 * folds it. A new thread with text typed in it would be dropped too (VS Code
 * keeps no folded new thread), so it stays open and only the focus goes back,
 * the way Vim keeps a changed buffer when its window goes ('hidden'), unless
 * `discard` (`:q!`).
 */
export function closeCommentWindow(w: CommentWindow, discard: boolean): void {
	const widget = w.thread;
	if (widget && (discard || widget.commentThread.comments?.length || !widget.hasUnsubmittedComments)) {
		widget.commentThread.collapsibleState = CommentThreadCollapsibleState.Collapsed;
	}
	leaveCommentWindow(w);
}

/**
 * What `:q` `:close` `:q!` (the ex commands' VS Code steps, vimEx.ts) do run from
 * a comment input: `close`, `discard` (`:q!`), or nothing (`skip`: the tab
 * page's "close it when empty", whose window was not closed).
 */
export const COMMENT_WINDOW_CLOSE_STEPS: ReadonlyMap<string, 'close' | 'discard' | 'skip'> = new Map([
	['workbench.action.closeActiveEditor', 'close'],
	['devhubVim.tabpage.closeWindow', 'close'],
	['workbench.action.revertAndCloseActiveEditor', 'discard'],
	['devhubVim.tabpage.closeIfEmpty', 'skip'],
]);
