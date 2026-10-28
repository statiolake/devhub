/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the keyboard focus is never left on nothing in the workbench.
//
// A focus that is nowhere (`document.activeElement` is `<body>`, or an element
// that is no longer in the page) is where the keys go to no one: no editor
// takes them, no Vim key applies, and nothing on screen says where they went.
// It is never a place the user went to on purpose. It is what is left when
// the element that had the focus goes away under it (a comment widget, a
// prompt line, a peek or an editor closed or hidden while it had the focus),
// or when DevHub gives this workbench the keyboard back (switching back to its
// Workspace, a DevHub sheet or notice closing, waking from hibernation: main's
// `webContents.focus()`, apps/desktop/src/main/shell/shellWindow.ts) and the
// element it had last is gone.
//
// The safety net, and its limits (docs/window-and-pages.md "Where the keyboard
// lands in a workbench"): the focus goes to the active editor group, and only
//
// * when it is nowhere (focusIsLost) — never away from an element that has
//   it, so the side bar, the panel, the terminal, a webview, an input, a
//   quick input, a menu or a dialog keep it;
// * while this window's document has the OS focus — a workbench DevHub has
//   not given the keyboard is left alone;
// * when the editor area is shown;
// * at one of three moments: the document has just taken the OS focus; the
//   element that had the focus has just been removed or hidden (a blur with no
//   new focus, whose element is gone a moment later — a click on an empty,
//   unfocusable part of the window leaves the focus on `<body>` too, and is
//   left alone); or a DevHub command has just finished (DevhubFocus.afterCommand:
//   DevHub Vim's keys, ex commands, CTRL-W commands and tab page commands).
//
// Each check runs after the current task (a timeout), so it sees the focus
// once what moved it is done with it (a widget that hides itself and then
// focuses its editor, a list that focuses the next row).
//
// Loaded with DevHub Vim's contribution, which uses it (it needs no line in an
// upstream file); it runs whether Vim is on or not.

import { addDisposableListener, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { CodeWindow, mainWindow } from '../../../../base/browser/window.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';

/** The focus is on nothing: no element, `<body>`, the root, or an element no longer in the page. */
export function focusIsLost(doc: Document): boolean {
	const active = doc.activeElement;
	return !active || active === doc.body || active === doc.documentElement || !active.isConnected;
}

/** An element that can no longer have the focus: out of the page, or not rendered (`display: none` on it or above it). */
export function isGone(element: Element): boolean {
	return !element.isConnected || element.getClientRects().length === 0;
}

export class DevhubFocus extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.devhubFocus';

	/** The one in this workbench, for DevHub's commands (afterCommand). */
	static instance: DevhubFocus | undefined;

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		this._register(Event.runAndSubscribe(onDidRegisterWindow, ({ window, disposables }) => {
			const store = disposables.add(new DisposableStore());
			this._register(store);
			// the document took the OS focus (DevHub gave this workbench the keyboard)
			store.add(addDisposableListener(window, 'focus', e => {
				if (e.target === window) {
					this.check(window);
				}
			}));
			// the focused element went away under the focus
			store.add(addDisposableListener(window, 'focusout', e => {
				const target = e.target;
				if (!e.relatedTarget && target instanceof window.Element) {
					this.check(window, target);
				}
			}, true));
		}, { window: mainWindow, disposables: this._store }));
		DevhubFocus.instance = this;
		this._register(toDisposable(() => {
			if (DevhubFocus.instance === this) {
				DevhubFocus.instance = undefined;
			}
		}));
	}

	/** A DevHub command finished: the focus it left on nothing goes to the active editor group. */
	afterCommand(window: CodeWindow = mainWindow): void {
		this.check(window);
	}

	/** After this task: when the focus is on nothing in `window` (and `left` is gone, if given), the active editor group takes it. */
	private check(window: CodeWindow, left?: Element): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			if (left && !isGone(left)) {
				return;
			}
			this.restore(window);
		});
		this.timers.add(timer);
	}

	private readonly timers = new Set<ReturnType<typeof setTimeout>>();

	override dispose(): void {
		for (const t of this.timers) {
			clearTimeout(t);
		}
		this.timers.clear();
		super.dispose();
	}

	/** The focus goes to the active editor group when it is on nothing and the window has the OS focus. Whether it moved. */
	restore(window: CodeWindow = mainWindow): boolean {
		const doc = window.document;
		if (!this.hasOsFocus(window) || !focusIsLost(doc) || !this.layoutService.isVisible(Parts.EDITOR_PART, window)) {
			return false;
		}
		this.editorGroupsService.getPart(this.layoutService.getContainer(window)).activeGroup.focus();
		return !focusIsLost(doc);
	}

	/** Whether DevHub gave this window's document the keyboard (overridden by tests: a test window has none). */
	protected hasOsFocus(window: CodeWindow): boolean {
		return window.document.hasFocus();
	}
}

registerWorkbenchContribution2(DevhubFocus.ID, DevhubFocus, WorkbenchPhase.BlockRestore);
