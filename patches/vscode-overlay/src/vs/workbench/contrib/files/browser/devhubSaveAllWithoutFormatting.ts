/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: "File: Save All without Formatting". Upstream has Save All
// (`saveAll`) and Save without Formatting (`workbench.action.files.
// saveWithoutFormatting`, the active editor only) but not the two together.
// This is Save All with the second one's options: every dirty editor of every
// group, collected the way `saveAll` collects them (fileCommands.ts,
// saveDirtyEditorsOfGroups), saved with `skipSaveParticipants`, so no
// format-on-save, no fix-on-save, no trimmed whitespace. Dirty working copies
// no editor shows are saved as well. It opens, focuses and switches nothing.

import { ResourceSet } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { DirtyWorkingCopiesContext } from '../../../common/contextkeys.js';
import { EditorResourceAccessor, EditorsOrder, IEditorIdentifier, SaveReason, SideBySideEditor } from '../../../common/editor.js';
import { GroupsOrder, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, ISaveEditorsOptions } from '../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { WorkingCopyCapabilities } from '../../../services/workingCopy/common/workingCopy.js';

export const SAVE_ALL_WITHOUT_FORMATTING_COMMAND_ID = 'workbench.action.files.saveAllWithoutFormatting';

export async function saveAllWithoutFormatting(accessor: ServicesAccessor): Promise<void> {
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const editorService = accessor.get(IEditorService);
	const workingCopyService = accessor.get(IWorkingCopyService);
	const notificationService = accessor.get(INotificationService);

	const options: ISaveEditorsOptions = { reason: SaveReason.EXPLICIT, skipSaveParticipants: true };

	// Every dirty editor of every group, as `saveAll` does; and the resources
	// of all editors, dirty or not, to tell which working copies they show.
	const dirtyEditors: IEditorIdentifier[] = [];
	const shown = new ResourceSet();
	for (const group of editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
		for (const editor of group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
			if (editor.isDirty()) {
				dirtyEditors.push({ groupId: group.id, editor });
			}
			const resource = EditorResourceAccessor.getCanonicalUri(editor, { supportSideBySide: SideBySideEditor.BOTH });
			for (const uri of URI.isUri(resource) ? [resource] : [resource?.primary, resource?.secondary]) {
				if (uri) {
					shown.add(uri);
				}
			}
		}
	}

	// Dirty working copies no editor is open on (a file edited through the API
	// or left over from a closed editor). Untitled ones are left alone: saving
	// one asks for a location, and nothing on screen says which it is.
	const hidden = workingCopyService.dirtyWorkingCopies.filter(workingCopy =>
		!shown.has(workingCopy.resource) && !(workingCopy.capabilities & WorkingCopyCapabilities.Untitled));

	try {
		await editorService.save(dirtyEditors, options);
		await Promise.all(hidden.map(workingCopy => workingCopy.isDirty() ? workingCopy.save(options) : undefined));
	} catch (error) {
		notificationService.error(localize('devhubSaveAllError', "Failed to save: {0}", toErrorMessage(error, false)));
	}
}

class SaveAllWithoutFormattingAction extends Action2 {

	constructor() {
		super({
			id: SAVE_ALL_WITHOUT_FORMATTING_COMMAND_ID,
			title: localize2('saveAllWithoutFormatting', "Save All without Formatting"),
			category: Categories.File,
			f1: true,
			precondition: DirtyWorkingCopiesContext,
			menu: {
				id: MenuId.MenubarFileMenu,
				group: '4_save',
				order: 4
			}
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return saveAllWithoutFormatting(accessor);
	}
}

registerAction2(SaveAllWithoutFormattingAction);
