/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorIdentifier, SaveReason } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService, ISaveEditorsOptions } from '../../../../services/editor/common/editorService.js';
import { IWorkingCopy, WorkingCopyCapabilities } from '../../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { TestFileEditorInput } from '../../../../test/browser/workbenchTestServices.js';
import { SAVE_ALL_WITHOUT_FORMATTING_COMMAND_ID } from '../../browser/devhubSaveAllWithoutFormatting.js';
import '../../browser/fileCommands.js';

suite('File: Save All without Formatting', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function input(path: string, dirty: boolean): TestFileEditorInput {
		const editor = store.add(new TestFileEditorInput(URI.file(path), 'test.type'));
		editor.dirty = dirty;
		return editor;
	}

	function group(id: number, editors: EditorInput[]): IEditorGroup {
		return upcastPartial<IEditorGroup>({ id, getEditors: () => editors });
	}

	function workingCopy(path: string, dirty: boolean, calls: object[], capabilities = WorkingCopyCapabilities.None): IWorkingCopy {
		return upcastPartial<IWorkingCopy>({
			resource: URI.file(path),
			capabilities,
			isDirty: () => dirty,
			save: async options => { calls.push({ workingCopySave: path, options }); return true; }
		});
	}

	function run(groups: IEditorGroup[], workingCopies: IWorkingCopy[], calls: object[], saveError?: Error) {
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IEditorGroupsService, upcastPartial<IEditorGroupsService>({ getGroups: () => groups }));
		instantiation.stub(IEditorService, upcastPartial<IEditorService>({
			save: async (editors: IEditorIdentifier | IEditorIdentifier[], options?: ISaveEditorsOptions) => {
				calls.push({ editors: [editors].flat().map(({ groupId, editor }) => `${groupId}:${editor.resource?.path}`), options });
				if (saveError) {
					throw saveError;
				}
				return { success: true, editors: [] };
			}
		}));
		instantiation.stub(IWorkingCopyService, upcastPartial<IWorkingCopyService>({ dirtyWorkingCopies: workingCopies.filter(workingCopy => workingCopy.isDirty()) }));
		instantiation.stub(INotificationService, upcastPartial<INotificationService>({ error: message => { calls.push({ error: String(message) }); } }));
		return instantiation.invokeFunction(CommandsRegistry.getCommand(SAVE_ALL_WITHOUT_FORMATTING_COMMAND_ID)!.handler);
	}

	const options = { reason: SaveReason.EXPLICIT, skipSaveParticipants: true };

	test('saves the dirty editors of every group, and only those, without save participants', async () => {
		const calls: object[] = [];
		await run([
			group(1, [input('/w/a.ts', true), input('/w/clean.ts', false)]),
			group(2, [input('/w/b.ts', true), input('/w/a.ts', true)]),
		], [], calls);
		assert.deepStrictEqual(calls, [{ editors: ['1:/w/a.ts', '2:/w/b.ts', '2:/w/a.ts'], options }]);
	});

	test('saves dirty working copies no editor shows, once, with the same options', async () => {
		const calls: object[] = [];
		await run([group(1, [input('/w/open.ts', true), input('/w/open-clean.ts', false)])], [
			workingCopy('/w/open.ts', true, calls),
			workingCopy('/w/open-clean.ts', true, calls), // an editor shows it: that editor's save is not repeated here
			workingCopy('/w/hidden.ts', true, calls),
			workingCopy('/w/hidden-clean.ts', false, calls),
			workingCopy('/w/untitled', true, calls, WorkingCopyCapabilities.Untitled),
		], calls);
		assert.deepStrictEqual(calls, [
			{ editors: ['1:/w/open.ts'], options },
			{ workingCopySave: '/w/hidden.ts', options },
		]);
	});

	test('with nothing dirty, saves nothing and says nothing', async () => {
		const calls: object[] = [];
		await run([group(1, [input('/w/a.ts', false)])], [], calls);
		assert.deepStrictEqual(calls, [{ editors: [], options }]);
	});

	test('reports a failed save instead of rejecting', async () => {
		const calls: object[] = [];
		await run([group(1, [input('/w/a.ts', true)])], [], calls, new Error('disk full'));
		assert.deepStrictEqual(calls.slice(1), [{ error: 'Failed to save: disk full' }]);
	});

	test('is in the command palette under File and in the File menu after Save All', () => {
		const command = MenuRegistry.getCommand(SAVE_ALL_WITHOUT_FORMATTING_COMMAND_ID);
		assert.strictEqual(command?.category && (command.category as { value: string }).value, 'File');
		assert.ok(MenuRegistry.getMenuItems(MenuId.CommandPalette).some(item => 'command' in item && item.command.id === SAVE_ALL_WITHOUT_FORMATTING_COMMAND_ID));
		// Save All is `4_save` order 3 (fileActions.contribution.ts)
		const item = MenuRegistry.getMenuItems(MenuId.MenubarFileMenu).find(item => 'command' in item && item.command.id === SAVE_ALL_WITHOUT_FORMATTING_COMMAND_ID);
		assert.deepStrictEqual(item && { group: item.group, order: item.order }, { group: '4_save', order: 4 });
	});
});
