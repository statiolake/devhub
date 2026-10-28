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
// the window around it.
//
// From the first frame (apps/desktop/src/main/shell/workbenchStartTheme.ts).
// The theme service reads the configured theme in its constructor, to decide
// whether the theme it cached last time is still the one to show until the
// theme's file is read; it is constructed while the workbench lays itself out,
// before any contribution runs and long before an answer to a question could
// arrive. Asked for only then, the settings were still the person's own (or
// VS Code's default) at that moment, DevHub's cached theme was thrown away,
// and every load painted the default theme first. So main puts the values on
// the window configuration, which the renderer has before any of the
// workbench is loaded, and `DevhubWorkbenchThemeService` writes them into the
// memory configuration as the theme service is constructed, before upstream's
// constructor reads them. The theme's own colours come the same way, for a
// workbench with nothing cached in that theme — upstream's
// `initialColorTheme`, which an embedder of the web workbench uses for exactly
// this.
//
// After that, main pushes the values again whenever DevHub's settings or the
// appearance change, and this contribution asks once (which is also how main
// learns to tell this workbench).

import { equals } from '../../../../base/common/objects.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { context, ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IHostColorSchemeService } from '../../../services/themes/common/hostColorSchemeService.js';
import { IUserDataInitializationService } from '../../../services/userData/browser/userDataInit.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { WorkbenchThemeService } from '../../../services/themes/browser/workbenchThemeService.js';

const MANAGED_SETTINGS_CHANNEL = 'vscode:devhubManagedSettings';
const MANAGED_SETTINGS_REQUEST = 'vscode:devhubManagedSettingsRequest';

type InitialColorTheme = NonNullable<NonNullable<IBrowserWorkbenchEnvironmentService['options']>['initialColorTheme']>;

/** The fields main adds to the window configuration (`withWorkbenchStart`). */
interface WorkbenchStartConfiguration {
	readonly devhubManagedSettings?: unknown;
	readonly devhubInitialColorTheme?: InitialColorTheme;
}

function workbenchStart(): WorkbenchStartConfiguration | undefined {
	// The configuration is resolved before the workbench is imported
	// (`workbench.ts`, `load`), so it is there by the time anything runs.
	return context?.configuration() as WorkbenchStartConfiguration | undefined;
}

/** Hold `settings` in the memory configuration, writing only what changed. */
function applyManagedSettings(configurationService: IConfigurationService, settings: unknown): void {
	if (typeof settings !== 'object' || settings === null) {
		return;
	}
	for (const [key, value] of Object.entries(settings)) {
		if (!equals(configurationService.inspect(key).memoryValue, value)) {
			// A memory write is made synchronously, before the returned
			// promise settles; the promise only carries a failure.
			configurationService.updateValue(key, value, ConfigurationTarget.MEMORY).catch(onUnexpectedError);
		}
	}
}

/**
 * The environment the theme service reads, with DevHub's theme as the one to
 * start in when nothing matching is cached. Everything else is the
 * environment itself: this delegates to it.
 */
function withInitialColorTheme(environmentService: IBrowserWorkbenchEnvironmentService, initialColorTheme: InitialColorTheme | undefined): IBrowserWorkbenchEnvironmentService {
	if (!initialColorTheme || environmentService.options?.initialColorTheme) {
		return environmentService;
	}
	const options = { ...environmentService.options, initialColorTheme };
	return Object.create(environmentService, { options: { value: options } });
}

/**
 * The workbench's theme service, constructed with DevHub's theme already in
 * the configuration. Everything it does is upstream's.
 */
class DevhubWorkbenchThemeService extends WorkbenchThemeService {
	constructor(
		@IExtensionService extensionService: IExtensionService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@IFileService fileService: IFileService,
		@IExtensionResourceLoaderService extensionResourceLoaderService: IExtensionResourceLoaderService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ILogService logService: ILogService,
		@IHostColorSchemeService hostColorService: IHostColorSchemeService,
		@IUserDataInitializationService userDataInitializationService: IUserDataInitializationService,
		@ILanguageService languageService: ILanguageService,
		@INotificationService notificationService: INotificationService,
		@IHostService hostService: IHostService
	) {
		const start = workbenchStart();
		applyManagedSettings(configurationService, start?.devhubManagedSettings);
		super(
			extensionService,
			storageService,
			configurationService,
			telemetryService,
			withInitialColorTheme(environmentService, start?.devhubInitialColorTheme),
			fileService,
			extensionResourceLoaderService,
			layoutService,
			logService,
			hostColorService,
			userDataInitializationService,
			languageService,
			notificationService,
			hostService
		);
	}
}

// Registered after upstream's (`workbench.common.main.ts` is imported first),
// so this is the one the workbench gets.
registerSingleton(IWorkbenchThemeService, DevhubWorkbenchThemeService, InstantiationType.Eager);

class DevhubManagedSettings implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.devhubManagedSettings';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
	) {
		ipcRenderer.on(MANAGED_SETTINGS_CHANNEL, (_event: unknown, ...args: unknown[]) => {
			applyManagedSettings(configurationService, args[0]);
		});
		ipcRenderer.send(MANAGED_SETTINGS_REQUEST);
	}
}

registerWorkbenchContribution2(DevhubManagedSettings.ID, DevhubManagedSettings, WorkbenchPhase.BlockStartup);
