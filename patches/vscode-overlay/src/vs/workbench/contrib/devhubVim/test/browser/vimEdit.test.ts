/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: `:e {file}` and friends open the file itself (browser/vimEdit.ts):
// resolved in the workspace's own file system (a remote one too), a new file
// for a name that does not exist, `:e` reading the file again (E37 when it is
// modified, `:e!` dropping the changes).

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSBuffer, VSBufferReadable, VSBufferReadableStream } from '../../../../../base/common/buffer.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileContent, IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService, IUntypedEditorReplacement } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ITextFileEditorModel, ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { VimFileCommands } from '../../browser/vimEdit.js';
import { IUntypedEditorInput } from '../../../../common/editor.js';

const REMOTE = URI.parse('vscode-remote://ssh-remote+box/home/dev/proj');
const SECOND = URI.parse('vscode-remote://ssh-remote+box/srv/lib');
const HOME = URI.parse('vscode-remote://ssh-remote+box/home/dev');

function folder(uri: URI, index: number): IWorkspaceFolder {
	return { uri, name: uri.path.split('/').pop()!, index, toResource: (p: string) => URI.joinPath(uri, p) } as unknown as IWorkspaceFolder;
}

interface Log {
	opened: { input: IUntypedEditorInput; group: unknown }[];
	replaced: IUntypedEditorReplacement[];
	commands: unknown[][];
	reverted: string[];
	/** Files written, by URI, with their contents. */
	written: Map<string, string>;
	saved: string[];
	savedAs: [string, string][];
}

function setup(options: { exists?: string[]; dirs?: string[]; dirty?: string[]; activeEditor?: URI; folders?: URI[]; contents?: Record<string, string> } = {}) {
	const log: Log = { opened: [], replaced: [], commands: [], reverted: [], written: new Map(), saved: [], savedAs: [] };
	const contents = new Map(Object.entries(options.contents ?? {}));
	const folders = (options.folders ?? [REMOTE, SECOND]).map(folder);
	const exists = new Set(options.exists ?? []);
	const dirs = new Set(options.dirs ?? []);
	const dirty = new Set(options.dirty ?? []);
	const active = options.activeEditor && ({ resource: options.activeEditor, typeId: 'test' } as unknown as EditorInput);
	const group = { id: 1, activeEditor: active } as unknown as IEditorGroup;
	const commands = new VimFileCommands(
		new class extends mock<IEditorService>() {
			override get activeEditor() { return active; }
			override async openEditor(input: IUntypedEditorInput, group?: unknown) { log.opened.push({ input, group }); return undefined; }
			override async replaceEditors(r: IUntypedEditorReplacement[]) { log.replaced.push(...r); }
			override findEditors = ((resource: URI) => resource.toString() === active?.resource?.toString() ? [{ editor: active, groupId: 1 }] : []) as unknown as IEditorService['findEditors'];
		} as unknown as IEditorService,
		new class extends mock<IEditorGroupsService>() { override get activeGroup() { return group; } },
		new class extends mock<IFileService>() {
			override async stat(resource: URI) {
				const k = resource.toString();
				if (dirs.has(k)) {
					return { isDirectory: true, isFile: false } as unknown as IFileStatWithMetadata;
				}
				if (exists.has(k)) {
					return { isDirectory: false, isFile: true } as unknown as IFileStatWithMetadata;
				}
				if (contents.has(k) || log.written.has(k)) {
					return { isDirectory: false, isFile: true } as unknown as IFileStatWithMetadata;
				}
				throw new Error('not found');
			}
			override async exists(resource: URI) { const k = resource.toString(); return exists.has(k) || dirs.has(k) || contents.has(k) || log.written.has(k); }
			override async readFile(resource: URI) {
				const k = resource.toString();
				const text = log.written.get(k) ?? contents.get(k);
				if (text === undefined) {
					throw new Error('not found');
				}
				return { value: VSBuffer.fromString(text) } as unknown as IFileContent;
			}
			override async writeFile(resource: URI, buffer: VSBuffer | VSBufferReadable | VSBufferReadableStream) { log.written.set(resource.toString(), (buffer as VSBuffer).toString()); return {} as IFileStatWithMetadata; }
		},
		new class extends mock<IPathService>() { override userHome = (async () => HOME) as unknown as IPathService['userHome']; },
		new class extends mock<ITextFileService>() {
			override readonly files = {
				get: (resource: URI) => resource.scheme === 'untitled' ? undefined : {
					isDirty: () => dirty.has(resource.toString()),
					revert: async () => { log.reverted.push(resource.toString()); },
				} as unknown as ITextFileEditorModel,
			} as unknown as ITextFileService['files'];
			override async save(resource: URI) { log.saved.push(resource.toString()); return resource; }
			override async saveAs(source: URI, target?: URI) { log.savedAs.push([source.toString(), target!.toString()]); return target; }
		},
		new class extends mock<IWorkspaceContextService>() {
			override getWorkspace(): IWorkspace { return { id: 'w', folders } as unknown as IWorkspace; }
			override getWorkspaceFolder(resource: URI) { return folders.find(f => resource.toString().startsWith(f.uri.toString() + '/')) ?? null; }
		},
		new class extends mock<ICommandService>() {
			override async executeCommand(...args: unknown[]) { log.commands.push(args); return undefined; }
		},
		new class extends mock<IModelService>() {
			override getModel(resource: URI) { return resource.toString() === FILE ? { getEOL: () => '\r\n', getLineCount: () => 2, getValue: () => 'a\r\nb' } as unknown as ITextModel : null; }
		},
		new class extends mock<ILabelService>() { override getUriLabel(resource: URI) { return resource.path.split('/').pop()!; } },
	);
	return { commands, log, group, active };
}

const FILE = URI.joinPath(REMOTE, 'src/vim/main.ts').toString();
const opened = (log: Log) => log.opened.map(o => ({ resource: (o.input as { resource?: URI }).resource?.toString(), untitled: !!(o.input as { forceUntitled?: boolean }).forceUntitled }));

suite('DevHub Vim: :e {file}', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('relative to the workspace folder of the file, in the workspace\'s own (remote) file system', async () => {
		const t = setup({ exists: [`${REMOTE}/src/a.ts`, `${SECOND}/b.ts`, `${HOME}/.zshrc`, `${REMOTE}/src/vim/keys.ts`] });
		await t.commands.edit({ file: 'src/a.ts', bang: false, from: FILE });
		await t.commands.edit({ file: '~/.zshrc', from: FILE });
		await t.commands.edit({ file: '%:h/keys.ts', from: FILE });
		// multi-root: the folder the file is in
		await t.commands.edit({ file: 'b.ts', from: `${SECOND}/x/y.ts` });
		assert.deepStrictEqual(opened(t.log), [
			{ resource: `${REMOTE}/src/a.ts`, untitled: false },
			{ resource: `${HOME}/.zshrc`, untitled: false },
			{ resource: `${REMOTE}/src/vim/keys.ts`, untitled: false },
			{ resource: `${SECOND}/b.ts`, untitled: false },
		]);
		assert.strictEqual(t.log.opened[0].group, t.group);
	});

	test('outside every folder (and without from, the active editor\'s file): the first folder', async () => {
		const t = setup({ activeEditor: URI.parse('vscode-remote://ssh-remote+box/tmp/scratch.txt') });
		await t.commands.edit({ file: 'n.md' });
		assert.deepStrictEqual(opened(t.log), [{ resource: `${REMOTE}/n.md`, untitled: true }]);
	});

	test('a name that does not exist is a new file at that path (untitled, saved there)', async () => {
		const t = setup();
		await t.commands.edit({ file: 'docs/new.md', from: FILE });
		assert.deepStrictEqual(opened(t.log), [{ resource: `${REMOTE}/docs/new.md`, untitled: true }]);
		assert.strictEqual(URI.isUri((t.log.opened[0].input as { resource?: URI }).resource), true);
		assert.strictEqual((t.log.opened[0].input as { resource: URI }).resource.scheme, 'vscode-remote', 'the associated resource is the real path, not an untitled: URI');
	});

	test('a pattern opens quick open with it; a directory opens quick open in it', async () => {
		const t = setup({ dirs: [`${REMOTE}/src`] });
		await t.commands.edit({ file: 'src/*.ts', from: FILE });
		await t.commands.edit({ file: 'src', from: FILE });
		assert.deepStrictEqual(t.log.commands, [['workbench.action.quickOpen', 'src/*.ts'], ['workbench.action.quickOpen', 'src/']]);
		assert.deepStrictEqual(t.log.opened, []);
	});

	test(':e reads the file again; modified it is E37 unless :e!', async () => {
		const t = setup({ dirty: [FILE] });
		await assert.rejects(t.commands.edit({ file: '', bang: false, from: FILE }), /E37: No write since last change/);
		assert.deepStrictEqual(t.log.reverted, []);
		await t.commands.edit({ file: '', bang: true, from: FILE });
		assert.deepStrictEqual(t.log.reverted, [FILE]);
		const clean = setup();
		await clean.commands.edit({ file: '', bang: false, from: FILE });
		assert.deepStrictEqual(clean.log.reverted, [FILE]);
		await assert.rejects(clean.commands.edit({ file: '', from: 'untitled:Untitled-1' }), /E32/);
		await assert.rejects(clean.commands.edit({ file: '%:h/x', from: 'untitled:Untitled-1' }), /E499/);
	});

	test(':sp {file} takes the place of the copy the split made; :sp alone keeps it; :new / :tabnew without a file are a new untitled file', async () => {
		const t = setup({ exists: [`${REMOTE}/x.ts`], activeEditor: URI.parse(FILE) });
		await t.commands.open({ file: 'x.ts', replace: true, from: FILE });
		assert.deepStrictEqual(t.log.replaced.map(r => [r.editor, (r.replacement as { resource?: URI }).resource?.toString()]), [[t.active, `${REMOTE}/x.ts`]]);
		await t.commands.open({ file: '', replace: true, from: FILE });
		assert.strictEqual(t.log.replaced.length, 1);
		assert.deepStrictEqual(t.log.opened, []);
		// :sp % : the file is the copy already
		await t.commands.open({ file: '%', replace: true, from: FILE });
		assert.strictEqual(t.log.replaced.length, 1);
		await t.commands.open({ file: '', replace: true, untitled: true, from: FILE });
		assert.deepStrictEqual(t.log.replaced.slice(1).map(r => (r.replacement as { forceUntitled?: boolean }).forceUntitled), [true]);
		await t.commands.open({ file: '', untitled: true, from: FILE });
		assert.deepStrictEqual(t.log.commands, [['workbench.action.files.newUntitledFile']]);
		// :tabe {file}: a tab in the group
		await t.commands.open({ file: 'x.ts', untitled: true, from: FILE });
		assert.deepStrictEqual(opened(t.log).slice(-1), [{ resource: `${REMOTE}/x.ts`, untitled: false }]);
	});
});

suite('DevHub Vim: :w {file}, :w >> {file}, :sav {file}, :r {file}', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test(':w {file} writes the lines there, in the workspace\'s own (remote) file system, with the buffer\'s line ends', async () => {
		const t = setup();
		const m = await t.commands.writeFile({ file: 'out/copy.txt', lines: ['a', 'b'], whole: true, from: FILE });
		assert.deepStrictEqual([...t.log.written], [[`${REMOTE}/out/copy.txt`, 'a\r\nb\r\n']]);
		assert.strictEqual(m, '"copy.txt" [New] 2L, 6B written');
		// the buffer keeps its name and its editor
		assert.deepStrictEqual([t.log.saved, t.log.savedAs, t.log.replaced], [[], [], []]);
	});

	test('E13 when the file exists, unless !; E502 for a directory; :w {current file} is a save', async () => {
		const t = setup({ exists: [`${REMOTE}/x.txt`], dirs: [`${REMOTE}/src`] });
		await assert.rejects(t.commands.writeFile({ file: 'x.txt', lines: ['a'], whole: true, from: FILE }), /E13: File exists \(add ! to override\)/);
		assert.deepStrictEqual([...t.log.written], []);
		await t.commands.writeFile({ file: 'x.txt', lines: ['a'], whole: true, force: true, from: FILE });
		assert.deepStrictEqual([...t.log.written], [[`${REMOTE}/x.txt`, 'a\r\n']]);
		await assert.rejects(t.commands.writeFile({ file: 'src', lines: ['a'], whole: true, force: true, from: FILE }), /E502/);
		await t.commands.writeFile({ file: '%', lines: ['a'], whole: true, from: FILE });
		assert.deepStrictEqual(t.log.saved, [FILE]);
	});

	test(':w >> {file} appends (a new file too); without a file, to the current one', async () => {
		const t = setup({ contents: { [`${REMOTE}/log.txt`]: 'old' } });
		const m = await t.commands.writeFile({ file: 'log.txt', lines: ['x'], append: true, from: FILE });
		assert.strictEqual(t.log.written.get(`${REMOTE}/log.txt`), 'old\r\nx\r\n');
		assert.strictEqual(m, '"log.txt" 1L, 3B appended');
		await t.commands.writeFile({ file: 'n.txt', lines: ['y'], append: true, from: FILE });
		assert.strictEqual(t.log.written.get(`${REMOTE}/n.txt`), 'y\r\n');
	});

	test('an untitled buffer written whole takes the name, as :sav; without a name it is E32', async () => {
		const t = setup();
		await t.commands.writeFile({ file: 'named.txt', lines: ['a'], whole: true, from: 'untitled:Untitled-1' });
		assert.deepStrictEqual(t.log.savedAs, [['untitled:Untitled-1', `${REMOTE}/named.txt`]]);
		await assert.rejects(t.commands.writeFile({ file: '', lines: ['a'], whole: true, from: 'untitled:Untitled-1' }), /E32/);
	});

	test(':sav {file}: no dialog, E13 when it exists without !, the editor shows the new file', async () => {
		const t = setup({ exists: [`${REMOTE}/taken.ts`], activeEditor: URI.parse(FILE) });
		await assert.rejects(t.commands.saveAs({ file: 'taken.ts', from: FILE }), /E13/);
		await t.commands.saveAs({ file: 'src/vim/renamed.ts', from: FILE });
		assert.deepStrictEqual(t.log.savedAs, [[FILE, `${REMOTE}/src/vim/renamed.ts`]]);
		assert.deepStrictEqual(t.log.replaced.map(r => [r.editor, (r.replacement as { resource?: URI }).resource?.toString()]), [[t.active, `${REMOTE}/src/vim/renamed.ts`]]);
		await t.commands.saveAs({ file: 'taken.ts', force: true, from: FILE });
		assert.strictEqual(t.log.savedAs.length, 2);
		await assert.rejects(t.commands.saveAs({ file: 'src/*.ts', from: FILE }), /E77/);
	});

	test(':r {file}: its lines (a BOM and the last line end dropped), E484 when it cannot be read', async () => {
		const t = setup({ contents: { [`${REMOTE}/in.txt`]: '\uFEFFone\r\ntwo\n' } });
		assert.deepStrictEqual(await t.commands.readFile({ file: 'in.txt', from: FILE }), ['one', 'two']);
		await assert.rejects(t.commands.readFile({ file: 'nope.txt', from: FILE }), /E484: Can't open file nope.txt/);
	});
});
