/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: a tidy editor after being away. When this workbench comes back on
// screen in DevHub after `devhub.workbench.tidyAfterAwayMinutes` (another
// Workspace or an Agent was shown instead), its panel and side bars are
// hidden and the keyboard goes to the active editor group, so it opens as a
// big, clean editor. "Away" is measured by DevHub's main process from its own
// layout (apps/desktop/src/main/shell/workbenchAbsence.ts) and arrives here as
// `_devhub.workbench.returned`: the window being in the background, or the
// keyboard being in the Agent of a split, is not being away. The same tidy is
// the command "DevHub: Tidy Editor Layout".

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts, SINGLE_WINDOW_PARTS } from '../../../services/layout/browser/layoutService.js';

export const TIDY_AFTER_AWAY_MINUTES_SETTING = 'devhub.workbench.tidyAfterAwayMinutes';
export const TIDY_PARTS_SETTING = 'devhub.workbench.tidyParts';
/** Raised by DevHub's main process over `vscode:runAction`; its argument is `{ awayMs }`. */
export const WORKBENCH_RETURNED_COMMAND = '_devhub.workbench.returned';
export const TIDY_LAYOUT_COMMAND = 'devhub.workbench.tidyLayout';

type TidyPart = 'panel' | 'sideBar' | 'auxiliaryBar';
const PARTS: Record<TidyPart, SINGLE_WINDOW_PARTS> = {
	auxiliaryBar: Parts.AUXILIARYBAR_PART,
	panel: Parts.PANEL_PART,
	sideBar: Parts.SIDEBAR_PART,
};
const DEFAULT_PARTS: TidyPart[] = ['panel', 'sideBar', 'auxiliaryBar'];

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		[TIDY_AFTER_AWAY_MINUTES_SETTING]: {
			type: 'number',
			default: 10,
			minimum: 0,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('devhub.workbench.tidyAfterAwayMinutes', "DevHub: when this editor comes back on screen after at least this many minutes of another Workspace or an Agent being shown instead, hide the parts in `#devhub.workbench.tidyParts#` and focus the editor. Only time spent on another DevHub page counts: DevHub being in the background, or the Agent of a split having the keyboard while the editor stays on screen, does not. `0` turns it off. The command **DevHub: Tidy Editor Layout** does the same at any time."),
		},
		[TIDY_PARTS_SETTING]: {
			type: 'array',
			items: { type: 'string', enum: DEFAULT_PARTS, enumDescriptions: [localize('devhub.workbench.tidyParts.panel', "The panel: the terminal, Problems, Output and so on."), localize('devhub.workbench.tidyParts.sideBar', "The primary side bar."), localize('devhub.workbench.tidyParts.auxiliaryBar', "The secondary side bar.")] },
			uniqueItems: true,
			default: DEFAULT_PARTS,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('devhub.workbench.tidyParts', "DevHub: what **DevHub: Tidy Editor Layout** and `#devhub.workbench.tidyAfterAwayMinutes#` hide."),
		},
	},
});

/** Hide the configured parts and put the keyboard in the active editor group (with or without an editor open). */
function tidy(accessor: ServicesAccessor): void {
	const configurationService = accessor.get(IConfigurationService);
	const layoutService = accessor.get(IWorkbenchLayoutService);
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const configured = configurationService.getValue<unknown>(TIDY_PARTS_SETTING);
	const parts = Array.isArray(configured) ? configured : DEFAULT_PARTS;
	for (const name of DEFAULT_PARTS) {
		if (parts.includes(name) && layoutService.isVisible(PARTS[name])) {
			layoutService.setPartHidden(true, PARTS[name]);
		}
	}
	editorGroupsService.activeGroup.focus();
}

CommandsRegistry.registerCommand(WORKBENCH_RETURNED_COMMAND, (accessor, arg?: { awayMs?: unknown }) => {
	const minutes = accessor.get(IConfigurationService).getValue<unknown>(TIDY_AFTER_AWAY_MINUTES_SETTING);
	const awayMs = arg?.awayMs;
	if (typeof minutes !== 'number' || !(minutes > 0) || typeof awayMs !== 'number') {
		return;
	}
	if (awayMs >= minutes * 60_000) {
		tidy(accessor);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TIDY_LAYOUT_COMMAND,
			title: localize2('devhub.workbench.tidyLayout', "DevHub: Tidy Editor Layout"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		tidy(accessor);
	}
});
