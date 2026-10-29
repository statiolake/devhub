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
// * A comment widget is a Neovim floating window over its editor (focusable,
//   'hidden' on), whose buffer is the comment being typed: the thread's reply
//   (a new thread's first comment) or a comment's edit box, and whose "write"
//   is VS Code's submit (Ctrl+Enter) or the edit's Save. `<C-w>k j w W` go
//   back to the editor, on the thread's lines (leaveCommentWindow), `<C-w>p`
//   to the window before it; `:q` `:close` `<C-w>c` `<C-w>q` close the
//   float, keeping what is typed (hidden), `:q!` drops it
//   (closeCommentWindow); `:w` submits and stays, `:wq` `:x` `ZZ` submit and
//   close (writeCommentWindow). Entering it ends the editor's visual mode,
//   as entering another window does in Vim: the thread took the selection as
//   its lines.

import { getActiveElement } from '../../../../base/browser/dom.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { MarshalledId } from '../../../../base/common/marshallingIds.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor, isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IRange, Range } from '../../../../editor/common/core/range.js';
import { CommentMode, CommentThread, CommentThreadCollapsibleState } from '../../../../editor/common/languages.js';
import { MenuId, MenuRegistry, isIMenuItem } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ICommentService } from '../../comments/browser/commentService.js';
import { CommentController } from '../../comments/browser/commentsController.js';
import { CommentThreadWidget } from '../../comments/browser/commentThreadWidget.js';
import { CommentWidgetFocus } from '../../comments/browser/commentThreadZoneWidget.js';
import { SimpleCommentEditor } from '../../comments/browser/simpleCommentEditor.js';
import { CLOSE_WINDOW_COMMAND, QUIT_WINDOW_COMMAND, QUIT_WINDOW_DISCARD_COMMAND } from '../common/vimEx.js';

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
	/**
	 * The comment input the element is (or is in), the float's buffer: the
	 * thread's reply (a new thread's first comment), or the edit box of its
	 * comment `comment` (an index into the thread's comments).
	 */
	readonly input?: { readonly editor: ICodeEditor; readonly comment?: number };
	/** The widget's element (VS Code's `.review-widget`). */
	readonly zone?: Element;
}

/** The edit box's comment `input` is in (an index into the thread's comments, as their nodes are in the widget), if it is one. */
function editedComment(zone: Element, input: Element): number | undefined {
	const comment = input.closest('.edit-container')?.closest('.review-comment');
	const index = comment ? [...zone.querySelectorAll('.review-comment')].indexOf(comment) : -1;
	return index < 0 ? undefined : index;
}

/** The comment widget `element` is in, among `editors` (every code editor: the comment inputs are ones too). */
export function commentWindowAt(element: Element | null | undefined, editors: readonly ICodeEditor[]): CommentWindow | undefined {
	const zone = element?.closest(COMMENT_WINDOW);
	if (!zone) {
		return undefined;
	}
	let thread: CommentThreadWidget<IRange> | undefined;
	let editor: ICodeEditor | undefined;
	let input: CommentWindow['input'];
	for (const e of editors) {
		const node = e.getContainerDomNode();
		if (zone.contains(node)) {
			if (element && (node === element || node.contains(element))) {
				input = { editor: e, comment: editedComment(zone, node) };
			}
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
	return editor ? { editor, thread, input, zone } : undefined;
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

/** What VS Code's comment features the float's commands use. */
export interface CommentServices {
	readonly commentService: ICommentService;
	readonly contextKeyService: IContextKeyService;
	readonly commandService: ICommandService;
}

function bodyText(body: string | IMarkdownString | undefined): string {
	return typeof body === 'string' ? body : body?.value ?? '';
}

/**
 * The float's buffer: what is typed in the comment input and what it held
 * when it opened (nothing for a reply, the comment's body for an edit), so
 * "modified" is `text !== original`.
 */
export function commentBuffer(w: CommentWindow): { readonly text: string; readonly original: string } | undefined {
	if (!w.input) {
		return undefined;
	}
	const comment = w.input.comment;
	return {
		text: w.input.editor.getValue(),
		original: comment === undefined ? '' : bodyText(w.thread?.commentThread.comments?.[comment]?.body),
	};
}

/** The message of `:w` `:wq` with nothing typed: an empty comment is never submitted. */
export const EMPTY_COMMENT = 'Empty comment: nothing to submit';

/**
 * What a write does in the float: `write` (`:w` `:wq`) submits what is typed,
 * `update` (`:x` `ZZ` `:up`) only when it is modified, as Vim writes a
 * buffer; with nothing but blanks typed it is `empty` (EMPTY_COMMENT), never
 * a submit.
 */
export function commentWriteAction(buffer: { readonly text: string; readonly original: string }, how: 'write' | 'update'): 'submit' | 'empty' | 'unchanged' {
	if (how === 'update' && buffer.text === buffer.original) {
		return 'unchanged';
	}
	return buffer.text.trim() ? 'submit' : 'empty';
}

/**
 * A write in a comment float (writeCommentWindow): the `:q` step of the
 * same `:wq` `:x` takes this window (its input may be gone by then: VS Code
 * ends an edit on its Save) and marks it `closed`, which what follows the
 * write reads: the focus stays in the float only when it was not closed.
 */
export class CommentWrite {
	closed = false;
	/** A new thread submitted that has no comment yet: folding it now would drop it, so the write folds it once it has one. */
	pending = false;
	constructor(readonly window: CommentWindow) { }
}

/** The first button of the input's own form (the reply's, or the edit box's): VS Code's default action there, what Ctrl+Enter runs. */
function primaryButton(input: ICodeEditor): HTMLElement | undefined {
	const form = input.getContainerDomNode().closest('.edit-container, .comment-form-container');
	return form?.querySelector<HTMLElement>(':scope > .form-actions > .other-actions .monaco-button') ?? undefined;
}

/** The focus is where a write left it: on nothing (its input went away) or still in the float. */
function focusStayed(zone: Element | null): boolean {
	const active = getActiveElement();
	return !active || active === active.ownerDocument.body || !!zone?.contains(active);
}

/** The lines of a thread, to know the thread an extension shows in the place of a new one it was submitted to. */
function sameLines(a: IRange | undefined, b: IRange | undefined): boolean {
	return !!a && !!b && a.startLineNumber === b.startLineNumber && a.endLineNumber === b.endLineNumber;
}

/** How long what follows a write waits for VS Code (the extension) to show what was submitted. */
const FOLLOW_MS = 10_000;

/**
 * `:w` `:wq` `:x` `ZZ` `:up` in a comment input (the float's buffer):
 * VS Code's submit of the reply or new thread (Ctrl+Enter there,
 * `editor.action.submitComment`, the extension's submit or reply command), or
 * the edit's Save (the comment's own first action, e.g. reviewRelay's Save),
 * never the file's Save. Nothing typed is EMPTY_COMMENT (thrown: the `:q` of
 * a `:wq` does not run); `:x` with nothing changed writes nothing.
 *
 * Unless the same command closes the float (`:wq`), the focus stays in it:
 * in the reply input again (a reply's, which VS Code empties and folds, or,
 * when an edit's Save ended the edit box, the thread's), or, for a new thread
 * the extension replaced with the thread it made (reviewRelay does), in that
 * thread's reply input once VS Code shows it. A new thread that `:wq` closed
 * is folded once it has its comment (folding it before would drop it).
 */
export async function writeCommentWindow(w: CommentWindow, how: 'write' | 'update', services: CommentServices): Promise<CommentWrite> {
	const written = new CommentWrite(w);
	const widget = w.thread;
	const buffer = commentBuffer(w);
	if (!widget || !w.input || !buffer) {
		return written;
	}
	const action = commentWriteAction(buffer, how);
	if (action === 'empty') {
		throw new Error(EMPTY_COMMENT);
	}
	if (action === 'unchanged') {
		return written;
	}
	const zone = w.input.editor.getContainerDomNode().closest(COMMENT_WINDOW);
	const thread = widget.commentThread;
	/** After the steps of this command (the `:q` of a `:wq` runs first): `closed` when it closed the float, else `staying` while the focus is still there. */
	const afterSteps = (staying: () => void, closed = () => { }) => setTimeout(() => {
		if (written.closed) {
			closed();
		} else if (focusStayed(zone)) {
			staying();
		}
	});
	const focusReply = () => {
		if (thread.canReply === false) {
			widget.focus(undefined);
		} else {
			widget.focusCommentEditor();
		}
	};

	if (w.input.comment !== undefined) {
		// the edit's Save: VS Code ends the edit box at once
		primaryButton(w.input.editor)?.click();
		afterSteps(focusReply);
		return written;
	}

	const isNew = !thread.comments?.length;
	const follow = new DisposableStore();
	const timeout = setTimeout(() => follow.dispose(), FOLLOW_MS);
	follow.add(toDisposable(() => clearTimeout(timeout)));
	if (isNew) {
		written.pending = true;
		// the thread the extension shows in this one's place, on its lines, with the comment
		const uri = w.editor.getModel()?.uri;
		const range = Range.isIRange(thread.range) ? thread.range : undefined;
		let replacement: CommentThread | undefined;
		const take = () => {
			if (!replacement || !thread.isDisposed) {
				return;
			}
			const t = replacement;
			follow.dispose();
			afterSteps(
				() => CommentController.get(w.editor)?.revealCommentThread(t.threadId, undefined, true, CommentWidgetFocus.Editor),
				() => t.collapsibleState = CommentThreadCollapsibleState.Collapsed);
		};
		follow.add(services.commentService.onDidUpdateCommentThreads(e => {
			replacement ??= e.added.find(t => t !== thread && !!t.comments?.length && !!uri && !!t.resource && URI.parse(t.resource).toString() === uri.toString() && sameLines(Range.isIRange(t.range) ? t.range : undefined, range));
			take();
		}));
		// the extension keeps this thread and gives it the comment
		follow.add(thread.onDidChangeComments(comments => {
			if (comments?.length && !thread.isDisposed) {
				follow.dispose();
				afterSteps(focusReply, () => thread.collapsibleState = CommentThreadCollapsibleState.Collapsed);
			}
		}));
		await submitReply(w, widget);
		take();
	} else {
		await submitReply(w, widget);
	}
	if (!thread.isDisposed && (!isNew || thread.comments?.length)) {
		follow.dispose();
		afterSteps(focusReply, () => thread.collapsibleState = CommentThreadCollapsibleState.Collapsed);
	}
	return written;
}

/** VS Code's submit of the reply (Ctrl+Enter), or its form's button when a comment is being edited (Ctrl+Enter would save that edit instead). */
async function submitReply(w: CommentWindow, widget: CommentThreadWidget<IRange>): Promise<void> {
	const editing = widget.commentThread.comments?.some(c => c.mode === CommentMode.Editing);
	if (editing && w.input) {
		primaryButton(w.input.editor)?.click();
	} else {
		await widget.submitComment();
	}
}

/**
 * The comment edit's Cancel: the comment's own action whose command says
 * cancel (e.g. reviewRelay's Cancel), run as its button runs it; false when
 * the comment has none.
 */
export function cancelCommentEdit(w: CommentWindow, services: CommentServices): boolean {
	const input = w.input;
	const thread = w.thread?.commentThread;
	const comment = input?.comment === undefined ? undefined : thread?.comments?.[input.comment];
	const node = input?.editor.getContainerDomNode().closest('.review-comment');
	if (!input || !thread || !comment || !node) {
		return false;
	}
	const context = services.contextKeyService.getContext(node as HTMLElement);
	const cancel = MenuRegistry.getMenuItems(MenuId.CommentActions).find(item => isIMenuItem(item) && /cancel/i.test(item.command.id) && (!item.when || item.when.evaluate(context)));
	if (!cancel || !isIMenuItem(cancel)) {
		return false;
	}
	void services.commandService.executeCommand(cancel.command.id, { thread, commentUniqueId: comment.uniqueIdInThread, text: input.editor.getValue(), $mid: MarshalledId.CommentThreadNode });
	return true;
}

/**
 * The focus is not where closing the float leaves it: on nothing (`<body>`,
 * an element no longer in the page) or still in the float's widget `zone`.
 */
export function focusLeftInFloat(zone: Element | undefined): boolean {
	const active = getActiveElement();
	return !active || active === active.ownerDocument.body || !active.isConnected || !!zone?.contains(active);
}

/**
 * `:q` `:close` `<C-w>c` `<C-w>q` in a comment widget: the float closes and
 * the focus goes back to its editor; what is typed stays (Neovim's 'hidden'),
 * `discard` (`:q!`) drops it.
 *
 * * A reply being typed stays in the folded thread, as when VS Code folds it;
 *   `:q!` empties it.
 * * A comment being edited stays being edited in the folded thread; one with
 *   nothing changed, or with `:q!`, gets the edit's Cancel (cancelCommentEdit).
 * * VS Code drops a new thread that has nothing typed in it. One with text
 *   would be dropped too (VS Code keeps no folded new thread), so it stays
 *   open and only the focus goes back, unless `discard`.
 *
 * The focus is in the editor, on the thread's lines, before anything in the
 * widget changes: VS Code then folds or drops a widget that no longer has it,
 * so neither its hide nor its dispose (which removes the input) can leave the
 * focus on `<body>` or in a hidden input. Whatever the widget's own code or
 * the extension does with the focus right after (an edit's Cancel, a reply
 * input that refocuses itself on a thread update), the focus is put back in
 * the editor once more after this task when it is not anywhere else
 * (focusLeftInFloat); a place the user went to meanwhile keeps it.
 *
 * `written`: the write of the same `:wq` `:x`, which this marks closed; a new
 * thread it submitted is folded by the write once it has its comment.
 */
export function closeCommentWindow(w: CommentWindow, discard: boolean, services?: CommentServices, written?: CommentWrite): void {
	const widget = w.thread;
	const input = w.input;
	if (written) {
		written.closed = true;
	}
	// what to do with the widget, read while its input is still the float's buffer
	let cancel = false;
	let empty = false;
	let fold = false;
	if (widget && !widget.commentThread.isDisposed && !(written?.pending && !widget.commentThread.comments?.length)) {
		const buffer = input?.editor.getContainerDomNode().isConnected ? commentBuffer(w) : undefined;
		if (input?.comment !== undefined) {
			cancel = !!buffer && !!services && (discard || buffer.text === buffer.original);
		} else {
			empty = discard && !!buffer?.text && !!widget.commentThread.comments?.length;
		}
		fold = discard || !!widget.commentThread.comments?.length || !widget.hasUnsubmittedComments;
	}
	leaveCommentWindow(w);
	if (cancel && services) {
		cancelCommentEdit(w, services);
	}
	if (empty) {
		input?.editor.setValue('');
	}
	if (fold && widget) {
		widget.commentThread.collapsibleState = CommentThreadCollapsibleState.Collapsed;
	}
	const keep = () => {
		if (focusLeftInFloat(w.zone)) {
			w.editor.focus();
		}
	};
	keep();
	setTimeout(keep);
}

/**
 * What the ex commands' VS Code steps (vimEx.ts) do run from a comment input:
 * `write` (`:w` `:wq`: VS Code's Save), `update` (`:x` `ZZ` `:up`: Save when
 * modified), `close` (`:q` `:close`, and `:bd`), `discard` (`:q!`, `:bd!`),
 * or nothing (`skip`: the tab page's "close it when empty", whose window was
 * not closed). None of them ever reaches the file or the window: a comment
 * input saves and closes no editor, group or Workspace.
 */
export const COMMENT_WINDOW_STEPS: ReadonlyMap<string, 'write' | 'update' | 'close' | 'discard' | 'skip'> = new Map([
	['workbench.action.files.save', 'write'],
	['devhubVim.update', 'update'],
	[QUIT_WINDOW_COMMAND, 'close'],
	[CLOSE_WINDOW_COMMAND, 'close'],
	[QUIT_WINDOW_DISCARD_COMMAND, 'discard'],
	['workbench.action.closeActiveEditor', 'close'],
	['workbench.action.revertAndCloseActiveEditor', 'discard'],
	// `:bd` `:bw` (`!`): the comment is the buffer
	['devhubVim.buffer.delete', 'close'],
	['devhubVim.buffer.wipeout', 'close'],
	['devhubVim.buffer.deleteDiscard', 'discard'],
	['devhubVim.buffer.wipeoutDiscard', 'discard'],
	['devhubVim.tabpage.closeIfEmpty', 'skip'],
]);
