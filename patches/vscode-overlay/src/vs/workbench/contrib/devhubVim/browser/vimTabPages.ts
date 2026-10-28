/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: tab pages, each with its own layout of windows.
//
// Within a tab page VS Code's editor groups are Vim's windows. A tab page is
// a VS Code editor working set (IEditorGroupsService.saveWorkingSet /
// applyWorkingSet / deleteWorkingSet, as SCM's working sets per branch are):
// the current page is the live layout, every other page is a working set
// (../common/vimTabPages.ts keeps the list). Switching saves the live layout
// as the current page's working set and applies the target's (then deletes
// it: the live layout is the only copy of the current page); a new page
// applies the `'empty'` working set and, as Vim's new tab page has an empty
// buffer, opens an empty untitled editor in it (newPage).
//
// Unsaved editors: applying a working set (EditorPart.applyState) first
// closes the editors of the live layout with `excludeConfirming`, which skips
// every editor whose close would ask (a modified one, or one whose close
// handler asks), and opens the ones it skipped again, pinned and inactive, in
// the active group of the layout it applied (unless that layout has them). So
// a switch never asks and never loses unsaved text: a modified editor moves
// along into the page you switch to, as one of its editors, until it is saved
// (it is in Vim's terms a hidden modified buffer that stays listed). The same
// holds for closing a page (`:tabc`), and since a modified editor is always
// in the live layout, deleting another page's working set (`:tabc N`,
// `:tabo`) never drops one.
//
// Persistence: the working sets are in workspace storage (VS Code's
// `editor.workingSets`), and so is the list (`devhubVim.tabPages`: their
// order, ids, the current page and what each one shows); the current page's
// layout is the editor part's own restored state. A workbench that DevHub
// closes for hibernation and opens again comes back with its tab pages.
//
// Each switch is one console line, `[devhubVim] tabpage switch N ms`, with
// the time of the save and of the apply.
//
// The tab line (VimTabline): a bar above the editor groups (the editor part's
// `setDevhubTopBar`, patches/vscode/0008-devhub-vim.patch) listing the pages,
// number and active editor, the current one highlighted, in the tab colours;
// shown when there are two or more (Vim's 'showtabline' 1). A click switches.

import { $, addDisposableListener, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IUntitledTextEditorService } from '../../../services/untitled/common/untitledTextEditorService.js';
import { afterClosing, freeUntitledNumber, wantsEmptyBuffer, movePage, nextTabPage, previousTabPage, restoreTabPages, serializeTabPages, TAB_PAGE_WORKING_SET_NAME, TabPage, TabPageMeta, TabPagesState, tabMoveTarget, tabPageIndex, tabPageLabel } from '../common/vimTabPages.js';
import { CLOSE_WINDOW_COMMAND, CLOSE_WORKSPACE_COMMAND, E444, QUIT_WINDOW_COMMAND, QUIT_WINDOW_DISCARD_COMMAND } from '../common/vimEx.js';
import { DevhubFocus } from '../../devhubFocus/browser/devhubFocus.contribution.js';
import './media/vimTabline.css';

/** Workspace storage: the list of tab pages (common/vimTabPages.ts serializeTabPages). */
export const TAB_PAGES_STORAGE_KEY = 'devhubVim.tabPages';
/** Where VS Code keeps the working sets (EditorParts.EDITOR_WORKING_SETS_STORAGE_KEY, private there). */
const EDITOR_WORKING_SETS_STORAGE_KEY = 'editor.workingSets';
/** The tab line's height, in pixels. */
export const TABLINE_HEIGHT = 22;

/** The editor part's hook for a bar above its groups (patches/vscode/0008-devhub-vim.patch). */
interface IEditorPartWithTopBar extends IEditorPart {
	setDevhubTopBar(element: HTMLElement | undefined, height?: number): void;
}

function hasTopBar(part: IEditorPart): part is IEditorPartWithTopBar {
	return typeof (part as Partial<IEditorPartWithTopBar>).setDevhubTopBar === 'function';
}

function workingSet(id: string) {
	return { id, name: TAB_PAGE_WORKING_SET_NAME };
}

function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
}

export class VimTabPages extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.devhubVimTabPages';

	/** The one in this window (the commands run on it). */
	static instance: VimTabPages | undefined;

	private _state: TabPagesState;
	get state(): TabPagesState { return this._state; }

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** The list, the current page, or what the current page shows changed. */
	readonly onDidChange = this._onDidChange.event;

	/** Switches and the other changes of the list run one at a time, in order. */
	private queue: Promise<unknown> = Promise.resolve();
	private switching = false;

	constructor(
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IUntitledTextEditorService private readonly untitledService: IUntitledTextEditorService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		const { state, stale, orphans } = restoreTabPages(storageService.get(TAB_PAGES_STORAGE_KEY, StorageScope.WORKSPACE), groups.getWorkingSets());
		for (const id of [...stale, ...orphans]) {
			groups.deleteWorkingSet(workingSet(id));
		}
		this._state = state;
		if (stale.length || orphans.length) {
			this.store();
		}
		const changed = () => {
			if (!this.switching) {
				this._onDidChange.fire();
			}
		};
		this._register(editorService.onDidActiveEditorChange(changed));
		this._register(editorService.onDidVisibleEditorsChange(changed));
		this._register(groups.onDidAddGroup(changed));
		this._register(groups.onDidRemoveGroup(changed));
		this._register(groups.onDidChangeActiveGroup(changed));
		if (hasTopBar(groups.mainPart)) {
			this._register(new VimTabline(this, groups.mainPart));
		}
		VimTabPages.instance = this;
		this._register(toDisposable(() => {
			if (VimTabPages.instance === this) {
				VimTabPages.instance = undefined;
			}
		}));
	}

	/** What the live layout (the current page) shows: each group's editor in grid order, and the active group. */
	liveMeta(): TabPageMeta {
		const part = this.groups.mainPart;
		const groups = part.getGroups(GroupsOrder.GRID_APPEARANCE);
		return { windows: groups.map(g => g.activeEditor?.getName() ?? ''), active: Math.max(0, groups.indexOf(part.activeGroup)) };
	}

	/** The pages with the current one's meta read from the live layout. */
	pages(): TabPage[] {
		return this._state.pages.map((p, i) => i === this._state.current ? { ...p, ...this.liveMeta() } : p);
	}

	private setState(state: TabPagesState): void {
		this._state = state;
		this.store();
		this._onDidChange.fire();
	}

	private store(): void {
		if (this._state.pages.length > 1) {
			this.storageService.store(TAB_PAGES_STORAGE_KEY, serializeTabPages({ pages: this.pages(), current: this._state.current }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(TAB_PAGES_STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}

	private run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/**
	 * The live layout becomes page `target` of `pages` (whose current page is
	 * `this.state.current`): the current page is saved as a working set first,
	 * or dropped (`close`); the target's working set, or the empty one for a
	 * new page, is applied and then deleted.
	 */
	private async switchTo(pages: TabPage[], target: number, close = false): Promise<void> {
		const from = this._state.current;
		const started = performance.now();
		const editorFocused = this.layoutService.hasFocus(Parts.EDITOR_PART);
		if (!close) {
			const saved = this.groups.saveWorkingSet(TAB_PAGE_WORKING_SET_NAME);
			pages[from] = { ws: saved.id, ...this.liveMeta() };
			// stored before anything else changes: a window that goes away during the switch still has the page
			this._state = { pages, current: from };
			this.store();
		}
		const saved = performance.now();
		const to = pages[target];
		this.switching = true;
		try {
			const options = { preserveFocus: !editorFocused };
			if (!to.ws || !await this.groups.applyWorkingSet(workingSet(to.ws), options)) {
				await this.groups.applyWorkingSet('empty', options);
			}
		} finally {
			this.switching = false;
			pages[target] = { ws: null, ...this.liveMeta() };
			if (close) {
				pages.splice(from, 1);
			}
			this.setState({ pages, current: close && target > from ? target - 1 : target });
			if (to.ws) {
				this.groups.deleteWorkingSet(workingSet(to.ws));
			}
		}
		const done = performance.now();
		const groups = this.groups.mainPart.getGroups(GroupsOrder.GRID_APPEARANCE);
		console.log(`[devhubVim] tabpage switch ${Math.round(done - started)} ms (save ${Math.round(saved - started)} ms, apply ${Math.round(done - saved)} ms; tab page ${from + 1} -> ${this._state.current + 1}${close ? ', closed ' + (from + 1) : ''}; ${groups.reduce((n, g) => n + g.count, 0)} editors in ${groups.length} groups)`);
	}

	/** Go to page `index` (0-based). */
	goto(index: number): Promise<void> {
		return this.gotoBy(() => index);
	}

	/** Go to the page `target` says, read from the list when the commands before this one are done. */
	private gotoBy(target: (current: number, length: number) => number | undefined): Promise<void> {
		return this.run(async () => {
			const { current, pages } = this._state;
			const index = target(current, pages.length);
			if (index !== undefined && index >= 0 && index < pages.length && index !== current) {
				await this.switchTo([...pages], index);
			}
		});
	}

	/** `gt`, `{count}gt`, `:tabn [N | $ | +N | -N]`. */
	next(count: unknown, arg?: unknown): Promise<void> {
		return this.gotoBy((current, length) => tabPageIndex(typeof arg === 'string' ? arg : '', current, length) ?? nextTabPage(num(count), current, length));
	}

	/** `gT`, `{count}gT`, `:tabp [N]`. */
	previous(count: unknown): Promise<void> {
		return this.gotoBy((current, length) => previousTabPage(num(count), current, length));
	}

	first(): Promise<void> {
		return this.gotoBy(() => 0);
	}

	last(): Promise<void> {
		return this.gotoBy((_, length) => length - 1);
	}

	/**
	 * `:tabnew` / `:tabe [file]`: a new page after the current one. Without a
	 * file (`file` empty, or only `++opt`s) it shows a new empty buffer, as in
	 * Vim: an untitled editor, so the page has a Vim editor with the focus
	 * from the start (`gt`, `:`, `CTRL-W` work at once). With one, the file is
	 * opened by the next step (devhubVim.open, as `:e`).
	 *
	 * The empty untitled editor is not modified (an untitled one is only once
	 * it has text), so leaving or closing the page closes it without asking
	 * and disposes it; the page's working set keeps it as VS Code keeps any
	 * untitled editor (UntitledTextEditorInputSerializer), so coming back, and
	 * a reload or hibernation, opens it again, empty. When hot exit is off it
	 * is not kept, and the page comes back with no editor (an empty group,
	 * whose empty buffer takes the normal-mode keys: devhubVim.contribution.ts
	 * VimEmptyBuffer).
	 * It is `Untitled-N` with an N no other page's layout names
	 * (freeUntitledNumber): VS Code would hand out the number of an untitled
	 * editor that is only closed (in another page's working set) again.
	 */
	newPage(file?: unknown): Promise<void> {
		return this.run(async () => {
			const editorFocused = this.layoutService.hasFocus(Parts.EDITOR_PART);
			const pages = [...this._state.pages];
			const at = this._state.current + 1;
			pages.splice(at, 0, { ws: null, windows: [], active: 0 });
			await this.switchTo(pages, at);
			if (wantsEmptyBuffer(file)) {
				await this.editorService.openEditor({ resource: this.newUntitledResource(), options: { pinned: true, preserveFocus: !editorFocused } });
			}
		});
	}

	private newUntitledResource(): URI {
		const uri = (n: number) => URI.from({ scheme: Schemas.untitled, path: `Untitled-${n}` });
		const n = freeUntitledNumber(this.storageService.get(EDITOR_WORKING_SETS_STORAGE_KEY, StorageScope.WORKSPACE), n => !!this.untitledService.get(uri(n)));
		return uri(n);
	}

	/** `:tabc[lose] [N]`: the current page or page N; the last page cannot be closed (E784). */
	close(count?: unknown, arg?: unknown): Promise<void> {
		return this.run(async () => {
			const { current, pages } = this._state;
			const n = num(count);
			const index = n !== null && n > 0 ? tabPageIndex(String(n), current, pages.length)! : tabPageIndex(typeof arg === 'string' ? arg : '', current, pages.length) ?? current;
			if (pages.length < 2) {
				throw new Error('E784: Cannot close last tab page');
			}
			if (index === current) {
				await this.switchTo([...pages], afterClosing(current, pages.length), true);
				return;
			}
			const ws = pages[index].ws;
			const rest = pages.filter((_, i) => i !== index);
			this.setState({ pages: rest, current: index < current ? current - 1 : current });
			if (ws) {
				this.groups.deleteWorkingSet(workingSet(ws));
			}
		});
	}

	/** `:tabo[nly]`: only the current page. */
	only(): Promise<void> {
		return this.run(async () => {
			const { current, pages } = this._state;
			this.setState({ pages: [pages[current]], current: 0 });
			for (const p of pages) {
				if (p.ws) {
					this.groups.deleteWorkingSet(workingSet(p.ws));
				}
			}
		});
	}

	/** `:tabm[ove] [N | +N | -N | $]`. */
	move(arg?: unknown): Promise<void> {
		return this.run(async () => {
			const { current, pages } = this._state;
			const to = tabMoveTarget(typeof arg === 'string' ? arg : '', current, pages.length);
			if (to !== current) {
				this.setState(movePage(this._state, current, to));
			}
		});
	}

	/**
	 * `CTRL-W T`: the current editor (window) moved to a new page after this
	 * one. Not when it is the only editor of the page (Vim: the only window).
	 * A modified one is not closed here (that would ask): it moves along into
	 * the new page as any modified editor does, and stays in this page's
	 * layout too.
	 */
	moveEditorToNewPage(): Promise<void> {
		return this.run(async () => {
			const group = this.groups.activeGroup;
			const editor = group.activeEditor;
			const total = this.groups.mainPart.getGroups(GroupsOrder.GRID_APPEARANCE).reduce((n, g) => n + g.count, 0);
			if (!editor || total < 2) {
				return;
			}
			const untyped = editor.toUntyped({ preserveViewState: group.id });
			if (!untyped) {
				return;
			}
			const asks = editor.isDirty() || !!editor.closeHandler?.showConfirm();
			if (!asks) {
				await group.closeEditor(editor, { preserveFocus: true });
			}
			const pages = [...this._state.pages];
			const at = this._state.current + 1;
			pages.splice(at, 0, { ws: null, windows: [], active: 0 });
			await this.switchTo(pages, at);
			await this.editorService.openEditor({ ...untyped, options: { ...untyped.options, pinned: true } });
		});
	}

	/**
	 * When the last window of the page was closed some other way (every
	 * editor closed: no editor left) and there are other pages, the page is
	 * closed, as in Vim. `:q` itself closes the window (quitWindow); this is
	 * for a binding of the user's after VS Code's Close Editor.
	 */
	closeIfEmpty(): Promise<void> {
		if (this._state.pages.length < 2 || this.groups.groups.some(g => !g.isEmpty)) {
			return Promise.resolve();
		}
		return this.close();
	}

	/**
	 * The window (the active group) closes and its buffers become hidden
	 * (Neovim's default 'hidden'): every editor of the group is moved, inactive,
	 * into the window the focus goes to (VS Code's most recently active other
	 * group: Vim's previous window), whose own editor stays the one it shows.
	 * Nothing is closed, so nothing asks and nothing is lost: a modified
	 * editor keeps its changes and every editor stays listed (`:ls`, `:b`,
	 * `:bn` reach it), as a hidden buffer does. An editor the other window
	 * already has is only taken out of this one. (VS Code's own Close Group,
	 * removeGroup, would make the closed group's editor the other window's
	 * active one: the other window would show this window's buffer.)
	 *
	 * `discard` (`:q!`): the window's current editor drops its changes first
	 * when no other window of the page shows it, as Vim's `:q!` unloads the
	 * current buffer; the others keep theirs, hidden.
	 */
	private async hideWindow(discard: boolean): Promise<void> {
		const editorFocused = this.layoutService.hasFocus(Parts.EDITOR_PART);
		const group = this.groups.activeGroup;
		const target = this.groups.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE).find(g => g.id !== group.id);
		if (!target) {
			return;
		}
		if (discard) {
			await this.discardCurrent(group);
		}
		const editors = group.editors.map(editor => ({ editor, options: { inactive: true, preserveFocus: true } }));
		if (editors.length) {
			group.moveEditors(editors, target);
		}
		// gone already when 'workbench.editor.closeEmptyGroups' removed it; an editor that would not move goes along with VS Code's own merge
		if (this.groups.getGroup(group.id)) {
			this.groups.removeGroup(group);
		}
		this.groups.activateGroup(target);
		if (editorFocused) {
			target.focus();
		}
	}

	/** `:q!`: the group's current editor drops its changes, unless another window of the page shows it. */
	private async discardCurrent(group: IEditorGroup): Promise<void> {
		const editor = group.activeEditor;
		if (!editor?.isDirty() || this.groups.groups.some(g => g.id !== group.id && g.activeEditor?.matches(editor))) {
			return;
		}
		await editor.revert(group.id);
	}

	/**
	 * `:q[!]` `:wq` `:x` `ZZ` `ZQ` `CTRL-W q`: Vim's quit of the current window
	 * (an editor group). With other windows in the page it closes and its
	 * buffers become hidden (hideWindow). The last window of a page closes the
	 * page when there are others (its modified editors go along into the page
	 * you land in, as with `:tabc`). The last window of the last page is Vim
	 * quitting: DevHub's close of the Workspace (`devhubVim.closeWorkspace`,
	 * electron-browser/vimQuit.contribution.ts), the same as its close button,
	 * which asks on its sheet when something would be lost; where the
	 * workbench has no DevHub to ask (or the Workspace is Scratch, which never
	 * closes) it is Vim's E444.
	 */
	quitWindow(discard = false): Promise<void> {
		if (this.groups.count > 1) {
			return this.hideWindow(discard);
		}
		if (this._state.pages.length > 1) {
			return (discard ? this.discardCurrent(this.groups.activeGroup) : Promise.resolve()).then(() => this.close());
		}
		return this.quitWorkspace(discard ? 'active' : undefined);
	}

	/** The last window of the last tab page: the Workspace closes (DevHub's close flow), or E444. */
	private async quitWorkspace(discard: 'active' | undefined): Promise<void> {
		if (!CommandsRegistry.getCommand(CLOSE_WORKSPACE_COMMAND)) {
			throw new Error(E444);
		}
		await this.commandService.executeCommand(CLOSE_WORKSPACE_COMMAND, discard ? { discard } : undefined);
	}

	/**
	 * `:clo[se][!]` / `CTRL-W c`: the window closes, its buffers hidden, as
	 * `:q` (hideWindow); the last window of a tab page closes the tab page, as
	 * in Vim; the last window of the last tab page is never closed (E444).
	 */
	closeWindow(): Promise<void> {
		if (this.groups.count > 1) {
			return this.hideWindow(false);
		}
		if (this._state.pages.length > 1) {
			return this.close();
		}
		return Promise.reject(new Error(E444));
	}

	/** `:tabs`: the pages and their windows; picking one goes there. */
	async list(): Promise<void> {
		const { current } = this._state;
		interface Item extends IQuickPickItem { readonly index: number }
		const items: Item[] = this.pages().map((p, index) => ({
			index,
			label: `${index === current ? '>' : ' '} ${index + 1}  ${tabPageLabel(p)}`,
			description: p.windows.length > 1 ? p.windows.map(w => w || localize('devhubVim.tabs.noName', "[No Name]")).join(', ') : undefined,
		}));
		const picked = await this.quickInputService.pick(items, { placeHolder: localize('devhubVim.tabs.placeholder', "Tab pages"), activeItem: items[current] });
		if (picked) {
			await this.goto(picked.index);
		}
	}
}

/** The tab line: a bar above the editor groups while there are two or more tab pages. */
export class VimTabline extends Disposable {

	readonly element: HTMLElement = $('.devhub-vim-tabline');
	private shown = false;
	private readonly itemListeners = this._register(new DisposableStore());

	constructor(private readonly tabPages: VimTabPages, private readonly part: IEditorPartWithTopBar) {
		super();
		this.element.setAttribute('role', 'tablist');
		// a click switches, the keyboard stays where it was
		this._register(addDisposableListener(this.element, EventType.MOUSE_DOWN, e => e.preventDefault()));
		this._register(tabPages.onDidChange(() => this.render()));
		this._register(toDisposable(() => {
			if (this.shown) {
				part.setDevhubTopBar(undefined);
			}
		}));
		this.render();
	}

	render(): void {
		const pages = this.tabPages.pages();
		const show = pages.length > 1;
		if (show) {
			this.itemListeners.clear();
			clearNode(this.element);
			const current = this.tabPages.state.current;
			pages.forEach((p, i) => {
				const tab = this.element.appendChild($('.devhub-vim-tabline-tab'));
				tab.classList.toggle('current', i === current);
				tab.setAttribute('role', 'tab');
				tab.setAttribute('aria-selected', String(i === current));
				const label = tabPageLabel(p);
				tab.title = p.windows.length > 1 ? `${i + 1}: ${p.windows.filter(w => w).join(', ')}` : `${i + 1}: ${label}`;
				tab.appendChild($('span.devhub-vim-tabline-number')).textContent = String(i + 1);
				tab.appendChild($('span.devhub-vim-tabline-label')).textContent = label;
				if (p.windows.length > 1) {
					tab.appendChild($('span.devhub-vim-tabline-windows')).textContent = String(p.windows.length);
				}
				this.itemListeners.add(addDisposableListener(tab, EventType.CLICK, () => void this.tabPages.goto(i)));
			});
		}
		if (show !== this.shown) {
			this.shown = show;
			this.part.setDevhubTopBar(show ? this.element : undefined, TABLINE_HEIGHT);
		}
	}
}

// BlockRestore: the list is read and the tab line put up before the editors are restored.
registerWorkbenchContribution2(VimTabPages.ID, VimTabPages, WorkbenchPhase.BlockRestore);

// ---- commands (the ex commands and keys run them; the argument-less ones are in the Command Palette) ----

type TabPageArgs = { count?: unknown; arg?: unknown; index?: unknown; file?: unknown };

function tabPageCommand(id: string, title: ILocalizedString, f1: boolean, run: (pages: VimTabPages, args: TabPageArgs) => Promise<void>): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id, title, category: localize2('devhubVim.category', "Vim"), f1 });
		}
		async run(_accessor: ServicesAccessor, args?: unknown): Promise<void> {
			const pages = VimTabPages.instance;
			if (pages) {
				try {
					await run(pages, typeof args === 'object' && args !== null ? args as TabPageArgs : {});
				} finally {
					// a switch whose layout had nothing to take the focus (DevhubFocus, the safety net)
					DevhubFocus.instance?.afterCommand();
				}
			}
		}
	});
}

tabPageCommand('devhubVim.tabpage.new', localize2('devhubVim.tabpage.new', "New Tab Page"), true, (p, a) => p.newPage(a.file));
tabPageCommand('devhubVim.tabpage.next', localize2('devhubVim.tabpage.next', "Next Tab Page"), true, (p, a) => p.next(a.count, a.arg));
tabPageCommand('devhubVim.tabpage.previous', localize2('devhubVim.tabpage.previous', "Previous Tab Page"), true, (p, a) => p.previous(a.count));
tabPageCommand('devhubVim.tabpage.first', localize2('devhubVim.tabpage.first', "First Tab Page"), true, p => p.first());
tabPageCommand('devhubVim.tabpage.last', localize2('devhubVim.tabpage.last', "Last Tab Page"), true, p => p.last());
tabPageCommand('devhubVim.tabpage.goto', localize2('devhubVim.tabpage.goto', "Go to Tab Page"), false, (p, a) => p.goto((num(a.index) ?? 0) - 1));
tabPageCommand('devhubVim.tabpage.close', localize2('devhubVim.tabpage.close', "Close Tab Page"), true, (p, a) => p.close(a.count, a.arg));
tabPageCommand('devhubVim.tabpage.only', localize2('devhubVim.tabpage.only', "Close Other Tab Pages"), true, p => p.only());
tabPageCommand('devhubVim.tabpage.move', localize2('devhubVim.tabpage.move', "Move Tab Page"), false, (p, a) => p.move(a.arg));
tabPageCommand('devhubVim.tabpage.moveEditorToNew', localize2('devhubVim.tabpage.moveEditorToNew', "Move Editor to New Tab Page"), true, p => p.moveEditorToNewPage());
tabPageCommand(CLOSE_WINDOW_COMMAND, localize2('devhubVim.tabpage.closeWindow', "Close Window (Group), or the Tab Page with Its Last Window"), false, p => p.closeWindow());
tabPageCommand(QUIT_WINDOW_COMMAND, localize2('devhubVim.tabpage.quitWindow', "Quit Window (Group): the Tab Page with Its Last Window, the Workspace with the Last One"), false, p => p.quitWindow());
tabPageCommand(QUIT_WINDOW_DISCARD_COMMAND, localize2('devhubVim.tabpage.quitWindowDiscard', "Quit Window (Group), Discarding Its Editor's Changes"), false, p => p.quitWindow(true));
tabPageCommand('devhubVim.tabpage.closeIfEmpty', localize2('devhubVim.tabpage.closeIfEmpty', "Close Tab Page If It Has No Editor"), false, p => p.closeIfEmpty());
tabPageCommand('devhubVim.tabpage.list', localize2('devhubVim.tabpage.list', "List Tab Pages"), true, p => p.list());
