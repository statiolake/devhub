/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: `devhub.vim.exCommands` is the user's alone (a workspace cannot
// define `:` commands), and its JSON schema says what common/vimEx.ts accepts.

import assert from 'assert';
import { IJSONSchema } from '../../../../../base/common/jsonSchema.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EX_COMMAND_SPEC_SCHEMA, exCommandsSetting } from '../../browser/devhubVim.contribution.js';
import { validateExCommandSpec } from '../../common/vimEx.js';

function inspecting(values: Record<string, unknown>): Pick<IConfigurationService, 'inspect'> {
	return { inspect: (() => values) as IConfigurationService['inspect'] };
}

suite('DevHub Vim: devhub.vim.exCommands is read from the user\'s settings only', () => {

	test('a workspace\'s value is never read; the remote user settings add to the local ones', () => {
		const w = { Evil: { command: 'workbench.action.terminal.sendSequence', args: { text: 'rm -rf ~\n' } } };
		assert.deepStrictEqual(exCommandsSetting(inspecting({ value: w, workspaceValue: w, workspaceFolderValue: w })), {});
		assert.deepStrictEqual(exCommandsSetting(inspecting({ value: { ...w, A: 'a' }, workspaceValue: w, userValue: { A: 'a' } })), { A: 'a' });
		assert.deepStrictEqual(exCommandsSetting(inspecting({ userLocalValue: { A: 'a', B: 'b' }, userRemoteValue: { B: 'remote' }, workspaceValue: w })), { A: 'a', B: 'remote' });
		assert.deepStrictEqual(exCommandsSetting(inspecting({ userRemoteValue: { R: 'r' } })), { R: 'r' });
		assert.deepStrictEqual(exCommandsSetting(inspecting({ userValue: ['not', 'an', 'object'] })), {});
	});

	test('the setting is machine-scoped: the configuration service keeps a workspace\'s value out too', () => {
		const props = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties();
		assert.strictEqual(props['devhub.vim.exCommands']?.scope, ConfigurationScope.MACHINE);
	});
});

suite('DevHub Vim: the JSON schema of devhub.vim.exCommands', () => {

	const setting = () => Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties()['devhub.vim.exCommands'] as IJSONSchema;

	test('names: uppercase first, or any name a built-in answers to', () => {
		const pattern = new RegExp(setting().propertyNames!.pattern!);
		for (const ok of ['Fmt', 'Grep2', 'w', 'wr', 'write', 'sp', 'split', 'tabe', 'normal', 'setl']) {
			assert.ok(pattern.test(ok), ok);
		}
		for (const bad of ['fmt', 'writex', '2W', 'W-x', '']) {
			assert.ok(!pattern.test(bad), bad);
		}
	});

	test('its enums are what the validator accepts', () => {
		const p = EX_COMMAND_SPEC_SCHEMA.properties!;
		for (const nargs of p.nargs.enum!) {
			assert.strictEqual(typeof validateExCommandSpec({ command: 'x', nargs }), 'object', String(nargs));
		}
		for (const range of p.range.enum!) {
			assert.strictEqual(typeof validateExCommandSpec({ command: 'x', range }), 'object', String(range));
		}
		for (const complete of [...p.complete.anyOf![0].enum!, 'command:my.list']) {
			assert.strictEqual(typeof validateExCommandSpec({ command: 'x', complete }), 'object', String(complete));
		}
		// every key the schema has is one the validator knows, and no other
		for (const key of Object.keys(p)) {
			const v = validateExCommandSpec({ ...(key === 'commands' ? {} : { command: 'x' }), [key]: key === 'commands' ? ['x'] : key === 'args' ? 1 : key === 'description' ? 'd' : key === 'command' ? 'x' : key === 'nargs' ? '*' : key === 'range' ? 'range' : key === 'defaultRange' ? '%' : key === 'complete' ? 'file' : true, ...(key === 'defaultRange' ? { range: 'range' } : {}) });
			assert.strictEqual(typeof v, 'object', `${key}: ${v}`);
		}
		assert.strictEqual(EX_COMMAND_SPEC_SCHEMA.additionalProperties, false);
		assert.strictEqual(typeof validateExCommandSpec({ command: 'x', other: 1 }), 'string');
	});
});
