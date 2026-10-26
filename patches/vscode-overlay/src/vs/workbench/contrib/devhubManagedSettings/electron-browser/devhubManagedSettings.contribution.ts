/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the settings DevHub decides for every workbench, held in memory
// (apps/desktop/src/main/shell/workbenchManagedSettings.ts). Today that is the
// colour theme: DevHub reads the theme its own settings name and paints its
// chrome and Agent panes in it, so this workbench wears the same one. The
// values go into the MEMORY configuration target — above the user's and the
// folder's settings, and never written to a file — so the person's
// settings.json stays theirs and still cannot make the editor disagree with
// the window around it. Asked for as the workbench starts (before the theme
// service reads the configured theme, which waits for the extensions to be
// registered) and pushed again whenever DevHub's settings change.

import { equals } from '../../../../base/common/objects.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

const MANAGED_SETTINGS_CHANNEL = 'vscode:devhubManagedSettings';
const MANAGED_SETTINGS_REQUEST = 'vscode:devhubManagedSettingsRequest';

class DevhubManagedSettings implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.devhubManagedSettings';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
	) {
		ipcRenderer.on(MANAGED_SETTINGS_CHANNEL, (_event: unknown, ...args: unknown[]) => {
			const settings = args[0];
			if (typeof settings !== 'object' || settings === null) {
				return;
			}
			for (const [key, value] of Object.entries(settings)) {
				if (!equals(configurationService.inspect(key).memoryValue, value)) {
					void configurationService.updateValue(key, value, ConfigurationTarget.MEMORY);
				}
			}
		});
		ipcRenderer.send(MANAGED_SETTINGS_REQUEST);
	}
}

registerWorkbenchContribution2(DevhubManagedSettings.ID, DevhubManagedSettings, WorkbenchPhase.BlockStartup);
