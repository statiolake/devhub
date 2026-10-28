/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the settings DevHub decides are held in memory and as the defaults,
// and survive the configuration being reloaded.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationTarget, IConfigurationChangeEvent, IConfigurationOverrides, IConfigurationService, IConfigurationValue } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions, IConfigurationNode, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { DEVHUB_DEFAULTS_SOURCE, DevhubManagedSettingsService } from '../../common/devhubManagedSettings.js';

const THEME = 'devhubManagedSettingsTest.preferredDarkColorTheme';
const DETECT = 'devhubManagedSettingsTest.autoDetectColorScheme';

const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

/**
 * The layers the workbench's configuration service has, as far as these
 * settings go: the registry's defaults, the person's settings and memory —
 * and a reload that, as upstream's does, starts memory again from nothing.
 */
class FakeConfigurationService extends mock<IConfigurationService>() {
	readonly memory = new Map<string, unknown>();
	readonly user = new Map<string, unknown>();
	readonly memoryWrites: string[] = [];
	private readonly changes = new Emitter<IConfigurationChangeEvent>();
	override readonly onDidChangeConfiguration = this.changes.event;

	override inspect<T>(key: string): IConfigurationValue<T> {
		const defaultValue = registry.getConfigurationProperties()[key]?.default as T | undefined;
		const memoryValue = this.memory.get(key) as T | undefined;
		const userValue = this.user.get(key) as T | undefined;
		const inspected: IConfigurationValue<T> = { defaultValue, userValue, memoryValue, value: memoryValue ?? userValue ?? defaultValue };
		return inspected;
	}

	override getValue<T>(section?: string | IConfigurationOverrides): T {
		return this.inspect<T>(section as string).value as T;
	}

	override updateValue(key: string, value: unknown, target?: unknown): Promise<void> {
		assert.strictEqual(target, ConfigurationTarget.MEMORY);
		this.memory.set(key, value);
		this.memoryWrites.push(key);
		this.fire([key], ConfigurationTarget.MEMORY);
		return Promise.resolve();
	}

	/** `reloadConfiguration()`, as Start Debugging and Run Task call it. */
	reload(): void {
		const keys = [...this.memory.keys()];
		this.memory.clear();
		this.fire(keys, ConfigurationTarget.WORKSPACE);
	}

	private fire(keys: string[], source: ConfigurationTarget): void {
		this.changes.fire({
			source,
			affectedKeys: new Set(keys),
			change: { keys, overrides: [] },
			affectsConfiguration: (key: string) => keys.some(changed => changed === key || changed.startsWith(`${key}.`)),
		});
	}

	dispose(): void {
		this.changes.dispose();
	}
}

suite('DevHub managed settings', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const node: IConfigurationNode = {
		id: 'devhubManagedSettingsTest',
		properties: {
			[THEME]: { type: 'string', default: 'Dark 2026' },
			[DETECT]: { type: 'boolean', default: false },
		},
	};
	let configuration: FakeConfigurationService;

	setup(() => {
		registry.registerConfiguration(node);
		configuration = store.add(new FakeConfigurationService());
	});

	teardown(() => {
		registry.deregisterConfigurations([node]);
	});

	function devhubDefaults() {
		return registry.getRegisteredDefaultConfigurations().filter(defaults => defaults.source === DEVHUB_DEFAULTS_SOURCE);
	}

	test('are held in memory, above the person\'s settings', () => {
		configuration.user.set(THEME, 'Monokai');
		const service = store.add(new DevhubManagedSettingsService(configuration));
		service.set({ [THEME]: 'Nord', [DETECT]: true });

		assert.strictEqual(configuration.inspect(THEME).memoryValue, 'Nord');
		assert.strictEqual(configuration.getValue(THEME), 'Nord');
		assert.strictEqual(configuration.getValue(DETECT), true);
		assert.deepStrictEqual(service.settings, { [THEME]: 'Nord', [DETECT]: true });
	});

	test('are the defaults, with DevHub as their source — what the Settings editor shows', () => {
		const service = store.add(new DevhubManagedSettingsService(configuration));
		service.set({ [THEME]: 'Nord', [DETECT]: true });

		const property = registry.getConfigurationProperties()[THEME];
		assert.strictEqual(property.default, 'Nord');
		assert.strictEqual(property.defaultValueSource, DEVHUB_DEFAULTS_SOURCE);
		assert.strictEqual(registry.getConfigurationProperties()[DETECT].default, true);
		assert.strictEqual(devhubDefaults().length, 1);
		assert.strictEqual(devhubDefaults()[0].donotCache, true);
	});

	test('are put back when a reload drops the memory configuration, before a later listener reads them', () => {
		const service = store.add(new DevhubManagedSettingsService(configuration));
		service.set({ [THEME]: 'Nord', [DETECT]: true });
		// The theme service listens after this service does.
		const seen: unknown[] = [];
		store.add(configuration.onDidChangeConfiguration(() => seen.push(configuration.getValue(THEME))));

		configuration.reload();

		assert.strictEqual(configuration.inspect(THEME).memoryValue, 'Nord');
		assert.strictEqual(configuration.inspect(DETECT).memoryValue, true);
		assert.ok(seen.length > 0);
		assert.deepStrictEqual(seen.filter(value => value !== 'Nord'), []);
	});

	test('without memory, the default is still DevHub\'s theme', () => {
		const service = store.add(new DevhubManagedSettingsService(configuration));
		service.set({ [THEME]: 'Nord' });
		configuration.memory.clear();

		assert.strictEqual(configuration.getValue(THEME), 'Nord');
	});

	test('new values replace the old ones, in memory and as the defaults', () => {
		const service = store.add(new DevhubManagedSettingsService(configuration));
		service.set({ [THEME]: 'Nord' });
		service.set({ [THEME]: 'Monokai' });

		assert.strictEqual(configuration.getValue(THEME), 'Monokai');
		assert.strictEqual(registry.getConfigurationProperties()[THEME].default, 'Monokai');
		assert.strictEqual(devhubDefaults().length, 1);
	});

	test('the same values again, or no values, change nothing', () => {
		const service = store.add(new DevhubManagedSettingsService(configuration));
		service.set({ [THEME]: 'Nord' });
		const writes = configuration.memoryWrites.length;
		const defaults = devhubDefaults()[0];

		service.set({ [THEME]: 'Nord' });
		service.set(undefined);
		service.set('Nord');

		assert.strictEqual(configuration.memoryWrites.length, writes);
		assert.strictEqual(devhubDefaults()[0], defaults);
		assert.strictEqual(configuration.getValue(THEME), 'Nord');
	});

	test('nothing is written before DevHub has said anything', () => {
		store.add(new DevhubManagedSettingsService(configuration));
		configuration.reload();

		assert.deepStrictEqual(configuration.memoryWrites, []);
		assert.strictEqual(configuration.getValue(THEME), 'Dark 2026');
	});

	test('disposed, the defaults are upstream\'s again', () => {
		const service = new DevhubManagedSettingsService(configuration);
		service.set({ [THEME]: 'Nord' });
		service.dispose();

		assert.strictEqual(registry.getConfigurationProperties()[THEME].default, 'Dark 2026');
		assert.deepStrictEqual(devhubDefaults(), []);
	});
});
