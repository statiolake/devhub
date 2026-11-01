/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: CTRL-W and the keys after it everywhere — a Vim editor, an empty
// group, the side bar and the panel (lists), the terminal, a webview, a
// comment widget — resolved as the keybinding service resolves them, with a
// user's keybindings.json on top of the defaults (a real one's: the
// maintainer's dotfiles, code/devhub/keybindings.toml after the shared
// code/keybindings.toml, as configure.py writes them for macOS; the entries
// that bear on these keys). The normal-mode keys of the places without a Vim
// buffer apply in a webview's page outside its fields.

import assert from 'assert';
import { KeybindingParser } from '../../../../../base/common/keybindingParser.js';
import { OS } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyExpr, IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingResolver, ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ResolvedKeybindingItem } from '../../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { USLayoutResolvedKeybinding } from '../../../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import '../../browser/devhubVim.contribution.js';
import '../../browser/vimTabPages.js';
import { DEFAULT_KEYBINDINGS, VIM_WHEN, evaluateWhen } from '../../common/vimKeymap.js';

/** The user's keybindings.json (the maintainer's, generated for macOS: `cmd` is Cmd there and Meta here), the entries on these keys, in their order. */
const USER_KEYBINDINGS: readonly { key: string; command: string; args?: unknown; when?: string }[] = [
	{ key: 'cmd+h', command: 'editor.action.startFindReplaceAction' },
	{ key: 'cmd+w', command: '-workbench.action.closeActiveEditor' },
	// a list's Vim keys, kept off nav's keys (`devhubVim.mode != 'nav'`): a user's binding outranks DevHub's defaults
	{ key: 'j', command: 'list.focusDown', when: 'listFocus && !inputFocus && devhubVim.mode != \'nav\'' },
	{ key: 'k', command: 'list.focusUp', when: 'listFocus && !inputFocus && devhubVim.mode != \'nav\'' },
	{ key: 'h', command: 'list.collapse', when: 'listFocus && !inputFocus && devhubVim.mode != \'nav\'' },
	{ key: 'l', command: 'list.expand', when: 'listFocus && !inputFocus && devhubVim.mode != \'nav\'' },
	{ key: 'o', command: 'list.select', when: 'listFocus && !inputFocus && devhubVim.mode != \'nav\'' },
	{ key: 'v', command: 'list.toggleSelection', when: 'listFocus && listSupportsMultiselect && !inputFocus && devhubVim.mode != \'nav\'' },
	{ key: 'd', command: 'deleteFile', when: 'filesExplorerFocus && !explorerResourceIsRoot && !explorerResourceReadonly && !inputFocus && devhubVim.mode != \'nav\'' },
	{ key: 'x', command: 'filesExplorer.cut', when: 'filesExplorerFocus && !explorerResourceIsRoot && !explorerResourceReadonly && !inputFocus && devhubVim.mode != \'nav\'' },
	{ key: 'p', command: 'filesExplorer.paste', when: 'filesExplorerFocus && !explorerResourceReadonly && !inputFocus && devhubVim.mode != \'nav\'' },
	{ key: 'cmd+w', command: 'devhubVim.nav.enter', args: { terminal: true }, when: 'config.devhub.vim.enabled && devhubVim.mode != \'nav\' && !devhubVim.cmdlineFocus && (!devhubVim.active || !devhubVim.insert) && !inQuickInput' },
	{ key: 'cmd+w', command: 'devhubVim.nav.next', when: 'devhubVim.mode == \'nav\'' },
	{ key: 'cmd+h', command: 'devhubVim.nav.left', when: 'devhubVim.mode == \'nav\'' },
	{ key: 'cmd+j', command: 'devhubVim.nav.down', when: 'devhubVim.mode == \'nav\'' },
	{ key: 'cmd+k', command: 'devhubVim.nav.up', when: 'devhubVim.mode == \'nav\'' },
	{ key: 'cmd+l', command: 'devhubVim.nav.right', when: 'devhubVim.mode == \'nav\'' },
	{ key: 'n', command: '-devhubVim.nav.new' },
	{ key: 'n', command: 'devhubVim.tabpage.next', when: 'devhubVim.mode == \'nav\'' },
	{ key: 'p', command: '-devhubVim.nav.lastAccessed' },
	{ key: 'p', command: 'devhubVim.tabpage.previous', when: 'devhubVim.mode == \'nav\'' },
	{ key: 'p', command: 'devhubVim.nav.lastAccessed', when: 'devhubVim.mode == \'nav\' && (commentEditorFocused || commentFocused)' },
	{ key: 'c', command: '-devhubVim.nav.close' },
	{ key: 'c', command: 'devhubVim.tabpage.new', when: 'devhubVim.mode == \'nav\'' },
	{ key: 'c', command: 'devhubVim.nav.close', when: 'devhubVim.mode == \'nav\' && (commentEditorFocused || commentFocused)' },
	{ key: '1', command: 'workbench.action.closeEditorsInOtherGroups', when: 'devhubVim.mode == \'nav\'' },
	{ key: 'x', command: 'runCommands', args: { commands: ['workbench.action.closeActiveEditor', 'devhubVim.tabpage.closeIfEmpty'] }, when: 'devhubVim.mode == \'nav\'' },
	{ key: 'x', command: 'devhubVim.nav.quit', when: 'devhubVim.mode == \'nav\' && (commentEditorFocused || commentFocused)' },
	{ key: 'shift+x', command: 'devhubVim.tabpage.close', when: 'devhubVim.mode == \'nav\'' },
	{ key: 'v', command: '-devhubVim.nav.vsplit' },
	{ key: 'v', command: 'workbench.action.splitEditorRight', when: 'devhubVim.mode == \'nav\'' },
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

suite('DevHub Vim: CTRL-W / Cmd-W and its keys everywhere, with a user\'s keybindings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** What the key runs: the resolver's answer, as the keybinding service (and DevHub Vim's nav, softDispatch) has it. */
	function run(r: KeybindingResolver, key: string, values: Record<string, unknown>, user = USER_KEYBINDINGS): string | undefined {
		const chord = resolved(key)!.getDispatchChords()[0]!;
		const result = (user === USER_KEYBINDINGS ? r : resolver(user)).resolve(ctx(values), [], chord);
		return result.kind === ResultKind.KbFound ? result.commandId ?? undefined : undefined;
	}

	test('Cmd-W (the user\'s alias of CTRL-W) and CTRL-W enter nav everywhere; not in a Vim editor\'s insert mode, CTRL-W not in the terminal', () => {
		const r = resolver();
		for (const [place, values] of Object.entries(PLACES)) {
			assert.strictEqual(run(r, 'cmd+w', values), 'devhubVim.nav.enter', `Cmd-W in ${place}`);
			assert.strictEqual(run(r, 'ctrl+w', values), place === 'the terminal' ? undefined : 'devhubVim.nav.enter', `CTRL-W in ${place}`);
		}
		const insert = { ...PLACES['a Vim editor'], 'devhubVim.mode': 'insert', 'devhubVim.insert': true, 'devhubVim.acceptsMotion': false };
		assert.notStrictEqual(run(r, 'cmd+w', insert), 'devhubVim.nav.enter');
	});

	test('after it, h j k l (and the user\'s Cmd-held h j k l) move to the neighbouring window from every place; a user\'s list keys hold back with devhubVim.mode != \'nav\'', () => {
		const r = resolver();
		const list = { ...PLACES['the side bar (the Explorer)'], 'devhubVim.mode': 'nav' };
		// without the condition a user's list key outranks DevHub's default, as any user binding does (the reported bug)
		const unguarded = USER_KEYBINDINGS.map(u => u.command === 'list.collapse' ? { ...u, when: 'listFocus && !inputFocus' } : u);
		assert.strictEqual(run(r, 'h', list, unguarded), 'list.collapse');
		assert.strictEqual(run(r, 'h', { ...list, 'devhubVim.mode': 'normal' }), 'list.collapse', 'outside nav the list keeps its h');
		assert.strictEqual(run(r, 'd', list), 'devhubVim.nav.diagnostic', 'CTRL-W d in the Explorer deletes no file');
		for (const [place, values] of Object.entries(PLACES)) {
			const nav = { ...values, 'devhubVim.mode': 'nav', 'devhubVim.acceptsMotion': false };
			assert.deepStrictEqual(['h', 'j', 'k', 'l', 'ctrl+h', 'left', 'cmd+h', 'cmd+j', 'cmd+k', 'cmd+l'].map(k => run(r, k, nav)), [
				'devhubVim.nav.left', 'devhubVim.nav.down', 'devhubVim.nav.up', 'devhubVim.nav.right', 'devhubVim.nav.left', 'devhubVim.nav.leftArrow',
				'devhubVim.nav.left', 'devhubVim.nav.down', 'devhubVim.nav.up', 'devhubVim.nav.right',
			], place);
			assert.strictEqual(run(r, 'cmd+w', nav), 'devhubVim.nav.next', `Cmd-W Cmd-W in ${place}`);
		}
	});

	test('the user\'s nav remaps hold everywhere: n p c 1 x X v to tab pages and windows; in a comment widget p c x are the widget\'s', () => {
		const r = resolver();
		for (const [place, values] of Object.entries(PLACES)) {
			const nav = { ...values, 'devhubVim.mode': 'nav', 'devhubVim.acceptsMotion': false };
			const comment = place === 'a comment widget';
			assert.deepStrictEqual(['n', 'p', 'c', '1', 'x', 'shift+x', 'v'].map(k => run(r, k, nav)), [
				'devhubVim.tabpage.next',
				comment ? 'devhubVim.nav.lastAccessed' : 'devhubVim.tabpage.previous',
				comment ? 'devhubVim.nav.close' : 'devhubVim.tabpage.new',
				'workbench.action.closeEditorsInOtherGroups',
				comment ? 'devhubVim.nav.quit' : 'runCommands',
				'devhubVim.tabpage.close',
				'workbench.action.splitEditorRight',
			], place);
		}
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
