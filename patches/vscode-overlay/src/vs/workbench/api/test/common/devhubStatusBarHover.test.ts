/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as vscode from 'vscode';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { timeout } from '../../../../base/common/async.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { hoverCommandArguments, IStatusBarHoverDto, nextCheckedState, toStatusBarHoverDto } from '../../common/devhubStatusBarHover.js';
import { MainThreadStatusBarShape } from '../../common/extHost.protocol.js';
import { CommandsConverter } from '../../common/extHostCommands.js';
import { ExtHostStatusBarEntry } from '../../common/extHostStatusBar.js';

suite('DevHub status bar hover', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const toMarkdown = (value: vscode.MarkdownString) => ({ value: value.value, isTrusted: value.isTrusted });
	const convert = (items: unknown[]) => {
		const commands: vscode.Command[] = [];
		const dto = toStatusBarHoverDto({ items } as vscode.StatusBarHover, commands, toMarkdown);
		return { dto, commands };
	};

	test('commands cross as handles into the list they were collected in', () => {
		const signIn = { title: 'Sign In', command: 'x.signIn', arguments: [{ notSerialisable: () => 1 }] };
		const toggle = { title: 'Toggle', command: 'x.toggle', arguments: ['a'] };
		const { dto, commands } = convert([
			{ kind: 'buttons', buttons: [{ label: '$(sign-in) Sign In', command: signIn }] },
			{ kind: 'checkbox', label: 'Completions', checked: true, command: toggle },
		]);
		assert.deepStrictEqual(commands, [signIn, toggle]);
		assert.deepStrictEqual(dto.items, [
			{ kind: 'buttons', id: undefined, buttons: [{ label: '$(sign-in) Sign In', title: 'Sign In', secondary: false, enabled: true, handle: 0 }] },
			{ kind: 'checkbox', id: undefined, label: 'Completions', checked: true, triState: false, enabled: true, description: undefined, handle: 1 },
		]);
	});

	test('a progress value is clamped, and a missing one is indeterminate', () => {
		const { dto } = convert([
			{ kind: 'progress', label: 'A', value: 140 },
			{ kind: 'progress', label: 'B', value: -3, valueLabel: '0%', description: 'used', detail: 'Resets Nov 1' },
			{ kind: 'progress', label: 'C' },
			{ kind: 'progress', label: 'D', value: Number.NaN },
		]);
		assert.deepStrictEqual(dto.items.map(item => item.kind === 'progress' ? item.value : 'x'), [100, 0, undefined, undefined]);
		assert.deepStrictEqual(dto.items[1], { kind: 'progress', id: undefined, label: 'B', value: 0, valueLabel: '0%', description: 'used', detail: 'Resets Nov 1' });
	});

	test('malformed items are dropped, not thrown on', () => {
		const { dto, commands } = convert([
			null,
			{ kind: 'nope' },
			{ kind: 'header' },
			{ kind: 'checkbox', label: 'no command', checked: true },
			{ kind: 'buttons', buttons: [{ label: 'no command' }] },
			{ kind: 'header', label: 'Copilot', actions: [{ icon: { id: 'gear' }, command: { title: 'Settings', command: 'x.settings' } }, { icon: 'gear', command: { title: 'bad', command: 'x' } }] },
			{ kind: 'separator' },
		]);
		assert.deepStrictEqual(dto.items, [
			{ kind: 'header', id: undefined, label: 'Copilot', description: undefined, actions: [{ icon: 'gear', title: 'Settings', handle: 0 }] },
			{ kind: 'separator', id: undefined },
		]);
		assert.strictEqual(commands.length, 1);
	});

	test('sections hold leaves only, and a mixed state needs a tri-state checkbox', () => {
		const command = { title: 't', command: 'x.t' };
		const { dto } = convert([{
			kind: 'section', id: 'settings', label: 'Settings', description: 'Python', items: [
				{ kind: 'section', label: 'nested', items: [] },
				{ kind: 'checkbox', id: 'lang', label: 'for Python', checked: 'mixed', triState: true, command },
				{ kind: 'checkbox', label: 'two-state', checked: 'mixed', command },
				{ kind: 'text', text: { value: '[Open](command:x.open)', isTrusted: true } },
			],
		}]);
		const section = dto.items[0];
		assert.ok(section.kind === 'section');
		assert.deepStrictEqual(section.items.map(item => item.kind), ['checkbox', 'checkbox', 'text']);
		assert.deepStrictEqual(section.items.map(item => item.kind === 'checkbox' ? item.checked : undefined), ['mixed', false, undefined]);
		assert.deepStrictEqual(section.items[2], { kind: 'text', id: undefined, text: { value: '[Open](command:x.open)', isTrusted: true }, muted: false });
	});

	test('the extension host sends the hover before the entry, and runs its commands', async () => {
		const calls: string[] = [];
		const hovers: (IStatusBarHoverDto | undefined)[] = [];
		const proxy: Partial<MainThreadStatusBarShape> = {
			$setEntryHover: (_id, hover) => { calls.push('hover'); hovers.push(hover); },
			$setEntry: () => { calls.push('entry'); },
			$disposeEntry: () => { calls.push('dispose'); },
		};
		const extension: IExtensionDescription = { ...nullExtensionDescription, enabledApiProposals: ['devhubStatusBarHover'] };
		const item = new ExtHostStatusBarEntry(proxy as MainThreadStatusBarShape, {} as CommandsConverter, new Map(), extension, 'test');

		item.text = 'plain';
		item.show();
		await timeout(1);
		assert.deepStrictEqual(calls, ['entry'], 'no hover, no extra message');

		const set = { title: '', command: 'x.set', arguments: ['key', { live: true }] };
		item.hover = { items: [{ kind: 'checkbox', label: 'On', checked: false, command: set }] };
		await timeout(1);
		assert.deepStrictEqual(calls, ['entry', 'hover', 'entry']);
		assert.strictEqual(item.hoverCommand(0), set);
		assert.deepStrictEqual(hoverCommandArguments(set, true), ['key', { live: true }, true]);
		assert.deepStrictEqual(hoverCommandArguments(set, undefined), ['key', { live: true }]);

		item.hover = undefined;
		await timeout(1);
		assert.deepStrictEqual(calls.slice(3), ['hover', 'entry']);
		assert.strictEqual(hovers.at(-1), undefined, 'removing the hover is said');

		item.hide();
		item.text = 'again';
		item.show();
		await timeout(1);
		assert.deepStrictEqual(calls.slice(5), ['dispose', 'entry'], 'nothing left to remove after a hide');

		const other = new ExtHostStatusBarEntry(proxy as MainThreadStatusBarShape, {} as CommandsConverter, new Map(), nullExtensionDescription, 'other');
		assert.throws(() => { other.hover = { items: [] }; }, /devhubStatusBarHover/);
		item.dispose();
		other.dispose();
	});

	test('a click moves a checkbox to its next state', () => {
		assert.strictEqual(nextCheckedState(true, false), false);
		assert.strictEqual(nextCheckedState(false, false), true);
		assert.strictEqual(nextCheckedState(true, true), false);
		assert.strictEqual(nextCheckedState(false, true), 'mixed');
		assert.strictEqual(nextCheckedState('mixed', true), true);
	});
});
