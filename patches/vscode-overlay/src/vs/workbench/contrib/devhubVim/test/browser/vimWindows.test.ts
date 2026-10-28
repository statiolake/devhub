/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the windows `<C-w>` moves between (browser/vimWindows.ts): the
// editor groups, a comment thread's widget, the side bar and the panel.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IPosition } from '../../../../../editor/common/core/position.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { Comment, CommentMode, CommentThread, CommentThreadCollapsibleState } from '../../../../../editor/common/languages.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ICommentThreadChangedEvent } from '../../../comments/common/commentModel.js';
import { BUILTIN_EX_SPECS } from '../../common/vimEx.js';
import { COMMENT_WINDOW_STEPS, CommentServices, CommentWindow, EMPTY_COMMENT, VimWindowHistory, closeCommentWindow, commentWindowAt, commentWriteAction, inEditorGroup, lineForThread, windowOf, writeCommentWindow } from '../../browser/vimWindows.js';

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
	function fakeEditor(container: HTMLElement, lines = 10, log: string[] = []) {
		let position: IPosition = { lineNumber: 1, column: 1 };
		const editor = {
			getContainerDomNode: () => container,
			getDomNode: () => container,
			getPosition: () => position,
			setPosition: (p: IPosition) => { position = p; log.push(`cursor ${p.lineNumber}:${p.column}`); },
			revealLineInCenterIfOutsideViewport: () => { },
			getModel: () => ({ uri: URI.file('/a.ts'), getLineCount: () => lines, getLineFirstNonWhitespaceColumn: () => 3 }),
			// the DOM focus moves too (closeCommentWindow looks where it is afterwards)
			focus: () => { log.push('focus'); container.tabIndex = -1; container.focus(); },
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
			const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
			try {
				const e = fakeEditor(container);
				e.setCursor(cursor);
				const thread = fakeThread(comments, typed);
				closeCommentWindow({ editor: e.editor, thread } as unknown as CommentWindow, discard);
				return [thread.commentThread.collapsibleState === CommentThreadCollapsibleState.Collapsed ? 'closed' : 'open', ...e.log];
			} finally {
				container.remove();
			}
		};
		assert.deepStrictEqual(run(0, false, false, 5), ['closed', 'focus']);
		assert.deepStrictEqual(run(2, true, false, 5), ['closed', 'focus']);
		assert.deepStrictEqual(run(0, true, false, 5), ['open', 'focus']);
		assert.deepStrictEqual(run(0, true, true, 5), ['closed', 'focus']);
		assert.deepStrictEqual(run(2, false, false, 9), ['closed', 'cursor 6:3', 'focus']);
	});

	test('every window step of :q :q! :close :w :wq :x :up is one the comment widget takes: a comment input never saves or closes the file', () => {
		for (const name of ['quit', 'close', 'wq', 'xit', 'update']) {
			for (const step of BUILTIN_EX_SPECS[name].steps) {
				assert.ok(COMMENT_WINDOW_STEPS.has(step.command), `${name}: ${step.command}`);
			}
		}
		// :w is the engine's (vimEngine.ts exWrite), which runs VS Code's Save
		assert.strictEqual(COMMENT_WINDOW_STEPS.get('workbench.action.files.save'), 'write');
		assert.strictEqual(COMMENT_WINDOW_STEPS.get('devhubVim.update'), 'update');
	});

	test(':w writes what is typed, :x only what changed; nothing but blanks is never submitted', () => {
		assert.strictEqual(commentWriteAction({ text: 'hi', original: '' }, 'write'), 'submit');
		assert.strictEqual(commentWriteAction({ text: '', original: '' }, 'write'), 'empty');
		assert.strictEqual(commentWriteAction({ text: ' \n ', original: '' }, 'write'), 'empty');
		assert.strictEqual(commentWriteAction({ text: '', original: '' }, 'update'), 'unchanged');
		assert.strictEqual(commentWriteAction({ text: 'hi', original: '' }, 'update'), 'submit');
		// an edit: unchanged is no write for :x, a write for :w
		assert.strictEqual(commentWriteAction({ text: 'body', original: 'body' }, 'update'), 'unchanged');
		assert.strictEqual(commentWriteAction({ text: 'body', original: 'body' }, 'write'), 'submit');
		assert.strictEqual(commentWriteAction({ text: '', original: 'body' }, 'update'), 'empty');
	});

	/**
	 * A comment widget as the float's commands read it: a thread with
	 * `comments` (`editing` one of them in its edit box, `edited` typed there),
	 * its reply input (`typed`), the first buttons of their forms, and the
	 * comment services.
	 */
	function float(store: DisposableStore, opts: { comments?: string[]; editing?: number; edited?: string; typed?: string; canReply?: boolean }) {
		const doc = mainWindow.document;
		const log: string[] = [];
		const div = (cls: string, ...children: HTMLElement[]) => {
			const e = doc.createElement('div');
			e.className = cls;
			e.append(...children);
			return e;
		};
		const form = (name: string, ...children: HTMLElement[]) => {
			const button = div('monaco-button');
			button.addEventListener('click', () => log.push(`${name} button`));
			return [...children, div('form-actions', div('other-actions', button))];
		};
		const input = (node: HTMLElement, value: string) => {
			let text = value;
			return { getContainerDomNode: () => node, getValue: () => text, setValue: (v: string) => { text = v; log.push(`typed '${v}'`); } } as unknown as ICodeEditor;
		};
		const comments: Comment[] = (opts.comments ?? []).map((body, i) => ({ body, uniqueIdInThread: i + 1, userName: 'u', mode: i === opts.editing ? CommentMode.Editing : CommentMode.Preview }));
		const zone = div('zone-widget review-widget');
		let edit: ICodeEditor | undefined;
		comments.forEach((c, i) => {
			if (i === opts.editing) {
				const node = div('');
				edit = input(node, opts.edited ?? String(c.body));
				zone.append(div('review-comment', div('edit-container', ...form('save', node))));
			} else {
				zone.append(div('review-comment'));
			}
		});
		const replyNode = div('');
		zone.append(div('comment-form-container', ...form('reply', div('comment-form', replyNode))));
		const reply = input(replyNode, opts.typed ?? '');
		const changeComments = store.add(new Emitter<readonly Comment[] | undefined>());
		const commentThread = {
			threadId: 'typed',
			range: { startLineNumber: 4, startColumn: 1, endLineNumber: 6, endColumn: 1 },
			comments,
			collapsibleState: CommentThreadCollapsibleState.Expanded,
			isDisposed: false,
			canReply: opts.canReply ?? true,
			onDidChangeComments: changeComments.event,
		};
		/** What the extension does on submit (keeps the thread, replaces it). */
		let onSubmit = () => { };
		const thread = {
			commentThread,
			get hasUnsubmittedComments() { return !!reply.getValue(); },
			submitComment: async () => {
				log.push('submit');
				reply.setValue('');
				onSubmit();
			},
			focusCommentEditor: () => log.push('focus reply'),
			focus: () => log.push('focus comment'),
		};
		const outer = div('monaco-editor', zone);
		doc.body.appendChild(outer);
		store.add({ dispose: () => outer.remove() });
		const e = fakeEditor(outer, 10, log);
		(e.editor as unknown as { getContribution: unknown }).getContribution = () => ({
			revealCommentThread: (id: string, _comment: unknown, _fetch: unknown, focus: number) => log.push(`reveal ${id} focus ${focus}`),
		});
		const updates = store.add(new Emitter<ICommentThreadChangedEvent>());
		const services = {
			commentService: { onDidUpdateCommentThreads: updates.event },
			contextKeyService: { getContext: () => ({ getValue: () => undefined }) },
			commandService: { executeCommand: async (id: string) => { log.push(id); } },
		} as unknown as CommentServices;
		const at = (which: 'reply' | 'edit') => ({ editor: e.editor, thread, input: which === 'reply' ? { editor: reply } : { editor: edit, comment: opts.editing } }) as unknown as CommentWindow;
		return {
			log, services, commentThread, at, reply, edit, replyNode, zone, editor: e.editor,
			onSubmit: (f: () => void) => onSubmit = f,
			changeComments: (c: Comment[]) => {
				commentThread.comments = c;
				changeComments.fire(c);
			},
			added: (t: Partial<CommentThread>) => updates.fire({ added: [t], removed: [], changed: [], pending: [], uniqueOwner: 'o', owner: 'o', ownerLabel: 'o' } as unknown as ICommentThreadChangedEvent),
			folded: () => commentThread.collapsibleState === CommentThreadCollapsibleState.Collapsed,
		};
	}

	/** The timeouts a write leaves (the focus after the steps of its command). */
	const settle = () => new Promise(resolve => setTimeout(resolve, 0));

	test('the input the focus is in is the float\'s buffer: the reply, or a comment\'s edit box', () => {
		const store = new DisposableStore();
		try {
			const f = float(store, { comments: ['a', 'b'], editing: 1 });
			const editors = [f.editor, f.reply, f.edit!];
			assert.strictEqual(commentWindowAt(f.replyNode, editors)?.input?.editor, f.reply);
			assert.strictEqual(commentWindowAt(f.replyNode, editors)?.input?.comment, undefined);
			assert.strictEqual(commentWindowAt(f.edit!.getContainerDomNode(), editors)?.input?.editor, f.edit);
			assert.strictEqual(commentWindowAt(f.edit!.getContainerDomNode(), editors)?.input?.comment, 1);
			assert.strictEqual(commentWindowAt(f.zone, editors)?.input, undefined);
		} finally {
			store.dispose();
		}
	});

	test(':w in a reply submits it (VS Code\'s Ctrl+Enter) and the focus stays in the widget; nothing typed is an error and no submit; :x with nothing typed writes nothing', async () => {
		const store = new DisposableStore();
		try {
			const f = float(store, { comments: ['a'], typed: 'hi' });
			await writeCommentWindow(f.at('reply'), 'write', f.services);
			await settle();
			assert.deepStrictEqual(f.log, ['submit', `typed ''`, 'focus reply']);
			assert.ok(!f.folded());
			f.log.length = 0;
			await assert.rejects(writeCommentWindow(f.at('reply'), 'write', f.services), new Error(EMPTY_COMMENT));
			await writeCommentWindow(f.at('reply'), 'update', f.services);
			await settle();
			assert.deepStrictEqual(f.log, []);
		} finally {
			store.dispose();
		}
	});

	test(':wq in a reply submits it, folds the thread and the focus is back in the editor', async () => {
		const store = new DisposableStore();
		try {
			const f = float(store, { comments: ['a'], typed: 'hi' });
			const written = await writeCommentWindow(f.at('reply'), 'write', f.services);
			closeCommentWindow(f.at('reply'), false, f.services, written);
			await settle();
			assert.ok(f.folded());
			assert.deepStrictEqual(f.log, ['submit', `typed ''`, 'cursor 6:3', 'focus']);
		} finally {
			store.dispose();
		}
	});

	test('a reply while a comment is being edited is the reply\'s own submit (Ctrl+Enter would save the edit)', async () => {
		const store = new DisposableStore();
		try {
			const f = float(store, { comments: ['a'], editing: 0, typed: 'hi' });
			await writeCommentWindow(f.at('reply'), 'write', f.services);
			assert.deepStrictEqual(f.log.slice(0, 1), ['reply button']);
		} finally {
			store.dispose();
		}
	});

	test(':w in a comment\'s edit box is its Save, then the focus is in the thread\'s reply (or on the comment when it takes none); :x unchanged saves nothing; an empty edit is an error', async () => {
		const store = new DisposableStore();
		try {
			const f = float(store, { comments: ['a', 'b'], editing: 1, edited: 'b2' });
			await writeCommentWindow(f.at('edit'), 'write', f.services);
			await settle();
			assert.deepStrictEqual(f.log, ['save button', 'focus reply']);
			const g = float(store, { comments: ['a'], editing: 0, edited: 'a2', canReply: false });
			await writeCommentWindow(g.at('edit'), 'write', g.services);
			await settle();
			assert.deepStrictEqual(g.log, ['save button', 'focus comment']);
			const h = float(store, { comments: ['a'], editing: 0 });
			await writeCommentWindow(h.at('edit'), 'update', h.services);
			await assert.rejects(writeCommentWindow(float(store, { comments: ['a'], editing: 0, edited: ' ' }).at('edit'), 'update', h.services), new Error(EMPTY_COMMENT));
			await settle();
			assert.deepStrictEqual(h.log, []);
		} finally {
			store.dispose();
		}
	});

	test(':q in an edit box keeps a changed edit in the folded thread (hidden) and cancels an unchanged one; :q! cancels it; :q! empties a reply, :q keeps it', () => {
		const store = new DisposableStore();
		try {
			store.add(MenuRegistry.appendMenuItem(MenuId.CommentActions, { command: { id: 'test.saveComment', title: 'Save' }, group: 'inline@1' }));
			store.add(MenuRegistry.appendMenuItem(MenuId.CommentActions, { command: { id: 'test.cancelEditComment', title: 'Cancel' }, group: 'inline@2', when: ContextKeyExpr.true() }));
			const run = (edited: string, discard: boolean) => {
				const f = float(store, { comments: ['a'], editing: 0, edited });
				closeCommentWindow(f.at('edit'), discard, f.services);
				return [f.folded() ? 'folded' : 'open', ...f.log];
			};
			// the focus is in the editor first, then the widget changes (it never has the focus when it folds)
			assert.deepStrictEqual(run('a', false), ['folded', 'cursor 6:3', 'focus', 'test.cancelEditComment']);
			assert.deepStrictEqual(run('a2', false), ['folded', 'cursor 6:3', 'focus']);
			assert.deepStrictEqual(run('a2', true), ['folded', 'cursor 6:3', 'focus', 'test.cancelEditComment']);
			const reply = (discard: boolean) => {
				const f = float(store, { comments: ['a'], typed: 'draft' });
				closeCommentWindow(f.at('reply'), discard, f.services);
				return [f.folded() ? 'folded' : 'open', f.reply.getValue(), ...f.log];
			};
			assert.deepStrictEqual(reply(false), ['folded', 'draft', 'cursor 6:3', 'focus']);
			assert.deepStrictEqual(reply(true), ['folded', '', 'cursor 6:3', 'focus', `typed ''`]);
		} finally {
			store.dispose();
		}
	});

	test(':wq in a new thread: the editor gets the focus at once and the thread is folded once it has its comment (folding it before would drop it)', async () => {
		const store = new DisposableStore();
		try {
			const f = float(store, { typed: 'hi' });
			const written = await writeCommentWindow(f.at('reply'), 'write', f.services);
			closeCommentWindow(f.at('reply'), false, f.services, written);
			assert.ok(!f.folded());
			assert.deepStrictEqual(f.log, ['submit', `typed ''`, 'cursor 6:3', 'focus']);
			f.changeComments([{ body: 'hi', uniqueIdInThread: 1, userName: 'u' }]);
			await settle();
			assert.ok(f.folded());
			assert.deepStrictEqual(f.log, ['submit', `typed ''`, 'cursor 6:3', 'focus']);
		} finally {
			store.dispose();
		}
	});

	test(':w in a new thread the extension replaces with its own: the focus goes to that thread\'s reply once VS Code shows it; :wq folds it', async () => {
		const store = new DisposableStore();
		try {
			const made = (f: ReturnType<typeof float>) => {
				const t = { threadId: 'made', resource: URI.file('/a.ts').toString(), range: { startLineNumber: 4, startColumn: 1, endLineNumber: 6, endColumn: 1 }, comments: [{ body: 'hi', uniqueIdInThread: 1, userName: 'u' }], collapsibleState: CommentThreadCollapsibleState.Expanded };
				f.onSubmit(() => {
					f.added(t);
					f.commentThread.isDisposed = true;
				});
				return t;
			};
			const f = float(store, { typed: 'hi' });
			made(f);
			await writeCommentWindow(f.at('reply'), 'write', f.services);
			await settle();
			assert.deepStrictEqual(f.log, ['submit', `typed ''`, 'reveal made focus 2']);
			const g = float(store, { typed: 'hi' });
			const t = made(g);
			const written = await writeCommentWindow(g.at('reply'), 'write', g.services);
			closeCommentWindow(g.at('reply'), false, g.services, written);
			await settle();
			assert.strictEqual(t.collapsibleState, CommentThreadCollapsibleState.Collapsed);
			assert.deepStrictEqual(g.log, ['submit', `typed ''`, 'cursor 6:3', 'focus']);
		} finally {
			store.dispose();
		}
	});
});
