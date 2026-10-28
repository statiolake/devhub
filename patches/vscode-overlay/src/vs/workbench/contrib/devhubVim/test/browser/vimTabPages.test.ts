/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: tab pages switching on a fake IEditorGroupsService whose
// working sets behave as VS Code's (EditorPart.applyState: modified editors
// are never closed, they go along into the active group of the layout
// applied), and the list in workspace storage.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart, IEditorWorkingSet } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IUntitledTextEditorService } from '../../../../services/untitled/common/untitledTextEditorService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { DevhubFocus } from '../../../devhubFocus/browser/devhubFocus.contribution.js';
import { TAB_PAGES_STORAGE_KEY, VimTabPages } from '../../browser/vimTabPages.js';

interface FakeEditor { name: string; dirty: boolean }
interface FakeGroup { id: number; editors: FakeEditor[]; active: number }
interface Layout { groups: FakeGroup[]; active: number }

const clone = (l: Layout): Layout => ({ active: l.active, groups: l.groups.map(g => ({ ...g, editors: [...g.editors] })) });

class FakeWorkbench {
	layout: Layout = { groups: [{ id: 1, editors: [], active: 0 }], active: 0 };
	sets = new Map<string, Layout>();
	saves = 0;
	applies: string[] = [];
	bar: HTMLElement | undefined;
	barHeight = 0;
	opened: string[] = [];
	private nextId = 1;
	/** Where VS Code's EditorParts keeps the working sets ('editor.workingSets'), as JSON. */
	storage: InMemoryStorageService | undefined;
	readonly disposables = new DisposableStore();
	readonly onChange = this.disposables.add(new Emitter<void>());

	open(name: string, dirty = false, group = this.layout.active): FakeEditor {
		const e = { name, dirty };
		const g = this.layout.groups[group];
		g.editors.push(e);
		g.active = g.editors.length - 1;
		this.onChange.fire();
		return e;
	}

	split(): void {
		this.layout.groups.push({ id: 100 + this.layout.groups.length, editors: [], active: 0 });
		this.layout.active = this.layout.groups.length - 1;
		this.onChange.fire();
	}

	storeSets(): void {
		this.storage?.store('editor.workingSets', JSON.stringify([...this.sets].map(([id, l]) => ({ id, editors: l.groups.flatMap(g => g.editors.map(e => JSON.stringify({ resourceJSON: { path: e.name } }))) }))), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/** As the untitled text editor service: an untitled editor exists while some group has it open (closed and not modified, it is disposed). */
	untitledService(): IUntitledTextEditorService {
		const wb = this;
		return new class extends mock<IUntitledTextEditorService>() {
			override get(resource: URI) { return wb.layout.groups.some(g => g.editors.some(e => e.name === `${resource.scheme}:${resource.path}`)) ? {} as never : undefined; }
		};
	}

	shown(): string[][] {
		return this.layout.groups.map(g => g.editors.map(e => e.name + (e.dirty ? '+' : '')));
	}

	/** As EditorPart.applyState: every editor whose close would ask is kept, and opened in the active group of the new layout unless that has it. */
	apply(target: Layout | 'empty'): void {
		const kept = this.layout.groups.flatMap(g => g.editors.filter(e => e.dirty));
		const next: Layout = target === 'empty' ? { groups: [{ id: 1, editors: [], active: 0 }], active: 0 } : clone(target);
		for (const e of kept) {
			if (!next.groups.some(g => g.editors.some(x => x.name === e.name))) {
				next.groups[next.active].editors.push(e);
			}
		}
		this.layout = next;
		this.onChange.fire();
	}

	group(g: FakeGroup): IEditorGroup {
		const wb = this;
		const editor = (e: FakeEditor | undefined) => e && ({
			getName: () => e.name,
			isDirty: () => e.dirty,
			toUntyped: () => ({ resource: undefined, options: {}, label: e.name }),
		} as unknown as EditorInput);
		return new class extends mock<IEditorGroup>() {
			override get id() { return g.id; }
			override get activeEditor() { return editor(g.editors[g.active]) ?? null; }
			override get count() { return g.editors.length; }
			override get isEmpty() { return g.editors.length === 0; }
			override async closeEditor(input?: EditorInput) {
				const i = g.editors.findIndex(e => e.name === input?.getName());
				g.editors.splice(i, 1);
				g.active = Math.max(0, g.editors.length - 1);
				if (!g.editors.length && wb.layout.groups.length > 1) {
					wb.layout.groups.splice(wb.layout.groups.indexOf(g), 1);
					wb.layout.active = 0;
				}
				return true;
			}
		};
	}

	groupsService(): IEditorGroupsService {
		const wb = this;
		const part = new class extends mock<IEditorPart & { setDevhubTopBar(e: HTMLElement | undefined, h?: number): void }>() {
			override getGroups() { return wb.layout.groups.map(g => wb.group(g)); }
			override get activeGroup() { return wb.group(wb.layout.groups[wb.layout.active]); }
			override setDevhubTopBar(e: HTMLElement | undefined, h = 0) { wb.bar = e; wb.barHeight = e ? h : 0; }
		};
		// getGroups().indexOf(activeGroup) compares objects: hand out one object per group
		const cache = new Map<FakeGroup, IEditorGroup>();
		const group = wb.group.bind(wb);
		wb.group = (g: FakeGroup) => { let x = cache.get(g); if (!x) { x = group(g); cache.set(g, x); } return x; };
		return new class extends mock<IEditorGroupsService>() {
			override get mainPart() { return part; }
			override get activeGroup() { return part.activeGroup; }
			override get groups() { return part.getGroups(); }
			override get count() { return wb.layout.groups.length; }
			override removeGroup(group: IEditorGroup) {
				// as EditorPart.removeGroup: the editors go into another group
				const i = wb.layout.groups.findIndex(g => g.id === group.id);
				const [gone] = wb.layout.groups.splice(i, 1);
				wb.layout.active = 0;
				wb.layout.groups[0].editors.push(...gone.editors);
				wb.onChange.fire();
			}
			override onDidAddGroup = wb.onChange.event as never;
			override onDidRemoveGroup = wb.onChange.event as never;
			override onDidChangeActiveGroup = wb.onChange.event as never;
			override saveWorkingSet(name: string): IEditorWorkingSet {
				const id = `ws${wb.nextId++}`;
				wb.saves++;
				wb.sets.set(id, clone(wb.layout));
				wb.storeSets();
				return { id, name };
			}
			override getWorkingSets() { return [...wb.sets.keys()].map(id => ({ id, name: 'devhubVim.tabpage' })); }
			override deleteWorkingSet(ws: IEditorWorkingSet) { wb.sets.delete(ws.id); wb.storeSets(); }
			override async applyWorkingSet(ws: IEditorWorkingSet | 'empty') {
				wb.applies.push(ws === 'empty' ? 'empty' : ws.id);
				if (ws === 'empty') {
					wb.apply('empty');
					return true;
				}
				const l = wb.sets.get(ws.id);
				if (!l) {
					return false;
				}
				wb.apply(l);
				return true;
			}
		};
	}

	editorService(): IEditorService {
		const wb = this;
		return new class extends mock<IEditorService>() {
			override onDidActiveEditorChange = wb.onChange.event as never;
			override onDidVisibleEditorsChange = wb.onChange.event as never;
			override openEditor = (async (editor: { label?: string; resource?: URI }) => {
				const name = editor.label ?? (editor.resource ? `${editor.resource.scheme}:${editor.resource.path}` : '');
				wb.opened.push(name);
				const g = wb.layout.groups[wb.layout.active];
				const i = g.editors.findIndex(e => e.name === name);
				if (i >= 0) {
					g.active = i;
				} else {
					wb.open(name);
				}
				return undefined;
			}) as never;
		};
	}
}

/** `:tabe {file}`: the file is opened by the step after devhubVim.tabpage.new (the tests open it with wb.open). */
const FILE = 'file';

suite('DevHub Vim tab pages: switching on working sets', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let wb: FakeWorkbench;
	let storage: InMemoryStorageService;
	let picked: number | undefined;
	let logs: string[];
	let log: typeof console.log;

	const create = () => disposables.add(new VimTabPages(wb.groupsService(), wb.editorService(), storage,
		new class extends mock<IWorkbenchLayoutService>() { override hasFocus() { return true; } },
		new class extends mock<IQuickInputService>() {
			override async pick<T extends IQuickPickItem>(items: T[]) { return (picked === undefined ? undefined : items[picked]) as never; }
		}, wb.untitledService()));

	setup(() => {
		wb = new FakeWorkbench();
		disposables.add(wb.disposables);
		storage = disposables.add(new InMemoryStorageService());
		wb.storage = storage;
		picked = undefined;
		logs = [];
		log = console.log;
		console.log = (m: string) => { logs.push(m); };
	});

	teardown(() => {
		console.log = log;
	});

	test(':tabnew saves the layout and applies the empty one; gt / gT bring each layout back, in order', async () => {
		const pages = create();
		wb.open('a.ts');
		wb.split();
		wb.open('b.ts');
		await pages.newPage(FILE);
		assert.deepStrictEqual(wb.shown(), [[]]);
		wb.open('c.ts');
		assert.deepStrictEqual(pages.pages().map(p => p.windows), [['a.ts', 'b.ts'], ['c.ts']]);
		assert.strictEqual(pages.state.current, 1);
		await pages.next(null);
		assert.deepStrictEqual(wb.shown(), [['a.ts'], ['b.ts']]);
		assert.strictEqual(wb.layout.active, 1, 'the active window comes back');
		await pages.previous(1);
		assert.deepStrictEqual(wb.shown(), [['c.ts']]);
		// {count}gt: page {count}; no such page: nothing
		await pages.next(1);
		assert.deepStrictEqual(wb.shown(), [['a.ts'], ['b.ts']]);
		const applies = wb.applies.length;
		await pages.next(5);
		assert.strictEqual(wb.applies.length, applies);
		// the target's working set is deleted once applied: only the other page is a working set
		assert.strictEqual(wb.sets.size, 1);
		assert.ok(logs.every(l => /^\[devhubVim\] tabpage switch \d+ ms \(save \d+ ms, apply \d+ ms; tab page \d -> \d; \d+ editors in \d+ groups\)$/.test(l)), logs.join('\n'));
		assert.strictEqual(logs.length, 4);
	});

	test('a modified editor is never closed by a switch: it goes along, and nothing asks', async () => {
		const pages = create();
		wb.open('a.ts');
		const dirty = wb.open('notes.md', true);
		await pages.newPage(FILE);
		assert.deepStrictEqual(wb.shown(), [['notes.md+']], 'carried into the new page');
		wb.open('c.ts');
		await pages.previous(null);
		assert.deepStrictEqual(wb.shown(), [['a.ts', 'notes.md+']]);
		await pages.next(null);
		assert.deepStrictEqual(wb.shown(), [['notes.md+', 'c.ts']]);
		// saved: an ordinary editor of the page it is in
		dirty.dirty = false;
		await pages.previous(null);
		assert.deepStrictEqual(wb.shown(), [['a.ts', 'notes.md']]);
		// :tabc of a page with a modified editor: it goes to the next page
		dirty.dirty = true;
		await pages.close();
		assert.deepStrictEqual(wb.shown(), [['notes.md+', 'c.ts']]);
		assert.strictEqual(pages.state.pages.length, 1);
		assert.strictEqual(wb.sets.size, 0);
	});

	test('a tab page command, when it is done, has the safety net put a focus left on nothing in the active group (DevhubFocus)', async () => {
		const pages = create();
		wb.open('a.ts');
		await pages.newPage(FILE);
		const before = DevhubFocus.instance;
		let checked = 0;
		DevhubFocus.instance = { afterCommand: () => { checked++; } } as unknown as DevhubFocus;
		try {
			assert.strictEqual(VimTabPages.instance, pages);
			await CommandsRegistry.getCommand('devhubVim.tabpage.next')!.handler(undefined!, { count: null });
			assert.strictEqual(pages.state.current, 0);
			assert.strictEqual(checked, 1);
			// also when the command fails (E784)
			await pages.close();
			await assert.rejects(Promise.resolve(CommandsRegistry.getCommand('devhubVim.tabpage.close')!.handler(undefined!, {})));
			assert.strictEqual(checked, 2);
		} finally {
			DevhubFocus.instance = before;
		}
	});

	test(':tabc closes the current page (to the next one, the previous from the last), :tabc N another; E784 on the last one', async () => {
		const pages = create();
		wb.open('1');
		await pages.newPage(FILE); wb.open('2');
		await pages.newPage(FILE); wb.open('3');
		await pages.first();
		await pages.close();
		assert.deepStrictEqual(wb.shown(), [['2']]);
		assert.deepStrictEqual(pages.pages().map(p => p.windows[0]), ['2', '3']);
		await pages.close(undefined, '$');
		assert.deepStrictEqual(pages.pages().map(p => p.windows[0]), ['2']);
		assert.strictEqual(wb.sets.size, 0);
		await assert.rejects(() => pages.close(), /E784/);
		await pages.newPage(FILE); wb.open('4');
		await pages.close(1);
		assert.deepStrictEqual(wb.shown(), [['4']]);
		assert.strictEqual(pages.state.pages.length, 1);
	});

	test(':tabo, :tabm, :tabs', async () => {
		const pages = create();
		wb.open('1');
		await pages.newPage(FILE); wb.open('2');
		await pages.newPage(FILE); wb.open('3');
		await pages.move('0');
		assert.deepStrictEqual(pages.pages().map(p => p.windows[0]), ['3', '1', '2']);
		assert.strictEqual(pages.state.current, 0);
		await pages.move('+1');
		assert.deepStrictEqual(pages.pages().map(p => p.windows[0]), ['1', '3', '2']);
		await assert.rejects(() => pages.move('+5'), /E474/);
		picked = 2;
		await pages.list();
		assert.deepStrictEqual(wb.shown(), [['2']]);
		await pages.only();
		assert.deepStrictEqual(pages.pages().map(p => p.windows[0]), ['2']);
		assert.strictEqual(wb.sets.size, 0);
	});

	test('CTRL-W T moves the window\'s editor to a new page; not the only one', async () => {
		const pages = create();
		wb.open('a.ts');
		await pages.moveEditorToNewPage();
		assert.strictEqual(pages.state.pages.length, 1);
		wb.split();
		wb.open('b.ts');
		await pages.moveEditorToNewPage();
		assert.deepStrictEqual(wb.shown(), [['b.ts']]);
		assert.deepStrictEqual(pages.pages().map(p => p.windows), [['a.ts'], ['b.ts']]);
		await pages.previous(null);
		assert.deepStrictEqual(wb.shown(), [['a.ts']], 'gone from the old page');
	});

	test(':q on the last window of a page closes the page, not the last page', async () => {
		const pages = create();
		wb.open('a.ts');
		await pages.newPage(FILE);
		wb.open('b.ts');
		await pages.closeIfEmpty();
		assert.strictEqual(pages.state.pages.length, 2);
		wb.layout.groups[0].editors = [];
		await pages.closeIfEmpty();
		assert.strictEqual(pages.state.pages.length, 1);
		assert.deepStrictEqual(wb.shown(), [['a.ts']]);
		wb.layout.groups[0].editors = [];
		await pages.closeIfEmpty();
		assert.strictEqual(pages.state.pages.length, 1);
	});

	test(':close / CTRL-W c closes the window; the last window of a page closes the page; the last of the last page stays', async () => {
		const pages = create();
		wb.open('a.ts');
		await pages.newPage(FILE);
		wb.open('b.ts');
		wb.split();
		wb.open('c.ts');
		await pages.closeWindow();
		assert.deepStrictEqual(wb.shown(), [['b.ts', 'c.ts']]);
		assert.strictEqual(pages.state.pages.length, 2);
		await pages.closeWindow();
		assert.deepStrictEqual(wb.shown(), [['a.ts']]);
		assert.strictEqual(pages.state.pages.length, 1);
		await pages.closeWindow();
		assert.deepStrictEqual(wb.shown(), [['a.ts']]);
	});

	test(':tabnew without a file: the new page has an empty untitled editor (Vim\'s new empty buffer); it is not modified, so switching and closing never ask', async () => {
		const pages = create();
		wb.open('a.ts');
		await pages.newPage();
		assert.deepStrictEqual(wb.shown(), [['untitled:Untitled-1']]);
		assert.deepStrictEqual(pages.pages().map(p => p.windows), [['a.ts'], ['untitled:Untitled-1']]);
		// palette / no args, and only ++opts: also an empty buffer; a file: none (devhubVim.open opens it)
		await pages.newPage('  ++enc=latin1 ');
		assert.deepStrictEqual(wb.shown(), [['untitled:Untitled-2']]);
		await pages.newPage('b.ts');
		assert.deepStrictEqual(wb.shown(), [[]]);
		wb.open('b.ts');
		// back to page 3: its untitled editor comes back with the layout (VS Code re-creates an untitled editor of a working set, empty)
		await pages.goto(2);
		assert.deepStrictEqual(wb.shown(), [['untitled:Untitled-2']]);
		// nothing modified was carried along
		await pages.goto(0);
		assert.deepStrictEqual(wb.shown(), [['a.ts']]);
		// :tabc of the page that has it: it is closed with the layout, no editor stays behind
		await pages.goto(2);
		await pages.close();
		assert.deepStrictEqual(pages.pages().map(p => p.windows), [['a.ts'], ['untitled:Untitled-1'], ['b.ts']]);
		assert.ok(!wb.shown().flat().includes('untitled:Untitled-2'));
	});

	test(':tabnew does not reuse the number of an untitled editor another page\'s layout has', async () => {
		const pages = create();
		wb.open('a.ts');
		await pages.newPage();
		await pages.goto(0);
		// Untitled-1 is closed (no longer live) but page 2's working set names it
		await pages.newPage();
		assert.deepStrictEqual(wb.shown(), [['untitled:Untitled-2']]);
		await pages.close();
		await pages.close();
		// nothing names Untitled-1 / -2 any more: the lowest number again
		await pages.newPage();
		assert.deepStrictEqual(wb.shown(), [['untitled:Untitled-1']]);
	});

	test('the list is in workspace storage: a workbench opened again (hibernation) has its tab pages', async () => {
		let pages = create();
		wb.open('a.ts');
		await pages.newPage(FILE);
		wb.open('b.ts');
		await pages.newPage(FILE);
		wb.open('c.ts');
		await pages.goto(1);
		assert.ok(storage.get(TAB_PAGES_STORAGE_KEY, StorageScope.WORKSPACE));
		pages.dispose();
		// the window goes; VS Code restores the live layout (page 2) and the working sets
		const layout = clone(wb.layout);
		wb.layout = layout;
		pages = create();
		assert.strictEqual(pages.state.current, 1);
		assert.deepStrictEqual(pages.pages().map(p => p.windows), [['a.ts'], ['b.ts'], ['c.ts']]);
		await pages.next(3);
		assert.deepStrictEqual(wb.shown(), [['c.ts']]);
		await pages.first();
		assert.deepStrictEqual(wb.shown(), [['a.ts']]);
		// back to one page: nothing stored
		await pages.only();
		assert.strictEqual(storage.get(TAB_PAGES_STORAGE_KEY, StorageScope.WORKSPACE), undefined);
	});

	test('the tab line: shown with two pages or more, number and active editor, current highlighted; a click switches', async () => {
		const pages = create();
		wb.open('a.ts');
		assert.strictEqual(wb.bar, undefined);
		await pages.newPage(FILE);
		wb.open('b.ts');
		assert.ok(wb.bar);
		assert.strictEqual(wb.barHeight, 22);
		const bar = (): HTMLElement | undefined => wb.bar;
		const tabs = () => [...bar()!.querySelectorAll('.devhub-vim-tabline-tab')].map(t => (t.classList.contains('current') ? '*' : '') + t.textContent);
		assert.deepStrictEqual(tabs(), ['1a.ts', '*2b.ts']);
		(bar()!.querySelectorAll('.devhub-vim-tabline-tab')[0] as HTMLElement).click();
		await new Promise(r => setTimeout(r, 0));
		assert.deepStrictEqual(wb.shown(), [['a.ts']]);
		assert.deepStrictEqual(tabs(), ['*1a.ts', '2b.ts']);
		await pages.only();
		assert.strictEqual(bar(), undefined);
	});
});
