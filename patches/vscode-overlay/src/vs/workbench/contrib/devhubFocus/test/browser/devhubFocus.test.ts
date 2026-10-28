/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the focus is never left on nothing (browser/devhubFocus.contribution.ts),
// and the safety net moves it only from nothing.

import assert from 'assert';
import { CodeWindow, mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEditorGroupsService, IEditorPart } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { DevhubFocus, focusIsLost, isGone } from '../../browser/devhubFocus.contribution.js';

suite('DevHub: the focus is never left on nothing', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** The workbench as the net sees it: an editor group (a focusable element), whether the editor area is shown, and the OS focus. */
	function workbench(disposables: DisposableStore, opts: { editorShown?: boolean; osFocus?: boolean } = {}) {
		const doc = mainWindow.document;
		const root = doc.body.appendChild(doc.createElement('div'));
		disposables.add({ dispose: () => root.remove() });
		const group = root.appendChild(doc.createElement('div'));
		group.className = 'editor-group-container';
		group.tabIndex = -1;
		let focused = 0;
		const groups = new class extends mock<IEditorGroupsService>() {
			override getPart(): IEditorPart {
				return { activeGroup: { focus: () => { focused++; group.focus(); } } } as unknown as IEditorPart;
			}
		};
		const layout = new class extends mock<IWorkbenchLayoutService>() {
			override getContainer(): HTMLElement { return root; }
			override isVisible(): boolean { return opts.editorShown ?? true; }
		};
		const net = disposables.add(new class extends DevhubFocus {
			// the test window has no OS focus; a DevHub workbench with the keyboard does
			protected override hasOsFocus(_window: CodeWindow): boolean { return opts.osFocus ?? true; }
		}(groups, layout));
		const add = (tag: string) => {
			const e = root.appendChild(doc.createElement(tag));
			e.tabIndex = 0;
			return e;
		};
		return { root, group, net, add, focused: () => focused };
	}

	const tick = () => new Promise(resolve => setTimeout(resolve, 0));

	teardown(() => {
		(mainWindow.document.activeElement as HTMLElement | null)?.blur?.();
	});

	test('nothing: <body>, or an element no longer in the page; gone: out of the page or not rendered', () => {
		const doc = mainWindow.document;
		const input = doc.body.appendChild(doc.createElement('input'));
		try {
			input.focus();
			assert.strictEqual(focusIsLost(doc), false);
			input.blur();
			assert.strictEqual(focusIsLost(doc), true);
			assert.strictEqual(isGone(input), false);
			input.style.display = 'none';
			assert.strictEqual(isGone(input), true);
		} finally {
			input.remove();
		}
		assert.strictEqual(isGone(input), true);
	});

	test('the focused element removed: the active editor group takes the focus', async () => {
		const disposables = store.add(new DisposableStore());
		const w = workbench(disposables);
		const input = w.add('input');
		input.focus();
		// the blur a document with the OS focus gets (the test window has none)
		input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
		input.remove();
		await tick();
		assert.strictEqual(w.focused(), 1);
		assert.strictEqual(mainWindow.document.activeElement, w.group);
		disposables.dispose();
	});

	test('the focused element hidden (display: none, a widget folded away): the active editor group takes the focus', async () => {
		const disposables = store.add(new DisposableStore());
		const w = workbench(disposables);
		const input = w.add('input');
		input.focus();
		input.style.display = 'none';
		input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
		input.blur();
		await tick();
		assert.strictEqual(w.focused(), 1);
		input.remove();
		disposables.dispose();
	});

	test('the focused element removed, without a blur (a document without the OS focus gets none): the next DevHub command finds the focus on nothing', async () => {
		const disposables = store.add(new DisposableStore());
		const w = workbench(disposables);
		const input = w.add('input');
		input.focus();
		input.remove();
		w.net.afterCommand();
		await tick();
		assert.strictEqual(w.focused(), 1);
		disposables.dispose();
	});

	test('a blur onto nothing whose element is still there (a click on an empty part of the window) is left alone', async () => {
		const disposables = store.add(new DisposableStore());
		const w = workbench(disposables);
		const input = w.add('input');
		input.focus();
		input.blur();
		await tick();
		assert.strictEqual(w.focused(), 0);
		disposables.dispose();
	});

	test('the focus moved elsewhere (the side bar, an input, a webview) is never taken', async () => {
		const disposables = store.add(new DisposableStore());
		const w = workbench(disposables);
		const a = w.add('input');
		const b = w.add('div');
		a.focus();
		b.focus();
		a.remove();
		w.net.afterCommand();
		await tick();
		assert.strictEqual(w.focused(), 0);
		assert.strictEqual(mainWindow.document.activeElement, b);
		disposables.dispose();
	});

	test('after a DevHub command, and when the document takes the OS focus (DevHub gave this workbench the keyboard back): on nothing, the active editor group takes it', async () => {
		const disposables = store.add(new DisposableStore());
		const w = workbench(disposables);
		w.net.afterCommand();
		await tick();
		assert.strictEqual(w.focused(), 1);
		w.group.blur();
		mainWindow.dispatchEvent(new FocusEvent('focus'));
		await tick();
		assert.strictEqual(w.focused(), 2);
		disposables.dispose();
	});

	test('not without the OS focus (a workbench DevHub has not given the keyboard), nor with the editor area hidden', async () => {
		for (const opts of [{ osFocus: false }, { editorShown: false }]) {
			const disposables = store.add(new DisposableStore());
			const w = workbench(disposables, opts);
			const input = w.add('input');
			input.focus();
			input.remove();
			w.net.afterCommand();
			await tick();
			assert.strictEqual(w.focused(), 0, JSON.stringify(opts));
			disposables.dispose();
		}
	});
});
