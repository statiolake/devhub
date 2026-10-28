/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the settings DevHub decides for every workbench, and the one place
// in a workbench that holds them. The values come from main
// (apps/desktop/src/main/shell/workbenchManagedSettings.ts) — on the window
// configuration at start, then pushed — and are held in two layers:
//
// - **The MEMORY configuration**, above the person's settings.json and a
//   folder's, never written to a file. This is what makes them apply: a
//   `workbench.colorTheme` in the person's file cannot make the editor
//   disagree with the window around it.
// - **The defaults** (`registerDefaultConfigurations`), with DevHub as their
//   source. The memory layer is invisible to the Settings editor, which shows
//   a setting's user, workspace and default values only, so "Preferred Dark
//   Color Theme" read "Dark 2026" — VS Code's default — while Nord was worn.
//   With the default being DevHub's value the editor shows what applies, and
//   says "Default value changed by DevHub".
//
// Upstream's configuration service drops the whole memory configuration each
// time it reloads its configuration (`WorkspaceService.loadConfiguration`
// builds a new `Configuration` with an empty memory model): Start Debugging
// (F5) and Run Task do, before every run (`saveAllBeforeDebugStart`,
// `AbstractTaskService._executeTask`), and so does a profile switch or a
// change of workspace. With the memory values gone the person's own
// `window.autoDetectColorScheme: true` picked `workbench.preferredDarkColorTheme`
// at its default, and F5 switched the editor to Dark 2026 until DevHub's theme
// next changed. So every configuration change is followed by putting back
// whatever the memory layer lost, from the same listener that sees the loss —
// before the theme service, whose answer to the change runs a turn later, has
// read the settings — and the defaults stay DevHub's in any case, since a
// reload rebuilds the defaults from the registry and keeps them.

import { equals } from '../../../../base/common/objects.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, IConfigurationDefaults, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** Who the Settings editor says changed these defaults. */
export const DEVHUB_DEFAULTS_SOURCE = 'DevHub';

export type DevhubManagedSettings = Readonly<Record<string, unknown>>;

export const IDevhubManagedSettingsService = createDecorator<IDevhubManagedSettingsService>('devhubManagedSettingsService');

export interface IDevhubManagedSettingsService {
	readonly _serviceBrand: undefined;
	/** DevHub's values now: held from here on, until the next call. */
	set(settings: unknown): void;
	/** The values held, or none before the first `set`. */
	readonly settings: DevhubManagedSettings | undefined;
}

function isSettings(value: unknown): value is DevhubManagedSettings {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DevhubManagedSettingsService extends Disposable implements IDevhubManagedSettingsService {
	declare readonly _serviceBrand: undefined;

	private readonly registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
	private held: DevhubManagedSettings | undefined;
	private defaults: IConfigurationDefaults | undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		// Every change, whatever its source: a reload says only that keys
		// changed, and the memory values being among them is the loss.
		this._register(configurationService.onDidChangeConfiguration(() => this.holdInMemory()));
	}

	get settings(): DevhubManagedSettings | undefined {
		return this.held;
	}

	set(settings: unknown): void {
		if (!isSettings(settings) || equals(settings, this.held)) {
			return;
		}
		this.held = { ...settings };
		this.holdAsDefaults(this.held);
		this.holdInMemory();
	}

	/** DevHub's values as the defaults, in place of the ones held before. */
	private holdAsDefaults(settings: DevhubManagedSettings): void {
		const previous = this.defaults;
		this.defaults = {
			overrides: { ...settings },
			source: DEVHUB_DEFAULTS_SOURCE,
			// DevHub hands them to every start; a cached copy could only be
			// the theme of an earlier one.
			donotCache: true,
			preventExperimentOverride: true,
		};
		this.registry.deltaConfiguration({
			removedDefaults: previous ? [previous] : undefined,
			addedDefaults: [this.defaults],
		});
	}

	/** Write into memory whatever it does not hold as DevHub's. */
	private holdInMemory(): void {
		const settings = this.held;
		if (!settings) {
			return;
		}
		for (const [key, value] of Object.entries(settings)) {
			if (!equals(this.configurationService.inspect(key).memoryValue, value)) {
				// A memory write is made synchronously, before the returned
				// promise settles; the promise only carries a failure.
				this.configurationService.updateValue(key, value, ConfigurationTarget.MEMORY).catch(onUnexpectedError);
			}
		}
	}

	override dispose(): void {
		if (this.defaults) {
			this.registry.deregisterDefaultConfigurations([this.defaults]);
			this.defaults = undefined;
		}
		super.dispose();
	}
}
