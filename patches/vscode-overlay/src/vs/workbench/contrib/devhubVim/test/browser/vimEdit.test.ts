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
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
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
}

function setup(options: { exists?: string[]; dirs?: string[]; dirty?: string[]; activeEditor?: URI; folders?: URI[] } = {}) {
	const log: Log = { opened: [], replaced: [], commands: [], reverted: [] };
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
				throw new Error('not found');
			}
		},
		new class extends mock<IPathService>() { override userHome = (async () => HOME) as unknown as IPathService['userHome']; },
		new class extends mock<ITextFileService>() {
			override readonly files = {
				get: (resource: URI) => resource.scheme === 'untitled' ? undefined : {
					isDirty: () => dirty.has(resource.toString()),
					revert: async () => { log.reverted.push(resource.toString()); },
				} as unknown as ITextFileEditorModel,
			} as unknown as ITextFileService['files'];
		},
		new class extends mock<IWorkspaceContextService>() {
			override getWorkspace(): IWorkspace { return { id: 'w', folders } as unknown as IWorkspace; }
			override getWorkspaceFolder(resource: URI) { return folders.find(f => resource.toString().startsWith(f.uri.toString() + '/')) ?? null; }
		},
		new class extends mock<ICommandService>() {
			override async executeCommand(...args: unknown[]) { log.commands.push(args); return undefined; }
		},
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
