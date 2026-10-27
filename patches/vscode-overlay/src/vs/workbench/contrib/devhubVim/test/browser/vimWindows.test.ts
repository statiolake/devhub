/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the windows `<C-w>` moves between (browser/vimWindows.ts): the
// editor groups, a comment thread's widget, the side bar and the panel.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IPosition } from '../../../../../editor/common/core/position.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { CommentThreadCollapsibleState } from '../../../../../editor/common/languages.js';
import { BUILTIN_EX_SPECS } from '../../common/vimEx.js';
import { COMMENT_WINDOW_CLOSE_STEPS, CommentWindow, VimWindowHistory, closeCommentWindow, commentWindowAt, inEditorGroup, lineForThread, windowOf } from '../../browser/vimWindows.js';

suite('DevHub Vim: windows', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** A workbench of the parts the windows are: two editor groups (one with a comment widget), the side bar, the panel, a quick input. */
	function workbench() {
		const doc = mainWindow.document;
		const el = (tag: string, cls: string, id: string, ...children: HTMLElement[]) => {
			const e = doc.createElement(tag);
			if (cls) {
				e.className = cls;
			}
			if (id) {
				e.id = id;
			}
			e.append(...children);
			return e;
		};
		const root = el('div', '', '',
			el('div', 'part sidebar', '', el('div', 'list', 'list')),
			el('div', 'part editor', '',
				el('div', 'editor-group-container', 'g1', el('div', 'monaco-editor', 'e1', el('textarea', '', 't1'),
					el('div', 'zone-widget review-widget', 'zone', el('div', 'monaco-editor', 'input', el('textarea', '', 't3')), el('button', '', 'button')))),
				el('div', 'editor-group-container', 'g2', el('div', 'monaco-editor', 'e2', el('textarea', '', 't2')))),
			el('div', 'part panel', '', el('div', 'terminal', '', el('textarea', '', 'term'))),
			el('div', 'quick-input-widget', '', el('input', '', 'quick')));
		doc.body.appendChild(root);
		const at = (id: string) => doc.getElementById(id) as HTMLElement;
		return { root, at, dispose: () => root.remove() };
	}

	test('a window is an editor group, a comment widget in one, the side bar or the panel; quick input is none', () => {
		const w = workbench();
		try {
			assert.strictEqual(windowOf(w.at('t1')), w.at('g1'));
			assert.strictEqual(windowOf(w.at('t3')), w.at('zone'));
			assert.strictEqual(windowOf(w.at('button')), w.at('zone'));
			assert.strictEqual(windowOf(w.at('term')), w.at('term').closest('.part'));
			assert.strictEqual(windowOf(w.at('quick')), undefined);
			// <C-w>w cycles the groups only from a group itself
			assert.deepStrictEqual(['t1', 'g2', 't3', 'button', 'term', 'quick'].map(id => inEditorGroup(w.at(id))), [true, true, false, false, false, false]);
		} finally {
			w.dispose();
		}
	});

	test('<C-w>p: where the focus was in the window before this one; a moment in quick input or in the same window changes nothing', () => {
		const w = workbench();
		try {
			const h = new VimWindowHistory();
			assert.strictEqual(h.previousFocus(), undefined);
			h.focused(w.at('t1'));
			h.focused(w.at('term'));
			assert.strictEqual(h.previousFocus(), w.at('t1'));
			h.focused(w.at('quick'));
			assert.strictEqual(h.previousFocus(), w.at('t1'));
			h.focused(w.at('t1'));
			assert.strictEqual(h.previousFocus(), w.at('term'));
			h.focused(w.at('t3'));
			h.focused(w.at('button'));
			assert.strictEqual(h.previousFocus(), w.at('t1'));
			// an element that went away is no place to go back to
			h.focused(w.at('t2'));
			w.at('button').remove();
			assert.strictEqual(h.previousFocus(), undefined);
		} finally {
			w.dispose();
		}
	});

	test('leaving a thread for its editor keeps the cursor on one of its lines, else puts it on the line the widget is under', () => {
		const range: IRange = { startLineNumber: 4, startColumn: 1, endLineNumber: 6, endColumn: 1 };
		assert.strictEqual(lineForThread(5, range), undefined);
		assert.strictEqual(lineForThread(4, range), undefined);
		assert.strictEqual(lineForThread(6, range), undefined);
		assert.strictEqual(lineForThread(9, range), 6);
		assert.strictEqual(lineForThread(1, range), 6);
		assert.strictEqual(lineForThread(undefined, range), 6);
		assert.strictEqual(lineForThread(3, undefined), undefined);
	});

	/** An editor as vimWindows.ts reads one: its nodes, cursor and focus. */
	function fakeEditor(container: HTMLElement, lines = 10) {
		const log: string[] = [];
		let position: IPosition = { lineNumber: 1, column: 1 };
		const editor = {
			getContainerDomNode: () => container,
			getDomNode: () => container,
			getPosition: () => position,
			setPosition: (p: IPosition) => { position = p; log.push(`cursor ${p.lineNumber}:${p.column}`); },
			revealLineInCenterIfOutsideViewport: () => { },
			getModel: () => ({ getLineCount: () => lines, getLineFirstNonWhitespaceColumn: () => 3 }),
			focus: () => log.push('focus'),
		};
		return { editor: editor as unknown as ICodeEditor, log, setCursor: (lineNumber: number) => position = { lineNumber, column: 1 } };
	}

	function fakeThread(comments: number, typed: boolean) {
		const commentThread = {
			range: { startLineNumber: 4, startColumn: 1, endLineNumber: 6, endColumn: 1 },
			comments: new Array(comments).fill({}),
			collapsibleState: CommentThreadCollapsibleState.Expanded,
		};
		return { commentThread, hasUnsubmittedComments: typed };
	}

	test('the comment widget the focus is in belongs to the editor around it', () => {
		const w = workbench();
		try {
			const outer = fakeEditor(w.at('e1'));
			const other = fakeEditor(w.at('e2'));
			assert.strictEqual(commentWindowAt(w.at('button'), [other.editor, outer.editor])?.editor, outer.editor);
			assert.strictEqual(commentWindowAt(w.at('t1'), [other.editor, outer.editor]), undefined);
		} finally {
			w.dispose();
		}
	});

	test(':q / <C-w>c in a comment widget: an empty new thread or a thread with comments closes; a new thread with text typed stays open (unless :q!); the focus is back in the editor, on the thread', () => {
		const run = (comments: number, typed: boolean, discard: boolean, cursor: number) => {
			const e = fakeEditor(mainWindow.document.createElement('div'));
			e.setCursor(cursor);
			const thread = fakeThread(comments, typed);
			closeCommentWindow({ editor: e.editor, thread } as unknown as CommentWindow, discard);
			return [thread.commentThread.collapsibleState === CommentThreadCollapsibleState.Collapsed ? 'closed' : 'open', ...e.log];
		};
		assert.deepStrictEqual(run(0, false, false, 5), ['closed', 'focus']);
		assert.deepStrictEqual(run(2, true, false, 5), ['closed', 'focus']);
		assert.deepStrictEqual(run(0, true, false, 5), ['open', 'focus']);
		assert.deepStrictEqual(run(0, true, true, 5), ['closed', 'focus']);
		assert.deepStrictEqual(run(2, false, false, 9), ['closed', 'cursor 6:3', 'focus']);
	});

	test('every window step of :q :q! :close is one the comment widget takes', () => {
		for (const name of ['quit', 'close']) {
			for (const step of BUILTIN_EX_SPECS[name].steps) {
				assert.ok(COMMENT_WINDOW_CLOSE_STEPS.has(step.command), `${name}: ${step.command}`);
			}
		}
	});
});
