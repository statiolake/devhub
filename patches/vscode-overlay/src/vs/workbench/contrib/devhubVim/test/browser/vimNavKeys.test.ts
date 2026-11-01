/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: CTRL-W and the key after it everywhere — a Vim editor, an empty
// group, the side bar and the panel (lists), the terminal, a webview, a
// comment widget — resolved as the keybinding service resolves them: DevHub's
// defaults with a user's keybindings.json on top, in VS Code's own
// precedence. The user's bindings here are made up to show the rules (a list
// key, a remap of a nav key, another key for the prefix), not anyone's file.
// The normal-mode keys of the places without a Vim buffer apply in a
// webview's page outside its fields.

import assert from 'assert';
import { KeybindingParser } from '../../../../../base/common/keybindingParser.js';
import { OS } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyExpr, IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingResolver, ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ResolvedKeybindingItem } from '../../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { USLayoutResolvedKeybinding } from '../../../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import { DEFAULT_COMMANDS_TO_SKIP_SHELL } from '../../../terminal/common/terminal.js';
import '../../browser/devhubVim.contribution.js';
import '../../browser/vimTabPages.js';
import { DEFAULT_KEYBINDINGS, VIM_WHEN, evaluateWhen } from '../../common/vimKeymap.js';
import { VIM_NAV_COMMAND_IDS } from '../../common/vimNavCommands.js';

type UserBinding = { key: string; command: string; args?: unknown; when?: string };

const NOT_NAV = `devhubVim.mode != 'nav'`;
const IN_NAV = `devhubVim.mode == 'nav'`;

/** A user's keybindings.json, written as docs/vim.md says. */
const USER_KEYBINDINGS: readonly UserBinding[] = [
	// a list's Vim keys, kept off nav's keys: a user's binding outranks DevHub's defaults
	{ key: 'h', command: 'list.collapse', when: `listFocus && !inputFocus && ${NOT_NAV}` },
	{ key: 'l', command: 'list.expand', when: `listFocus && !inputFocus && ${NOT_NAV}` },
	// another key for the prefix, also from the terminal
	{ key: 'alt+w', command: 'devhubVim.nav.enter', args: { terminal: true }, when: `config.devhub.vim.enabled && ${NOT_NAV} && !devhubVim.cmdlineFocus && (!devhubVim.active || !devhubVim.insert) && !inQuickInput` },
	// a nav key remapped: DevHub's default removed, the user's in its place
	{ key: 'n', command: '-devhubVim.nav.new' },
	{ key: 'n', command: 'devhubVim.tabpage.next', when: IN_NAV },
	// a nav key of the user's own
	{ key: 'z', command: 'workbench.action.toggleMaximizedPanel', when: IN_NAV },
];

function resolved(key: string): USLayoutResolvedKeybinding | undefined {
	const kb = KeybindingParser.parseKeybinding(key);
	return kb ? USLayoutResolvedKeybinding.resolveKeybinding(kb, OS)[0] : undefined;
}

/** The resolver the keybinding service builds: the defaults (DevHub Vim's included), then the user's. */
function resolver(user = USER_KEYBINDINGS): KeybindingResolver {
	const defaults: ResolvedKeybindingItem[] = [];
	for (const k of KeybindingsRegistry.getDefaultKeybindings()) {
		for (const r of k.keybinding ? USLayoutResolvedKeybinding.resolveKeybinding(k.keybinding, OS) : []) {
			defaults.push(new ResolvedKeybindingItem(r, k.command, k.commandArgs, k.when ?? undefined, true, null, false));
		}
	}
	const overrides = user.map(u => new ResolvedKeybindingItem(resolved(u.key), u.command, u.args, u.when ? ContextKeyExpr.deserialize(u.when) : undefined, false, null, false));
	return new KeybindingResolver(defaults, overrides, () => { });
}

const ctx = (values: Record<string, unknown>): IContext => ({ getValue: <T>(k: string) => values[k] as T });

const ON = { 'config.devhub.vim.enabled': true };
/** Where the focus can be, with the context keys DevhubVim.update and the workbench set there. */
const PLACES: Record<string, Record<string, unknown>> = {
	'a Vim editor': { ...ON, editorTextFocus: true, textInputFocus: true, 'devhubVim.active': true, 'devhubVim.acceptsMotion': true, 'devhubVim.mode': 'normal' },
	'an empty editor group': { ...ON, 'devhubVim.active': true, 'devhubVim.acceptsMotion': true, 'devhubVim.mode': 'normal' },
	'the side bar (the Explorer)': { ...ON, sideBarFocus: true, listFocus: true, filesExplorerFocus: true, 'devhubVim.acceptsMotion': true, 'devhubVim.mode': 'normal' },
	'the panel (Problems)': { ...ON, panelFocus: true, listFocus: true, 'devhubVim.acceptsMotion': true, 'devhubVim.mode': 'normal' },
	'the terminal': { ...ON, panelFocus: true, terminalFocus: true, 'devhubVim.mode': 'insert' },
	'a webview\'s page': { ...ON, activeWebviewPanelId: 'markdown.preview', 'devhubVim.acceptsMotion': true, 'devhubVim.mode': 'normal' },
	'a webview\'s field': { ...ON, activeWebviewPanelId: 'markdown.preview', 'devhubVim.mode': 'insert' },
	'a comment widget': { ...ON, commentEditorFocused: true, editorTextFocus: true, textInputFocus: true, 'devhubVim.active': true, 'devhubVim.acceptsMotion': true, 'devhubVim.mode': 'normal' },
};

suite('DevHub Vim: CTRL-W and its key everywhere, with a user\'s keybindings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** What the key runs: the resolver's answer, as the keybinding service has it. */
	function run(r: KeybindingResolver, key: string, values: Record<string, unknown>, user = USER_KEYBINDINGS): string | undefined {
		const chord = resolved(key)!.getDispatchChords()[0]!;
		const result = (user === USER_KEYBINDINGS ? r : resolver(user)).resolve(ctx(values), [], chord);
		return result.kind === ResultKind.KbFound ? result.commandId ?? undefined : undefined;
	}

	const nav = (values: Record<string, unknown>) => ({ ...values, 'devhubVim.mode': 'nav', 'devhubVim.acceptsMotion': false });

	test('CTRL-W enters nav everywhere but a Vim editor\'s insert mode and the terminal; a user\'s other key for it with { terminal: true } from the terminal too', () => {
		const r = resolver();
		for (const [place, values] of Object.entries(PLACES)) {
			assert.strictEqual(run(r, 'ctrl+w', values), place === 'the terminal' ? undefined : 'devhubVim.nav.enter', `CTRL-W in ${place}`);
			assert.strictEqual(run(r, 'alt+w', values), 'devhubVim.nav.enter', `the user's key in ${place}`);
		}
		const insert = { ...PLACES['a Vim editor'], 'devhubVim.mode': 'insert', 'devhubVim.insert': true, 'devhubVim.acceptsMotion': false };
		assert.notStrictEqual(run(r, 'ctrl+w', insert), 'devhubVim.nav.enter');
		assert.notStrictEqual(run(r, 'alt+w', insert), 'devhubVim.nav.enter');
	});

	test('after it, h j k l, CTRL-h and w move to the neighbouring window from every place', () => {
		const r = resolver();
		for (const [place, values] of Object.entries(PLACES)) {
			assert.deepStrictEqual(['h', 'j', 'k', 'l', 'ctrl+h', 'left', 'w'].map(k => run(r, k, nav(values))), [
				'devhubVim.nav.left', 'devhubVim.nav.down', 'devhubVim.nav.up', 'devhubVim.nav.right', 'devhubVim.nav.left', 'devhubVim.nav.leftArrow',
				'devhubVim.nav.next',
			], place);
		}
	});

	test('a user\'s binding beats DevHub\'s default, also on a nav key; with devhubVim.mode != \'nav\' it yields to nav and keeps the key outside it', () => {
		const r = resolver();
		const list = PLACES['the side bar (the Explorer)'];
		const unguarded = USER_KEYBINDINGS.map(u => u.command === 'list.collapse' ? { ...u, when: 'listFocus && !inputFocus' } : u);
		assert.strictEqual(run(r, 'h', nav(list), unguarded), 'list.collapse', 'unguarded, the user\'s list key wins after CTRL-W');
		assert.strictEqual(run(r, 'h', nav(list)), 'devhubVim.nav.left');
		assert.strictEqual(run(r, 'l', nav(list)), 'devhubVim.nav.right');
		assert.strictEqual(run(r, 'h', list), 'list.collapse', 'outside nav the list keeps its h');
	});

	test('the user\'s nav keys hold everywhere: a remapped default and a key of their own', () => {
		const r = resolver();
		for (const [place, values] of Object.entries(PLACES)) {
			assert.deepStrictEqual(['n', 'z'].map(k => run(r, k, nav(values))), ['devhubVim.tabpage.next', 'workbench.action.toggleMaximizedPanel'], place);
		}
		assert.strictEqual(run(r, 'n', nav(PLACES['a Vim editor']), []), 'devhubVim.nav.new', 'DevHub\'s default without the remap');
	});

	test('in the terminal the keys of DevHub\'s nav commands skip the shell, as the navigate commands do', () => {
		for (const id of VIM_NAV_COMMAND_IDS) {
			assert.ok(DEFAULT_COMMANDS_TO_SKIP_SHELL.includes(id), id);
		}
		assert.ok(VIM_NAV_COMMAND_IDS.includes('devhubVim.nav.left') && VIM_NAV_COMMAND_IDS.includes('devhubVim.nav.escape'));
		assert.ok(!DEFAULT_COMMANDS_TO_SKIP_SHELL.includes('devhubVim.nav.enter'), 'CTRL-W is the shell\'s');
	});

	test('a webview\'s page outside its fields has the normal-mode keys of the places without a Vim buffer (: gt gT CTRL-O CTRL-^ ]b ...); its fields keep theirs', () => {
		const page = PLACES['a webview\'s page'];
		const field = PLACES['a webview\'s field'];
		const commands = (values: Record<string, unknown>) => new Set(DEFAULT_KEYBINDINGS.filter(b => evaluateWhen(b.when, values)).map(b => b.command));
		for (const c of ['devhubVim.cmdline', 'devhubVim.tabpage.next', 'devhubVim.tabpage.previous', 'workbench.action.navigateBack', 'devhubVim.buffer.alternate', 'devhubVim.buffer.next']) {
			assert.ok(commands(page).has(c), c);
			assert.ok(!commands(field).has(c), `${c} in a field`);
		}
		// a user's binding with the documented `when` of "normal mode anywhere" holds there too
		assert.ok(evaluateWhen(`devhubVim.acceptsMotion && devhubVim.mode == 'normal'`, page));
		assert.ok(evaluateWhen(VIM_WHEN.elsewhere, page));
	});

	test('VS Code\'s editor-tab keys resolve to the tab pages everywhere while Vim is on (Ctrl+Tab, Ctrl+PageDown / PageUp, page N, the last)', () => {
		const r = resolver();
		const mac = OS === 2;
		for (const [place, values] of Object.entries(PLACES)) {
			if (place === 'the terminal') {
				continue; // there terminal.integrated.commandsToSkipShell decides whether the shell gets the key
			}
			assert.strictEqual(run(r, 'ctrl+tab', values), 'devhubVim.tabpage.next', place);
			assert.strictEqual(run(r, 'ctrl+shift+tab', values), 'devhubVim.tabpage.previous', place);
			assert.strictEqual(run(r, mac ? 'cmd+alt+right' : 'ctrl+pagedown', values), 'devhubVim.tabpage.next', place);
			assert.strictEqual(run(r, mac ? 'cmd+alt+left' : 'ctrl+pageup', values), 'devhubVim.tabpage.previous', place);
			assert.strictEqual(run(r, mac ? 'ctrl+3' : 'alt+3', values), 'devhubVim.tabpage.goto', place);
		}
		assert.strictEqual(run(r, 'ctrl+tab', { ...PLACES['a Vim editor'], 'config.devhub.vim.enabled': false }), undefined, 'Vim off: not the tab pages\'');
	});
});
