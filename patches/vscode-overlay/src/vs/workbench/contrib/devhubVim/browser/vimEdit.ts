/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: `:e {file}` and the other commands that take a file name
// (`:sp` `:vs` `:new` `:vne` `:tabe` `:tabnew`), as two VS Code commands the
// ex table (common/vimEx.ts BUILTIN_EX_COMMANDS) runs and that
// `devhub.vim.exCommands` can run too:
//
//   devhubVim.edit { file, bang }            Vim's `:e[!] [file]`: the file in the
//                                            active group; without one the current
//                                            file is read again (E37 when it is
//                                            modified, `!` discards the changes)
//   devhubVim.open { file, replace?, untitled? }
//                                            the file in the active group;
//                                            `replace`: instead of its active
//                                            editor (the copy a split just made);
//                                            `untitled`: no file, a new untitled one
//
// The argument is resolved as Vim does (common/vimEx.ts resolveExFileArg):
// relative to the current directory, which is the workspace folder of the file
// the command came from (the first folder when it is in none; the file's own
// directory, then the home directory, without a workspace), `/` absolute, `~`,
// `%` and `%:h`. Paths are in the workspace's file system: a remote
// workspace's folder URI with the path put in, never a local path. A file
// that does not exist opens as a new untitled file for that path (Vim's new
// buffer): saving it writes it there. A name with `*` opens quick open with it.
//
// `from` (the URI of the editor an ex line ran in) is put in by the Vim
// editor that runs the command (devhubVim.contribution.ts), so `%` and the
// workspace folder are the ones of that editor even after a split moved the
// focus; without it (a keybinding) the active editor is used.
//
// The engine's `:w {file}` `:w >> {file}` `:sav {file}` `:r {file}`
// (vimEngine.ts exWrite, exSaveAs, exRead) write and read through three
// internal commands here, on the same resolution and the workspace's file
// system (IFileService), without a dialog:
//
//   _devhubVim.writeFile { file, lines, append, force, whole }
//                                            the lines to the file (E13 when it
//                                            exists, without force); `>>`
//                                            appends; the current file itself
//                                            is saved; an untitled buffer
//                                            written whole takes the name
//                                            (as `:sav`)
//   _devhubVim.saveAs { file, force }        `:sav`: the buffer written there
//                                            (E13 without force), its editor
//                                            replaced by the file's, the old
//                                            file left as it was on disk
//   _devhubVim.readFile { file }             the file's lines (E484)

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname, isEqual, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorResourceAccessor, IUntypedEditorInput, SideBySideEditor } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { ExFileArg, ExFileContext, resolveExFileArg } from '../common/vimEx.js';

export const VIM_EDIT_COMMANDS = ['devhubVim.edit', 'devhubVim.open', '_devhubVim.writeFile', '_devhubVim.saveAs', '_devhubVim.readFile'] as const;

/** Where a file argument resolves, for one command. */
export interface VimFileBase {
	/** The current directory. */
	readonly cwd: URI;
	readonly ctx: ExFileContext;
}

/**
 * Vim's current directory for `current`: its workspace folder, the first
 * folder, its own directory, the home directory. `%` is `current` when it
 * is a file there (same file system); `~` the home directory there.
 * (The `:` prompt's file completion resolves the directory typed the same way.)
 */
export async function resolveFileBase(workspaceService: IWorkspaceContextService, pathService: IPathService, current: URI | undefined): Promise<VimFileBase> {
	const folders = workspaceService.getWorkspace().folders;
	const folder = (current && workspaceService.getWorkspaceFolder(current)) ?? folders[0];
	const home = await pathService.userHome().catch(() => undefined);
	const named = current && current.scheme !== Schemas.untitled ? current : undefined;
	const cwd = folder?.uri ?? (named ? dirname(named) : home);
	if (!cwd) {
		throw new Error('E32: No file name');
	}
	const sameFs = (u: URI | undefined) => !!u && u.scheme === cwd.scheme && u.authority === cwd.authority;
	return {
		cwd,
		ctx: {
			cwd: cwd.path,
			...(sameFs(named) ? { current: named!.path } : {}),
			...(sameFs(home) ? { home: home!.path } : {}),
		},
	};
}

/** What `devhubVim.edit` and `devhubVim.open` do, on the workbench's services. */
export class VimFileCommands {

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IModelService private readonly modelService: IModelService,
		@ILabelService private readonly labelService: ILabelService,
	) { }

	/** The file the command is for: `from`, or the active editor's. */
	current(from: unknown): URI | undefined {
		if (typeof from === 'string' && from) {
			return URI.parse(from);
		}
		if (URI.isUri(from)) {
			return from;
		}
		return EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
	}

	/** Vim's current directory for `current` (see resolveFileBase). */
	base(current: URI | undefined): Promise<VimFileBase> {
		return resolveFileBase(this.workspaceService, this.pathService, current);
	}

	/** The argument resolved: a resource, a quick open pattern, or undefined for none. Vim's errors are thrown. */
	async resolve(file: unknown, current: URI | undefined): Promise<{ resource: URI; base: VimFileBase } | { glob: string } | undefined> {
		if (typeof file !== 'string' || !file.trim()) {
			return undefined;
		}
		const base = await this.base(current);
		const r: ExFileArg = resolveExFileArg(file, base.ctx)!;
		if ('error' in r) {
			throw new Error(r.error);
		}
		if ('glob' in r) {
			return r;
		}
		return { resource: base.cwd.with({ path: r.path, query: '', fragment: '' }), base };
	}

	/** `:e[!] [file]`. */
	async edit(args: unknown): Promise<void> {
		const a = record(args);
		const current = this.current(a.from);
		const r = await this.resolve(a.file, current);
		if (r === undefined) {
			await this.reload(current, a.bang === true);
		} else if ('glob' in r) {
			await this.quickOpen(r.glob);
		} else {
			await this.openResource(r.resource, r.base, false);
		}
	}

	/** `:sp [file]` (after the split), `:new`, `:tabe [file]`. */
	async open(args: unknown): Promise<void> {
		const a = record(args);
		const r = await this.resolve(a.file, this.current(a.from));
		const replace = a.replace === true;
		if (r === undefined) {
			if (a.untitled === true) {
				if (replace && this.editorGroupsService.activeGroup.activeEditor) {
					await this.place({ resource: undefined, forceUntitled: true, options: { pinned: true } }, true);
				} else {
					await this.commandService.executeCommand('workbench.action.files.newUntitledFile');
				}
			}
		} else if ('glob' in r) {
			await this.quickOpen(r.glob);
		} else {
			await this.openResource(r.resource, r.base, replace);
		}
	}

	/** Vim's `:e` without a name: read the file again; modified, only with `!` (which drops the changes). */
	private async reload(current: URI | undefined, bang: boolean): Promise<void> {
		if (!current || current.scheme === Schemas.untitled) {
			throw new Error('E32: No file name');
		}
		const model = this.textFileService.files.get(current);
		if (!model) {
			return; // not a text file of a file system (a diff, an output): nothing to read again
		}
		if (model.isDirty() && !bang) {
			throw new Error('E37: No write since last change (add ! to override)');
		}
		await model.revert();
	}

	private async openResource(resource: URI, base: VimFileBase, replace: boolean): Promise<void> {
		let stat: { readonly isDirectory: boolean } | undefined;
		try {
			stat = await this.fileService.stat(resource);
		} catch {
			stat = undefined; // a new file
		}
		if (stat?.isDirectory) {
			// no file browser here: quick open in that directory
			const rel = relativePath(base.cwd, resource);
			await this.quickOpen(rel !== undefined ? (rel ? rel + '/' : '') : resource.path + '/');
			return;
		}
		const input: IUntypedEditorInput = stat
			? { resource, options: { pinned: true } }
			// Vim's new buffer for that name: untitled, and saving writes it there
			: { resource, forceUntitled: true, options: { pinned: true } };
		await this.place(input, replace);
	}

	/** In the active group; `replace`: in place of its active editor (unless that is the file already). */
	private async place(input: IUntypedEditorInput, replace: boolean): Promise<void> {
		const group = this.editorGroupsService.activeGroup;
		const active = group.activeEditor;
		const resource = (input as { resource?: URI }).resource;
		if (replace && active && !(resource && isEqual(EditorResourceAccessor.getOriginalUri(active), resource))) {
			await this.editorService.replaceEditors([{ editor: active, replacement: input }], group);
			return;
		}
		await this.editorService.openEditor(input, group);
	}

	private async quickOpen(text: string): Promise<void> {
		await this.commandService.executeCommand('workbench.action.quickOpen', text);
	}

	/** A file argument that must name one file (`:w` `:sav` `:r`): its resource, or Vim's error. */
	private async target(file: unknown, current: URI | undefined): Promise<URI> {
		const r = await this.resolve(file, current);
		if (r === undefined) {
			throw new Error('E32: No file name');
		}
		if ('glob' in r) {
			throw new Error('E77: Too many file names');
		}
		return r.resource;
	}

	/** Vim's "written" line: `"name" [New] 3L, 42B written`. */
	private written(resource: URI, lines: number, bytes: number, isNew: boolean, verb: string): string {
		return `"${this.labelService.getUriLabel(resource, { relative: true })}"${isNew ? ' [New]' : ''} ${lines}L, ${bytes}B ${verb}`;
	}

	/** `:[range]w[!] [>>] [file]`: see the comment at the top. Returns the message. */
	async writeFile(args: unknown): Promise<string> {
		const a = record(args);
		const current = this.current(a.from);
		const lines = Array.isArray(a.lines) ? a.lines.map(String) : [];
		const append = a.append === true;
		const force = a.force === true;
		const whole = a.whole === true;
		const named = typeof a.file === 'string' && a.file.trim() !== '';
		if (!named && (!current || current.scheme === Schemas.untitled)) {
			throw new Error('E32: No file name');
		}
		const resource = named ? await this.target(a.file, current) : current!;
		const isCurrent = !!current && isEqual(resource, current);
		if (isCurrent && whole && !append) {
			await this.textFileService.save(resource, { force: true });
			return this.written(resource, lines.length, VSBuffer.fromString(lines.join('\n') + '\n').byteLength, false, 'written');
		}
		let stat: { readonly isDirectory: boolean } | undefined;
		try {
			stat = await this.fileService.stat(resource);
		} catch {
			stat = undefined;
		}
		if (stat?.isDirectory) {
			throw new Error(`E502: "${this.labelService.getUriLabel(resource, { relative: true })}" is a directory`);
		}
		if (stat && !append && !force && !isCurrent) {
			throw new Error('E13: File exists (add ! to override)');
		}
		if (!append && whole && current?.scheme === Schemas.untitled) {
			// a buffer with no name takes the name it is written to, as `:sav`
			await this.saveAs({ file: a.file, force, from: current.toString() });
			return this.written(resource, lines.length, VSBuffer.fromString(lines.join('\n') + '\n').byteLength, !stat, 'written');
		}
		const eol = (current && this.modelService.getModel(current)?.getEOL()) || '\n';
		let text = lines.join(eol) + eol;
		if (append && stat) {
			const before = (await this.fileService.readFile(resource)).value.toString();
			text = before + (before && !before.endsWith('\n') ? eol : '') + text;
		}
		try {
			await this.fileService.writeFile(resource, VSBuffer.fromString(text));
		} catch (e) {
			throw new Error(`E212: Can't open file for writing: ${e instanceof Error ? e.message : String(e)}`);
		}
		return this.written(resource, lines.length, VSBuffer.fromString(lines.join(eol) + eol).byteLength, !stat, append ? 'appended' : 'written');
	}

	/** `:sav[!] {file}`: see the comment at the top. */
	async saveAs(args: unknown): Promise<string> {
		const a = record(args);
		const current = this.current(a.from);
		if (!current) {
			throw new Error('E32: No file name');
		}
		const resource = await this.target(a.file, current);
		if (!isEqual(resource, current) && a.force !== true && await this.fileService.exists(resource)) {
			throw new Error('E13: File exists (add ! to override)');
		}
		const saved = await this.textFileService.saveAs(current, resource);
		if (!saved) {
			throw new Error(`E212: Can't open file for writing: ${this.labelService.getUriLabel(resource, { relative: true })}`);
		}
		// the editors of the old buffer show the new file now (the old one is reverted, as saveAs leaves it)
		if (!isEqual(saved, current)) {
			for (const { editor, groupId } of this.editorService.findEditors(current)) {
				await this.editorService.replaceEditors([{ editor, replacement: { resource: saved, options: { pinned: true } } }], groupId);
			}
		}
		const model = this.modelService.getModel(saved);
		return this.written(saved, model?.getLineCount() ?? 0, model ? VSBuffer.fromString(model.getValue()).byteLength : 0, false, 'written');
	}

	/** `:r {file}`: the file's lines. */
	async readFile(args: unknown): Promise<string[]> {
		const a = record(args);
		const current = this.current(a.from);
		const resource = typeof a.file === 'string' && a.file.trim() ? await this.target(a.file, current) : current;
		if (!resource || resource.scheme === Schemas.untitled) {
			throw new Error('E32: No file name');
		}
		let text: string;
		try {
			text = (await this.fileService.readFile(resource)).value.toString();
		} catch {
			throw new Error(`E484: Can't open file ${typeof a.file === 'string' ? a.file.trim() : ''}`);
		}
		text = text.replace(/^\uFEFF/, '');
		const lines = text.split(/\r?\n/);
		if (lines.length > 1 && lines[lines.length - 1] === '') {
			lines.pop();
		}
		return lines;
	}
}

function record(args: unknown): Record<string, unknown> {
	return typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
}

CommandsRegistry.registerCommand({
	id: 'devhubVim.edit',
	handler: (accessor, args: unknown) => accessor.get(IInstantiationService).createInstance(VimFileCommands).edit(args),
	metadata: {
		description: localize('devhubVim.cmd.edit', "Vim: `:e[!] [file]` { file?, bang? }: open the file (relative to the workspace folder; `~`, `%`, `%:h`; a new file when it does not exist; quick open for `*`); without one read the current file again (E37 when modified unless bang)"),
		args: [{ name: 'args', isOptional: true, schema: { type: 'object' } }],
	},
});

for (const [id, run] of [
	['_devhubVim.writeFile', (c: VimFileCommands, args: unknown) => c.writeFile(args)],
	['_devhubVim.saveAs', (c: VimFileCommands, args: unknown) => c.saveAs(args)],
	['_devhubVim.readFile', (c: VimFileCommands, args: unknown) => c.readFile(args)],
] as const) {
	CommandsRegistry.registerCommand(id, (accessor, args: unknown) => run(accessor.get(IInstantiationService).createInstance(VimFileCommands), args));
}

CommandsRegistry.registerCommand({
	id: 'devhubVim.open',
	handler: (accessor, args: unknown) => accessor.get(IInstantiationService).createInstance(VimFileCommands).open(args),
	metadata: {
		description: localize('devhubVim.cmd.open', "Vim: open { file?, replace?, untitled? } in the active group, as `:sp {file}` after the split (replace: instead of the copy the split made) or `:tabe {file}`; without a file nothing, or a new untitled file with untitled"),
		args: [{ name: 'args', isOptional: true, schema: { type: 'object' } }],
	},
});
