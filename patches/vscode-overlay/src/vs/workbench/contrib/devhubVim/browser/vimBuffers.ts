/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: VS Code's editors are Vim's buffers.
//
// Every editor (an editor tab: a file, an untitled file, a diff, Settings, an
// extension's page ...) is a buffer with a number, given when the editor is
// first seen (opened, or restored with the layout) and never reused, as Vim's
// buffer numbers are; the same file opened again — in another group, after it
// was closed, after a reload or hibernation (the list is in workspace
// storage) — is the same buffer with the same number (vimBufferKey.ts). The
// list (common/vimBuffers.ts) is what `:ls` shows and what `:b {N|name}`
// `:bn` `:bp` `:bf` `:bl` `:b#` CTRL-^ `:bd` go by:
//
//   listed     an editor in some group of any tab page, or one whose layout
//              closed it (a tab page switch or `:tabc`: hidden, not loaded);
//              closing an editor yourself (its tab, `:bd`) unlists it
//   %  #       the current window's (the active group's) editor, and the one
//              it showed before (Vim's alternate file, kept per window)
//   a  h       shown in a window (some group's active editor, in this tab page
//              or another) / an editor of the live layout no window shows
//   +  -       modified / read-only
//
// `:b` puts the buffer in the current window, as Vim does: an editor this
// group has is made active; one another window only has as a hidden buffer
// (a tab it does not show) is moved here; one another window shows is opened
// here too (two windows on one buffer); one no group has is opened again from
// its resources. The editor that was current is pinned first, so VS Code's
// preview editor is never replaced (closed) by a buffer switch.
//
// Quitting (refuseQuit): the last window's `:q`, `:qa`, `:wqa` (and `:q!`,
// for the buffers it does not abandon) stop as Neovim's check_changed_any
// stops them when a buffer is modified: E37 and E162 naming the first such
// buffer (the current one, those other windows show, then the hidden ones by
// number, then files modified with no editor), which is made current in its
// window — the one that shows it, or the current window — so it can be dealt
// with at once. Only when nothing modified is left does the quit go on to
// DevHub's close of the Workspace (electron-browser/vimQuit.contribution.ts).

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { isCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { localize, localize2 } from '../../../../nls.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { EditorCloseContext, GroupModelChangeKind, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { SideBySideEditorInput } from '../../../common/editor/sideBySideEditorInput.js';
import { IGroupModelChangeEvent } from '../../../common/editor/editorGroupModel.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { bufferCount, bufferFlags, deleteRefusal, edgeBuffer, findBuffer, formatBufferLine, listBuffers, parseStoredBuffers, quitBlocker, quitRefusal, serializeStoredBuffers, stepBuffer, StoredBuffer, StoredBufferOpen, VimBufferEntry, VimBufferError, VimBufferMarks } from '../common/vimBuffers.js';
import { bufferKey, isDurableKey, reopenData } from './vimBufferKey.js';
import { VimTabPages } from './vimTabPages.js';
import { DevhubFocus } from '../../devhubFocus/browser/devhubFocus.contribution.js';

/** Workspace storage: the buffer list (common/vimBuffers.ts serializeStoredBuffers). */
export const BUFFERS_STORAGE_KEY = 'devhubVim.buffers';

/** Schemes whose resources are files to Vim: named by their path (relative to the workspace folder). */
const FILE_SCHEMES: ReadonlySet<string> = new Set([Schemas.file, Schemas.vscodeRemote, Schemas.vscodeUserData]);

interface BufferRecord {
	nr: number;
	readonly key: string;
	name: string;
	fullName: string;
	listed: boolean;
	line: number;
	open: StoredBufferOpen | undefined;
}

/** A window's (an editor group's) buffers: the one it shows and the one it showed before (Vim's alternate file). */
interface WindowBuffers {
	current?: string;
	alternate?: string;
}

/** A live editor of a buffer, and where it is. */
interface LiveBuffer {
	readonly editor: EditorInput;
	/** The groups that have it. */
	readonly groups: IEditorGroup[];
	/** The groups that show it (their active editor). */
	readonly shownIn: IEditorGroup[];
}

const onDidRefuseQuit = new Emitter<string>();

export class VimBuffers extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.devhubVimBuffers';

	/** The one in this window (the commands run on it). */
	static instance: VimBuffers | undefined;

	/** A quit was refused (E37 / E162) and the buffer made current: the message, for the buffer that has the focus now (devhubVim.contribution.ts). */
	static readonly onDidRefuseQuit = onDidRefuseQuit.event;

	private readonly records = new Map<string, BufferRecord>();
	private next = 1;
	private readonly windows = new Map<number, WindowBuffers>();
	private readonly groupListeners = this._register(new DisposableMap<number>());
	private readonly cursorListener = this._register(new MutableDisposable());

	constructor(
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@ILabelService private readonly labelService: ILabelService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
	) {
		super();
		const stored = parseStoredBuffers(storageService.get(BUFFERS_STORAGE_KEY, StorageScope.WORKSPACE));
		this.next = stored.next;
		for (const b of stored.buffers) {
			this.records.set(b.key, { nr: b.nr, key: b.key, name: b.name, fullName: b.name, listed: b.listed, line: b.line, open: b.open });
		}
		for (const group of groups.groups) {
			this.watch(group);
		}
		this._register(groups.onDidAddGroup(group => {
			// a split: the new window starts with the buffers of the one it was split from (Vim copies the alternate file too)
			const from = this.windows.get(groups.activeGroup.id);
			if (from && !this.windows.has(group.id)) {
				this.windows.set(group.id, { ...from });
			}
			this.watch(group);
		}));
		this._register(groups.onDidRemoveGroup(group => {
			this.groupListeners.deleteAndDispose(group.id);
			this.windows.delete(group.id);
		}));
		// once the editor is shown (its pane has its control)
		this._register(editorService.onDidActiveEditorChange(() => this.followCursor()));
		this._register(storageService.onWillSaveState(e => {
			if (e.reason === WillSaveStateReason.SHUTDOWN || e.reason === WillSaveStateReason.NONE) {
				this.store();
			}
		}));
		this.followCursor();
		VimBuffers.instance = this;
		this._register(toDisposable(() => {
			if (VimBuffers.instance === this) {
				VimBuffers.instance = undefined;
			}
		}));
	}

	private store(): void {
		const buffers: StoredBuffer[] = [];
		const live = this.live();
		for (const r of this.records.values()) {
			if (!isDurableKey(r.key)) {
				continue;
			}
			const editor = live.get(r.key)?.editor;
			buffers.push({ nr: r.nr, key: r.key, name: editor ? this.nameOf(editor).name : r.name, listed: r.listed, line: r.line, open: editor ? reopenData(editor) ?? r.open : r.open });
		}
		this.storageService.store(BUFFERS_STORAGE_KEY, serializeStoredBuffers({ next: this.next, buffers }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private watch(group: IEditorGroup): void {
		if (!this.windows.has(group.id)) {
			this.windows.set(group.id, {});
		}
		for (const editor of group.editors) {
			this.seen(editor);
		}
		const w = this.windows.get(group.id)!;
		w.current = group.activeEditor ? bufferKey(group.activeEditor) : w.current;
		this.groupListeners.set(group.id, group.onDidModelChange(e => this.changed(group, e)));
	}

	/** An editor is open: it is a listed buffer, with a number from the first time it was seen. */
	private seen(editor: EditorInput): BufferRecord {
		const key = bufferKey(editor);
		let r = this.records.get(key);
		const { name, fullName } = this.nameOf(editor);
		if (!r) {
			r = { nr: this.next++, key, name, fullName, listed: true, line: 0, open: reopenData(editor) };
			this.records.set(key, r);
		} else {
			r.listed = true;
			r.name = name;
			r.fullName = fullName;
			r.open = reopenData(editor) ?? r.open;
		}
		return r;
	}

	private changed(group: IEditorGroup, e: IGroupModelChangeEvent): void {
		switch (e.kind) {
			case GroupModelChangeKind.EDITOR_OPEN:
				if (e.editor) {
					this.seen(e.editor);
				}
				break;
			case GroupModelChangeKind.EDITOR_ACTIVE: {
				const w = this.windows.get(group.id) ?? {};
				this.windows.set(group.id, w);
				const key = group.activeEditor ? bufferKey(group.activeEditor) : undefined;
				if (key && key !== w.current) {
					if (w.current) {
						w.alternate = w.current;
					}
					w.current = key;
				}
				break;
			}
			case GroupModelChangeKind.EDITOR_CLOSE: {
				const editor = e.editor;
				if (!editor) {
					break;
				}
				const key = bufferKey(editor);
				const r = this.records.get(key);
				const context = (e as { context?: EditorCloseContext }).context;
				if (!r || context === EditorCloseContext.MOVE || this.live().has(key)) {
					break;
				}
				r.open = reopenData(editor) ?? r.open;
				if (!isDurableKey(key)) {
					// nothing to open it again from
					this.records.delete(key);
				} else if (!VimTabPages.instance?.isSwitching) {
					// closed by the user (its tab, `:bd`, a preview replaced): unlisted; a tab page's layout closing it only hides it
					r.listed = false;
				}
				break;
			}
		}
	}

	/** The active window's cursor line is the buffer's last known line (`:ls` shows it for hidden buffers). */
	private followCursor(): void {
		const group = this.groups.activeGroup;
		const editor = group.activeEditor;
		let control = group.activeEditorPane?.getControl();
		if (isDiffEditor(control)) {
			control = control.getModifiedEditor();
		}
		if (!editor || !isCodeEditor(control)) {
			this.cursorListener.clear();
			return;
		}
		const r = this.records.get(bufferKey(editor));
		const code = control;
		const note = () => {
			const p = code.getPosition();
			if (r && p) {
				r.line = p.lineNumber;
			}
		};
		note();
		this.cursorListener.value = code.onDidChangeCursorPosition(note);
	}

	/** Every editor of every group (each part, each auxiliary window), by buffer. */
	private live(): Map<string, LiveBuffer> {
		const out = new Map<string, LiveBuffer>();
		for (const group of this.groups.groups) {
			for (const editor of group.editors) {
				const key = bufferKey(editor);
				let b = out.get(key);
				if (!b) {
					b = { editor, groups: [], shownIn: [] };
					out.set(key, b);
				}
				b.groups.push(group);
				if (group.activeEditor === editor) {
					b.shownIn.push(group);
				}
			}
		}
		return out;
	}

	/** How `:ls` names an editor: a file by its path relative to the workspace folder, anything else by its name. */
	private nameOf(editor: EditorInput): { name: string; fullName: string } {
		const resource = editor.resource;
		if (resource && FILE_SCHEMES.has(resource.scheme) && !(editor instanceof SideBySideEditorInput)) {
			return { name: this.labelService.getUriLabel(resource, { relative: true }), fullName: this.labelService.getUriLabel(resource) };
		}
		const name = editor.getName();
		return { name, fullName: name };
	}

	/** The buffer list now. */
	entries(): VimBufferEntry[] {
		const live = this.live();
		for (const b of live.values()) {
			if (!this.records.has(bufferKey(b.editor))) {
				this.seen(b.editor);
			}
		}
		const shownElsewhere = new Set<string>();
		const pages = VimTabPages.instance;
		if (pages) {
			pages.state.pages.forEach((p, i) => {
				if (i !== pages.state.current) {
					for (const k of p.shown ?? []) {
						shownElsewhere.add(k);
					}
				}
			});
		}
		const out: VimBufferEntry[] = [];
		for (const r of this.records.values()) {
			const b = live.get(r.key);
			if (b) {
				const { name, fullName } = this.nameOf(b.editor);
				r.name = name;
				r.fullName = fullName;
				r.listed = true;
			}
			out.push({
				nr: r.nr, name: r.name, fullName: r.fullName, listed: r.listed,
				loaded: !!b, shown: !!b?.shownIn.length || shownElsewhere.has(r.key),
				modified: !!b?.editor.isDirty(), readonly: !!b?.editor.isReadonly(), line: r.line,
			});
		}
		return out.sort((a, b) => a.nr - b.nr);
	}

	marks(): VimBufferMarks {
		const group = this.groups.activeGroup;
		const current = group.activeEditor ? this.records.get(bufferKey(group.activeEditor))?.nr : undefined;
		const alt = this.windows.get(group.id)?.alternate;
		const alternate = alt ? this.records.get(alt)?.nr : undefined;
		return { current, alternate: alternate === current ? undefined : alternate };
	}

	/** The `:ls` lines (`:ls!` with the unlisted buffers; `filter`: `:ls +` ...). */
	lines(bang = false, filter = ''): string[] {
		const marks = this.marks();
		return listBuffers(this.entries(), marks, bang, filter).map(b => formatBufferLine(b, marks));
	}

	private find(arg: string): VimBufferEntry {
		return findBuffer(arg, this.entries(), this.marks(), isMacintosh || isWindows);
	}

	private recordOf(nr: number): BufferRecord | undefined {
		for (const r of this.records.values()) {
			if (r.nr === nr) {
				return r;
			}
		}
		return undefined;
	}

	/**
	 * Buffer `nr` in the current window (the active group), as `:b` puts it
	 * there (see the top of this file).
	 */
	async goto(nr: number): Promise<void> {
		const r = this.recordOf(nr);
		if (!r) {
			throw new VimBufferError(`E86: Buffer ${nr} does not exist`);
		}
		const group = this.groups.activeGroup;
		const b = this.live().get(r.key);
		const current = group.activeEditor;
		if (current && b?.editor === current) {
			return;
		}
		if (current && !group.isPinned(current)) {
			group.pinEditor(current);
		}
		if (b && b.groups.some(g => g.id === group.id)) {
			await group.openEditor(b.editor, { pinned: true });
		} else if (b) {
			const hiddenIn = b.groups.find(g => !b.shownIn.includes(g));
			if (hiddenIn && !b.shownIn.length) {
				hiddenIn.moveEditor(b.editor, group, { pinned: true });
			} else {
				await group.openEditor(b.editor, { pinned: true });
			}
		} else {
			const untyped = reopen(r.open);
			if (!untyped) {
				throw new VimBufferError(`E86: Buffer ${nr} does not exist`);
			}
			await this.editorService.openEditor(untyped, group);
		}
		group.focus();
	}

	/** `:b [N | name | % | #]`, `:{N}b`. */
	async gotoArg(arg: unknown, count: unknown): Promise<void> {
		const n = bufferCount(count);
		const a = typeof arg === 'string' ? arg.trim() : '';
		if (n !== undefined) {
			return this.goto(this.find(String(n)).nr);
		}
		if (!a) {
			return;
		}
		return this.goto(this.find(a).nr);
	}

	/** `:bn [N]` / `:bp [N]` (`by` negative), `]b` `[b`. */
	async step(by: number, count: unknown, arg?: unknown): Promise<void> {
		const n = bufferCount(count) ?? bufferCount(arg) ?? 1;
		return this.goto(stepBuffer(this.entries(), this.marks().current, by * n).nr);
	}

	/** `:bf` / `:bl`. */
	async edge(last: boolean): Promise<void> {
		return this.goto(edgeBuffer(this.entries(), last).nr);
	}

	/** CTRL-^ (`{N}` CTRL-^ is `:b N`), `:b#`. */
	async alternate(count: unknown): Promise<void> {
		const n = bufferCount(count);
		if (n !== undefined) {
			return this.goto(this.find(String(n)).nr);
		}
		const alt = this.marks().alternate;
		if (alt === undefined) {
			throw new VimBufferError('E23: No alternate file');
		}
		return this.goto(alt);
	}

	/**
	 * `:bd[!] [N | name ...]` (`:{N}bd`), `:bw`: the buffer's editors are
	 * closed in every group (so it is unlisted); a modified one only with `!`,
	 * which drops its changes (E89 without). `:bw` also forgets its number.
	 */
	async delete(arg: unknown, count: unknown, discard: boolean, wipe: boolean): Promise<void> {
		const n = bufferCount(count);
		const words = typeof arg === 'string' && arg.trim() ? arg.trim().split(/\s+/) : [];
		const marks = this.marks();
		const targets: number[] = [];
		if (n !== undefined) {
			targets.push(this.find(String(n)).nr);
		}
		for (const w of words) {
			targets.push(this.find(w).nr);
		}
		if (!targets.length) {
			if (marks.current === undefined) {
				return;
			}
			targets.push(marks.current);
		}
		const live = this.live();
		for (const nr of targets) {
			const r = this.recordOf(nr);
			if (!r) {
				continue;
			}
			const b = live.get(r.key);
			if (b?.editor.isDirty()) {
				if (!discard) {
					throw new VimBufferError(deleteRefusal(nr));
				}
				await b.editor.revert(b.groups[0].id);
			}
			for (const g of b?.groups ?? []) {
				await g.closeEditor(b!.editor, { preserveFocus: false });
			}
			r.listed = false;
			if (wipe) {
				this.records.delete(r.key);
			}
		}
	}

	/** `:ls[!] [flags]`: the list, in a quick pick (Vim's lines); picking one is `:b N`. */
	async list(bang: unknown, filter: unknown): Promise<void> {
		const marks = this.marks();
		const entries = listBuffers(this.entries(), marks, bang === true, typeof filter === 'string' ? filter : '');
		interface Item extends IQuickPickItem { readonly nr: number }
		const items: Item[] = entries.map(b => ({ nr: b.nr, label: formatBufferLine(b, marks) }));
		const picked = await this.quickInputService.pick(items, {
			placeHolder: localize('devhubVim.ls.placeholder', ":ls — pick a buffer to edit it in the current window (:b N)"),
			activeItem: items.find(i => i.nr === marks.current),
			matchOnLabel: true,
		});
		if (picked) {
			await this.goto(picked.nr);
		}
	}

	/** For `:b` completion: the listed buffers, by number. */
	completions(): { name: string; detail: string }[] {
		const marks = this.marks();
		return listBuffers(this.entries(), marks, false).map(b => ({ name: b.name, detail: `${b.nr}${bufferFlags(b, marks).trimEnd()}` }));
	}

	/**
	 * Neovim's check before it quits (check_changed_any): when a buffer is
	 * modified — with `hiddenOnly` (`:q!`) one no window shows — it is made
	 * current (in the window that shows it, or the current window) and the
	 * quit is refused with E37 / E162. Files modified with no editor (a
	 * refactoring's edits) are such buffers too, last.
	 */
	async refuseQuit(hiddenOnly: boolean): Promise<void> {
		const live = this.live();
		const activeGroup = this.groups.activeGroup;
		const current = activeGroup.activeEditor;
		const candidates = [...live.entries()].map(([key, b]) => ({
			key, b, nr: this.records.get(key)?.nr ?? Number.MAX_SAFE_INTEGER,
			modified: b.editor.isDirty(), shown: b.shownIn.length > 0, current: !!current && b.editor === current,
		}));
		const blocker = quitBlocker(candidates, hiddenOnly);
		if (blocker) {
			const name = this.nameOf(blocker.b.editor).name;
			const shownIn = blocker.b.shownIn.find(g => g.id === activeGroup.id) ?? blocker.b.shownIn[0];
			if (shownIn) {
				this.groups.activateGroup(shownIn);
				shownIn.focus();
			} else {
				await this.goto(blocker.nr);
			}
			return this.refuse(quitRefusal(name));
		}
		// a text file's (or untitled file's) working copy no editor has: the typeId of text files is ''
		const resources = new Set<string>();
		for (const b of live.values()) {
			const e = b.editor;
			for (const r of e instanceof SideBySideEditorInput ? [e.primary.resource, e.secondary.resource] : [e.resource]) {
				if (r) {
					resources.add(r.toString());
				}
			}
		}
		const loose = this.workingCopyService.modifiedWorkingCopies.find(w => w.typeId === '' && !resources.has(w.resource.toString()));
		if (loose) {
			await this.editorService.openEditor({ resource: loose.resource, options: { pinned: true } }, activeGroup);
			activeGroup.focus();
			return this.refuse(quitRefusal(FILE_SCHEMES.has(loose.resource.scheme) ? this.labelService.getUriLabel(loose.resource, { relative: true }) : loose.name));
		}
	}

	private refuse(message: string): never {
		// once the focus is where the jump put it: the buffer that has it now says it too
		setTimeout(() => onDidRefuseQuit.fire(message));
		throw new VimBufferError(message);
	}
}

/** The editor to open for a buffer no group has any more. */
function reopen(open: StoredBufferOpen | undefined): IUntypedEditorInput | undefined {
	if (!open) {
		return undefined;
	}
	const options = { pinned: true, ...(open.override ? { override: open.override } : {}) };
	if (open.primary && open.secondary) {
		return open.diff
			? { original: { resource: URI.parse(open.secondary) }, modified: { resource: URI.parse(open.primary) }, options }
			: { primary: { resource: URI.parse(open.primary) }, secondary: { resource: URI.parse(open.secondary) }, options };
	}
	return open.resource ? { resource: URI.parse(open.resource), options } : undefined;
}

// AfterRestored would miss the numbers of the editors restored: BlockRestore, as the tab pages.
registerWorkbenchContribution2(VimBuffers.ID, VimBuffers, WorkbenchPhase.BlockRestore);

// ---- commands (the ex commands and keys run them) -----------------------------

type BufferArgs = { count?: unknown; arg?: unknown; bang?: unknown };

export const BUFFER_COMMAND = 'devhubVim.buffer.';

function bufferCommand(id: string, title: ILocalizedString, f1: boolean, run: (buffers: VimBuffers, args: BufferArgs) => Promise<void>): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: BUFFER_COMMAND + id, title, category: localize2('devhubVim.category', "Vim"), f1 });
		}
		async run(_accessor: ServicesAccessor, args?: unknown): Promise<void> {
			const buffers = VimBuffers.instance;
			if (buffers) {
				try {
					await run(buffers, typeof args === 'object' && args !== null ? args as BufferArgs : {});
				} finally {
					DevhubFocus.instance?.afterCommand();
				}
			}
		}
	});
}

bufferCommand('list', localize2('devhubVim.buffer.list', "List Buffers (:ls)"), true, (b, a) => b.list(a.bang, a.arg));
bufferCommand('goto', localize2('devhubVim.buffer.goto', "Go to Buffer (:b)"), false, (b, a) => b.gotoArg(a.arg, a.count));
bufferCommand('next', localize2('devhubVim.buffer.next', "Next Buffer (:bn)"), true, (b, a) => b.step(1, a.count, a.arg));
bufferCommand('previous', localize2('devhubVim.buffer.previous', "Previous Buffer (:bp)"), true, (b, a) => b.step(-1, a.count, a.arg));
bufferCommand('first', localize2('devhubVim.buffer.first', "First Buffer (:bf)"), true, b => b.edge(false));
bufferCommand('last', localize2('devhubVim.buffer.last', "Last Buffer (:bl)"), true, b => b.edge(true));
bufferCommand('alternate', localize2('devhubVim.buffer.alternate', "Alternate Buffer (CTRL-^)"), true, (b, a) => b.alternate(a.count));
bufferCommand('delete', localize2('devhubVim.buffer.delete', "Delete Buffer (:bd)"), false, (b, a) => b.delete(a.arg, a.count, false, false));
bufferCommand('deleteDiscard', localize2('devhubVim.buffer.deleteDiscard', "Delete Buffer, Discarding Its Changes (:bd!)"), false, (b, a) => b.delete(a.arg, a.count, true, false));
bufferCommand('wipeout', localize2('devhubVim.buffer.wipeout', "Wipe Out Buffer (:bw)"), false, (b, a) => b.delete(a.arg, a.count, false, true));
bufferCommand('wipeoutDiscard', localize2('devhubVim.buffer.wipeoutDiscard', "Wipe Out Buffer, Discarding Its Changes (:bw!)"), false, (b, a) => b.delete(a.arg, a.count, true, true));
