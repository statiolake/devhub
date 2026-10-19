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
import { EndOfLineSequence, ITextModel, ITextSnapshot } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileContent, IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService, IUntypedEditorReplacement } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { EncodingMode, ITextFileContent, ITextFileEditorModel, ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { SUPPORTED_ENCODINGS } from '../../../../services/textfile/common/encoding.js';
import { VimFileCommands } from '../../browser/vimEdit.js';
import { vimEncodingId, vimEncodingList } from '../../common/vimEx.js';
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
	/** `setEncoding` on a text file model: [file, encoding, mode]; on an untitled one the mode is 'untitled'. */
	encoded: [string, string, EncodingMode | 'untitled'][];
	/** Files written through the text file service: [file, text, encoding]. */
	writtenWith: [string, string, string | undefined][];
	/** Files read through the text file service: [file, encoding]. */
	readWith: [string, string | undefined][];
	/** `pushEOL` on the model, and the stack elements around it. */
	eol: (EndOfLineSequence | 'stop')[];
}

function setup(options: { exists?: string[]; dirs?: string[]; dirty?: string[]; activeEditor?: URI; folders?: URI[]; contents?: Record<string, string>; encodings?: Record<string, string> } = {}) {
	const log: Log = { opened: [], replaced: [], commands: [], reverted: [], written: new Map(), saved: [], savedAs: [], encoded: [], writtenWith: [], readWith: [], eol: [] };
	const encodings = new Map(Object.entries(options.encodings ?? {}));
	let lineEnds = EndOfLineSequence.CRLF;
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
					isResolved: () => true,
					revert: async () => { log.reverted.push(resource.toString()); dirty.delete(resource.toString()); },
					getEncoding: () => encodings.get(resource.toString()) ?? 'utf8',
					setEncoding: async (encoding: string, mode: EncodingMode) => {
						if (mode === EncodingMode.Decode && dirty.has(resource.toString())) {
							throw new Error('Cannot re-open a dirty text document with different encoding. Save it first.');
						}
						log.encoded.push([resource.toString(), encoding, mode]);
						encodings.set(resource.toString(), encoding);
						if (mode === EncodingMode.Encode) {
							dirty.add(resource.toString());
						}
					},
				} as unknown as ITextFileEditorModel,
			} as unknown as ITextFileService['files'];
			override readonly untitled = {
				get: (resource: URI) => resource.scheme !== 'untitled' ? undefined : {
					getEncoding: () => encodings.get(resource.toString()) ?? 'utf8',
					setEncoding: async (encoding: string) => { log.encoded.push([resource.toString(), encoding, 'untitled']); encodings.set(resource.toString(), encoding); },
				},
			} as unknown as ITextFileService['untitled'];
			override getEncoding(resource: URI) { return encodings.get(resource.toString()) ?? 'utf8'; }
			override async read(resource: URI, options?: { encoding?: string }) {
				log.readWith.push([resource.toString(), options?.encoding]);
				return { value: contents.get(resource.toString()) ?? log.written.get(resource.toString()) ?? '' } as unknown as ITextFileContent;
			}
			override async write(resource: URI, value: string | ITextSnapshot, options?: { encoding?: string }) {
				log.writtenWith.push([resource.toString(), value as string, options?.encoding]);
				log.written.set(resource.toString(), value as string);
				return { size: (value as string).length } as IFileStatWithMetadata;
			}
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
			override getModel(resource: URI) {
				return resource.toString() === FILE ? {
					getEOL: () => lineEnds === EndOfLineSequence.CRLF ? '\r\n' : '\n', getLineCount: () => 2, getValue: () => 'a\r\nb',
					getEndOfLineSequence: () => lineEnds,
					pushStackElement: () => { log.eol.push('stop'); },
					pushEOL: (eol: EndOfLineSequence) => { log.eol.push(eol); lineEnds = eol; },
				} as unknown as ITextModel : null;
			}
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

suite('DevHub Vim: file encodings and line endings are VS Code\'s', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const KEYS = `${REMOTE}/src/a.ts`;

	test(':e ++enc={enc} is "Reopen with Encoding" (setEncoding, Decode); the same encoding just reads the file again', async () => {
		const t = setup();
		await t.commands.edit({ file: '++enc=cp932', from: FILE });
		assert.deepStrictEqual(t.log.encoded, [[FILE, 'shiftjis', EncodingMode.Decode]]);
		assert.deepStrictEqual(t.log.reverted, []);
		await t.commands.edit({ file: '++encoding=sjis', from: FILE });
		assert.deepStrictEqual([t.log.encoded.length, t.log.reverted], [1, [FILE]]);
		await t.commands.edit({ file: '++enc=euc-jp', bang: false, from: FILE });
		assert.deepStrictEqual(t.log.encoded.slice(-1), [[FILE, 'eucjp', EncodingMode.Decode]]);
	});

	test('a modified file is E37 for :e ++enc=, and :e! ++enc= reverts it first (VS Code cannot decode a modified file)', async () => {
		const t = setup({ dirty: [FILE] });
		await assert.rejects(t.commands.edit({ file: '++enc=latin1', from: FILE }), /E37: No write since last change/);
		assert.deepStrictEqual([t.log.encoded, t.log.reverted], [[], []]);
		await t.commands.edit({ file: '++enc=latin1', bang: true, from: FILE });
		assert.deepStrictEqual(t.log.reverted, [FILE]);
		assert.deepStrictEqual(t.log.encoded, [[FILE, 'iso88591', EncodingMode.Decode]]);
	});

	test(':e ++enc={enc} {file} opens that file with the encoding (the editor input\'s encoding); one that is open is reopened with it', async () => {
		const t = setup({ exists: [KEYS] });
		await t.commands.edit({ file: '++enc=euc-jp src/a.ts', from: FILE });
		assert.deepStrictEqual(t.log.opened.map(o => [(o.input as { resource: URI }).resource.toString(), (o.input as { encoding?: string }).encoding]), [[KEYS, 'eucjp']]);
		// open already (with another encoding): the editor service keeps it, so it is decoded again
		assert.deepStrictEqual(t.log.encoded, [[KEYS, 'eucjp', EncodingMode.Decode]]);
		// already in that encoding: nothing to decode again
		const same = setup({ exists: [KEYS], encodings: { [KEYS]: 'eucjp' } });
		await same.commands.edit({ file: '++enc=eucjp src/a.ts', from: FILE });
		assert.deepStrictEqual([same.log.encoded, same.log.reverted], [[], []]);
		// blanks around the ++ words
		const sp = setup({ exists: [KEYS] });
		await sp.commands.edit({ file: '  ++enc=sjis   src/a.ts', from: FILE });
		assert.strictEqual((sp.log.opened[0].input as { encoding?: string }).encoding, 'shiftjis');
		// a new file: untitled, with the encoding
		const fresh = setup();
		await fresh.commands.edit({ file: '++enc=latin1 new.txt', from: FILE });
		assert.deepStrictEqual(fresh.log.opened.map(o => [(o.input as { forceUntitled?: boolean }).forceUntitled, (o.input as { encoding?: string }).encoding]), [[true, 'iso88591']]);
		// :sp / :tabe
		const split = setup({ exists: [KEYS] });
		await split.commands.open({ file: '++enc=gbk src/a.ts', from: FILE });
		assert.strictEqual((split.log.opened[0].input as { encoding?: string }).encoding, 'gbk');
	});

	test(':e ++ff={unix|dos} sets the line endings (one undo step) after the file is read; the file name is what follows', async () => {
		const t = setup({ exists: [KEYS] });
		await t.commands.edit({ file: '++ff=unix', from: FILE });
		assert.deepStrictEqual([t.log.reverted, t.log.eol], [[FILE], ['stop', EndOfLineSequence.LF, 'stop']]);
		// already in that format: nothing
		await t.commands.edit({ file: '++fileformat=unix', from: FILE });
		assert.deepStrictEqual(t.log.eol.length, 3);
		await t.commands.edit({ file: '++ff=dos', from: FILE });
		assert.deepStrictEqual(t.log.eol.slice(3), ['stop', EndOfLineSequence.CRLF, 'stop']);
	});

	test('++opt errors: an encoding VS Code does not know, ++ff=mac, ++bin and a missing value are E474', async () => {
		const t = setup();
		await assert.rejects(t.commands.edit({ file: '++enc=klingon', from: FILE }), /E474: Invalid argument: \+\+enc=klingon/);
		await assert.rejects(t.commands.edit({ file: '++ff=mac x', from: FILE }), /E474: Invalid argument: \+\+ff=mac \(VS Code has no CR line endings\)/);
		await assert.rejects(t.commands.edit({ file: '++ff=weird', from: FILE }), /E474/);
		await assert.rejects(t.commands.edit({ file: '++bin x', from: FILE }), /E474: Invalid argument: \+\+bin \(not supported\)/);
		await assert.rejects(t.commands.edit({ file: '++enc', from: FILE }), /E474/);
		await assert.rejects(t.commands.open({ file: '++enc=nope x', from: FILE }), /E474/);
		assert.deepStrictEqual([t.log.encoded, t.log.opened, t.log.reverted], [[], [], []]);
	});

	test(':set fenc= is "Save with Encoding" (setEncoding, Encode: the file is modified and VS Code saves it); fenc? shows VS Code\'s id', async () => {
		const t = setup();
		assert.deepStrictEqual(await t.commands.fileOptions({ options: [{ option: 'fileencoding' }], from: FILE }), ['fileencoding=utf8']);
		assert.deepStrictEqual(await t.commands.fileOptions({ options: [{ option: 'fileencoding', value: 'shiftjis' }], from: FILE }), []);
		assert.deepStrictEqual(t.log.encoded, [[FILE, 'shiftjis', EncodingMode.Encode]]);
		assert.deepStrictEqual(await t.commands.fileOptions({ options: [{ option: 'fileencoding' }], from: FILE }), ['fileencoding=shiftjis']);
		// the encoding it has already: nothing is saved again
		await t.commands.fileOptions({ options: [{ option: 'fileencoding', value: 'shiftjis' }], from: FILE });
		assert.strictEqual(t.log.encoded.length, 1);
		// an untitled buffer has an encoding too
		await t.commands.fileOptions({ options: [{ option: 'fileencoding', value: 'utf16le' }], from: 'untitled:Untitled-1' });
		assert.deepStrictEqual(t.log.encoded.slice(-1), [['untitled:Untitled-1', 'utf16le', 'untitled']]);
	});

	test(':set bomb / nobomb / invbomb are UTF-8 and UTF-8 with BOM; UTF-16 always has one; others cannot', async () => {
		const t = setup();
		const bomb = (value?: boolean | 'toggle') => t.commands.fileOptions({ options: [value === undefined ? { option: 'bomb' } : { option: 'bomb', value }], from: FILE });
		assert.deepStrictEqual(await bomb(), ['nobomb']);
		await bomb(true);
		assert.deepStrictEqual(t.log.encoded, [[FILE, 'utf8bom', EncodingMode.Encode]]);
		assert.deepStrictEqual(await bomb(), ['bomb']);
		await bomb(true);
		assert.strictEqual(t.log.encoded.length, 1);
		await bomb('toggle');
		assert.deepStrictEqual(t.log.encoded.slice(-1), [[FILE, 'utf8', EncodingMode.Encode]]);
		await bomb(false);
		assert.strictEqual(t.log.encoded.length, 2);
		const utf16 = setup({ encodings: { [FILE]: 'utf16be' } });
		assert.deepStrictEqual(await utf16.commands.fileOptions({ options: [{ option: 'bomb' }], from: FILE }), ['bomb']);
		await assert.rejects(utf16.commands.fileOptions({ options: [{ option: 'bomb', value: false }], from: FILE }), /E474: Invalid argument: nobomb/);
		const sjis = setup({ encodings: { [FILE]: 'shiftjis' } });
		await assert.rejects(sjis.commands.fileOptions({ options: [{ option: 'bomb', value: true }], from: FILE }), /E474: Invalid argument: bomb/);
		assert.deepStrictEqual([utf16.log.encoded, sjis.log.encoded], [[], []]);
	});

	test(':set ff= is "Change End of Line Sequence" (pushEOL between two undo stops); ff? shows it', async () => {
		const t = setup();
		assert.deepStrictEqual(await t.commands.fileOptions({ options: [{ option: 'fileformat' }], from: FILE }), ['fileformat=dos']);
		await t.commands.fileOptions({ options: [{ option: 'fileformat', value: 'unix' }], from: FILE });
		assert.deepStrictEqual(t.log.eol, ['stop', EndOfLineSequence.LF, 'stop']);
		assert.deepStrictEqual(await t.commands.fileOptions({ options: [{ option: 'fileformat' }], from: FILE }), ['fileformat=unix']);
		await t.commands.fileOptions({ options: [{ option: 'fileformat', value: 'unix' }], from: FILE });
		assert.strictEqual(t.log.eol.length, 3);
		// several at once, shown ones in order
		assert.deepStrictEqual(await t.commands.fileOptions({ options: [{ option: 'fileformat', value: 'dos' }, { option: 'fileformat' }, { option: 'bomb' }], from: FILE }), ['fileformat=dos', 'nobomb']);
	});

	test(':w ++enc={enc} is a save with that encoding; :w ++enc={enc} {file} and :w >> write it through the text file service', async () => {
		const t = setup({ contents: { [`${REMOTE}/old.txt`]: 'old' } });
		await t.commands.writeFile({ file: '', enc: 'shiftjis', lines: ['a'], whole: true, from: FILE });
		assert.deepStrictEqual(t.log.encoded, [[FILE, 'shiftjis', EncodingMode.Encode]]);
		assert.deepStrictEqual(t.log.saved, []);
		// the encoding it has already: a plain save
		await t.commands.writeFile({ file: '', enc: 'shiftjis', lines: ['a'], whole: true, from: FILE });
		assert.deepStrictEqual([t.log.encoded.length, t.log.saved], [1, [FILE]]);
		const m = await t.commands.writeFile({ file: 'out.txt', enc: 'eucjp', lines: ['あ'], whole: true, from: FILE });
		assert.deepStrictEqual(t.log.writtenWith, [[`${REMOTE}/out.txt`, 'あ\r\n', 'eucjp']]);
		assert.strictEqual(m, '"out.txt" [New] 1L, 3B written');
		await t.commands.writeFile({ file: 'old.txt', enc: 'eucjp', append: true, lines: ['x'], from: FILE });
		assert.deepStrictEqual(t.log.readWith, [[`${REMOTE}/old.txt`, 'eucjp']]);
		assert.deepStrictEqual(t.log.writtenWith.slice(-1), [[`${REMOTE}/old.txt`, 'old\r\nx\r\n', 'eucjp']]);
		// without an encoding the file service writes UTF-8 as before
		await t.commands.writeFile({ file: 'plain.txt', lines: ['a'], whole: true, from: FILE });
		assert.strictEqual(t.log.writtenWith.length, 2);
	});

	test(':w ++ff={unix|dos} {file} writes with those line ends; without a file the buffer takes them first', async () => {
		const t = setup();
		await t.commands.writeFile({ file: 'u.txt', ff: 'unix', lines: ['a', 'b'], whole: true, from: FILE });
		assert.strictEqual(t.log.written.get(`${REMOTE}/u.txt`), 'a\nb\n');
		assert.deepStrictEqual(t.log.eol, []);
		await t.commands.writeFile({ file: '', ff: 'unix', lines: ['a'], whole: true, from: FILE });
		assert.deepStrictEqual([t.log.eol, t.log.saved], [['stop', EndOfLineSequence.LF, 'stop'], [FILE]]);
	});

	test(':sav ++enc={enc} {file} saves as that file, then with the encoding; :r ++enc={enc} {file} decodes it', async () => {
		const t = setup({ activeEditor: URI.parse(FILE) });
		await t.commands.saveAs({ file: 'src/vim/copy.ts', enc: 'gbk', from: FILE });
		assert.deepStrictEqual(t.log.savedAs, [[FILE, `${REMOTE}/src/vim/copy.ts`]]);
		assert.deepStrictEqual(t.log.encoded, [[`${REMOTE}/src/vim/copy.ts`, 'gbk', EncodingMode.Encode]]);
		const r = setup({ contents: { [`${REMOTE}/in.txt`]: 'one\ntwo\n' } });
		assert.deepStrictEqual(await r.commands.readFile({ file: 'in.txt', enc: 'shiftjis', from: FILE }), ['one', 'two']);
		assert.deepStrictEqual(r.log.readWith, [[`${REMOTE}/in.txt`, 'shiftjis']]);
	});
});

suite('DevHub Vim: the encodings are the ones VS Code has', () => {

	test('the list is SUPPORTED_ENCODINGS: the same ids, in order, with its labels; each id is its own name', () => {
		assert.deepStrictEqual(vimEncodingList(), Object.entries(SUPPORTED_ENCODINGS).map(([id, e]) => ({ id, label: e.labelLong })));
		for (const id of Object.keys(SUPPORTED_ENCODINGS)) {
			assert.strictEqual(vimEncodingId(id), id);
		}
	});
});
