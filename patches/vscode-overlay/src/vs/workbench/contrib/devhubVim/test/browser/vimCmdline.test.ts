/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the Vim prompt line (browser/vimCmdline.ts) — a one-line editor at
// the bottom of the window that the contribution shows for the prompt an
// engine opened, that is never a Vim editor itself, whose keys are
// keybindings on devhubVim.cmdlineFocus, and whose completion is VS Code's
// suggest on its own model.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ModalTextInput } from '../../../../../editor/browser/controller/editContext/modalTextInput.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { CompletionItemLabel, CompletionList, CompletionTriggerKind } from '../../../../../editor/common/languages.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { Context as SuggestContext } from '../../../../../editor/contrib/suggest/browser/suggest.js';
import { SuggestController } from '../../../../../editor/contrib/suggest/browser/suggestController.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { TestCodeEditor, createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IFileQuery, ISearchComplete, ISearchService } from '../../../../services/search/common/search.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { DevhubVim, vimDrives } from '../../browser/devhubVim.contribution.js';
import { VIM_CMDLINE_AUTOCOMPLETE_SETTING, VIM_CMDLINE_CLASS, VimCmdline } from '../../browser/vimCmdline.js';
import { VIM_CMDLINE_COMMANDS } from '../../common/vimCmdline.js';

const ROOT = URI.file('/ws');

suite('DevHub Vim: the prompt line', () => {

	interface Internals {
		readonly editors: Map<ICodeEditor, unknown>;
	}

	interface Env {
		readonly vim: DevhubVim;
		readonly origin: TestCodeEditor;
		readonly instantiation: IInstantiationService;
		readonly configuration: TestConfigurationService;
		readonly root: HTMLElement;
		/** The line's editor, once a prompt has been shown. */
		line(): ICodeEditor;
		/** A prompt command, as its keybinding runs it. */
		run(id: string, args?: unknown): void;
		type(text: string): void;
		visible(): boolean;
	}

	/** The workspace file search the line's completion runs (quick open's), as a test sets it. */
	let fileSearch: ((query: IFileQuery, token?: CancellationToken) => Promise<ISearchComplete>) | undefined;

	function withPrompt(fn: (env: Env) => void | Promise<void>): Promise<void> {
		const disposables = new DisposableStore();
		const root = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		const run = async () => {
			const configurationService = new TestConfigurationService({ 'devhub.vim.enabled': true });
			const contextKeyService = disposables.add(new ContextKeyService(configurationService));
			const folder = { uri: ROOT, name: 'ws', index: 0, toResource: (p: string) => URI.joinPath(ROOT, p) } as unknown as IWorkspaceFolder;
			const instantiation = createCodeEditorServices(disposables, new ServiceCollection(
				[IConfigurationService, configurationService],
				[IContextKeyService, contextKeyService],
				[IStatusbarService, new class extends mock<IStatusbarService>() { override addEntry(): IStatusbarEntryAccessor { return { update() { }, dispose() { } }; } }],
				[ILabelService, new class extends mock<ILabelService>() { }],
				[IWorkbenchLayoutService, new class extends mock<IWorkbenchLayoutService>() {
					override getContainer(): HTMLElement { return root; }
					override isVisible(): boolean { return false; }
					override readonly onDidLayoutContainer = Event.None;
					override readonly onDidLayoutMainContainer = Event.None;
					override readonly onDidChangePartVisibility = Event.None;
				}],
				[IEditorService, new class extends mock<IEditorService>() {
					override getEditors() { return [{ editor: { getName: () => 'main.ts', getDescription: () => 'src' } }, { editor: { getName: () => 'notes.md', getDescription: () => '' } }] as never; }
				}],
				[IWorkspaceContextService, new class extends mock<IWorkspaceContextService>() {
					override getWorkspace(): IWorkspace { return { id: 'ws', folders: [folder] } as unknown as IWorkspace; }
					override getWorkspaceFolder() { return folder; }
				}],
				[IFileService, new class extends mock<IFileService>() {
					override async resolve(resource: URI) {
						const names = resource.path === '/ws' ? [['src', true], ['README.md', false], ['.git', true]] : resource.path === '/ws/src' ? [['main.ts', false]] : undefined;
						if (!names) {
							throw new Error('not found');
						}
						return { children: names.map(([name, isDirectory]) => ({ name, isDirectory })) } as unknown as IFileStatWithMetadata;
					}
				}],
				[ISearchService, new class extends mock<ISearchService>() {
					override fileSearch(query: IFileQuery, token?: CancellationToken): Promise<ISearchComplete> {
						return fileSearch ? fileSearch(query, token) : Promise.reject(new Error('no search'));
					}
				}],
			));
			const vim = disposables.add(instantiation.createInstance(DevhubVim));
			const element = root.appendChild(mainWindow.document.createElement('div'));
			const origin = disposables.add(instantiation.createInstance(TestCodeEditor, element, {}, { contributions: [] }));
			origin.setModel(disposables.add(createTextModel('abc abc\nb')));
			origin.setHasTextFocus(true);
			EditorContextKeys.editorTextFocus.bindTo(origin.invokeWithinContext(a => a.get(IContextKeyService))).set(true);
			vim.update();
			const env: Env = {
				vim, origin, instantiation, root, configuration: configurationService,
				line: () => VimCmdline.current!.lineEditor(mainWindow)!,
				run: (id, args) => instantiation.invokeFunction(a => CommandsRegistry.getCommand(id)!.handler(a, args)),
				type: text => env.line().trigger('keyboard', 'type', { text }),
				visible: () => !!root.querySelector(`.${VIM_CMDLINE_CLASS}:not(.hidden)`),
			};
			await fn(env);
		};
		return run().finally(() => {
			fileSearch = undefined;
			disposables.dispose();
			root.remove();
		});
	}

	test('`/` shows the line in the window\'s container, with the focus keys in its own scope; it is not a Vim editor', () => withPrompt(({ vim, origin, line, visible }) => {
		vim.execute('devhubVim.cmdline', { kind: '/' });
		assert.strictEqual(visible(), true);
		const editor = line();
		assert.ok(editor.getContainerDomNode().closest(`.${VIM_CMDLINE_CLASS}`));
		assert.strictEqual(vimDrives(editor.getContainerDomNode()), false);
		assert.strictEqual((vim as unknown as Internals).editors.has(editor), false);
		assert.strictEqual(ModalTextInput.isModal(editor.getId()), false);
		const keys = editor.invokeWithinContext(a => a.get(IContextKeyService));
		assert.strictEqual(keys.getContextKeyValue('devhubVim.cmdlineFocus'), true);
		assert.strictEqual(keys.getContextKeyValue('devhubVim.cmdlineKind'), '/');
		assert.strictEqual(keys.getContextKeyValue('devhubVim.cmdlineEmpty'), true);
		assert.strictEqual(keys.getContextKeyValue('devhubVim.mode'), 'cmdline');
		// the origin lost the focus to the line (a test editor has no view to lose it by itself)
		origin.setHasTextFocus(false);
		vim.update();
		assert.strictEqual(keys.getContextKeyValue('devhubVim.active'), false);
		assert.strictEqual(editor.getModel()?.uri.scheme, 'devhubvim-cmdline');
		// typing is the editor's own: insert mode all the time
		const prefix = editor.getContainerDomNode().closest(`.${VIM_CMDLINE_CLASS}`)!.querySelector('.devhub-vim-cmdline-prefix');
		assert.strictEqual(prefix?.textContent, '/');
	}));

	test('typing previews the match in the origin; Enter runs the search there and hides the line', () => withPrompt(({ vim, origin, line, run, type, visible }) => {
		origin.setPosition({ lineNumber: 1, column: 1 });
		vim.execute('devhubVim.cmdline', { kind: '/' });
		type('bc');
		assert.strictEqual(line().getModel()?.getValue(), 'bc');
		assert.strictEqual(line().invokeWithinContext(a => a.get(IContextKeyService)).getContextKeyValue('devhubVim.cmdlineEmpty'), false);
		const inc = origin.getModel()!.getAllDecorations().filter(d => d.options.description === 'devhub-vim-incsearch');
		assert.deepStrictEqual(inc.map(d => d.range.startColumn), [2]);
		run('devhubVim.cmdline.submit');
		assert.strictEqual(visible(), false);
		assert.deepStrictEqual(origin.getPosition()?.toJSON(), { lineNumber: 1, column: 2 });
		assert.strictEqual(origin.getModel()!.getAllDecorations().filter(d => d.options.description === 'devhub-vim-incsearch').length, 0);
	}));

	test('`:` from a count starts with .,.+N-1; Esc cancels and clears what waited; a prompt the engine closes is hidden', () => withPrompt(({ vim, line, run, visible }) => {
		vim.execute('devhubVim.count', { digit: 3 });
		vim.execute('devhubVim.cmdline', { kind: ':' });
		assert.strictEqual(line().getModel()?.getValue(), '.,.+2');
		assert.deepStrictEqual(line().getPosition()?.toJSON(), { lineNumber: 1, column: 6 });
		// the completion menu goes with the line (one Esc, as Vim's wildmenu)
		const suggest = SuggestController.get(line())!;
		const menu = SuggestContext.Visible.bindTo(line().invokeWithinContext(a => a.get(IContextKeyService)));
		menu.set(true);
		let hidden = 0;
		const cancelSuggest = suggest.cancelSuggestWidget;
		// (the real one would build the suggest widget, which needs a layout this DOM has not)
		suggest.cancelSuggestWidget = () => { hidden++; };
		run('devhubVim.cmdline.cancel');
		suggest.cancelSuggestWidget = cancelSuggest;
		menu.set(false);
		assert.strictEqual(hidden, 1);
		assert.strictEqual(visible(), false);
		vim.execute('devhubVim.operator', { operator: 'delete' });
		vim.execute('devhubVim.cmdline', { kind: '/' });
		assert.strictEqual(visible(), true);
		// the engine closes its prompt itself (here Esc run on the origin): the line goes
		vim.execute('devhubVim.escape', undefined);
		assert.strictEqual(visible(), false);
		assert.strictEqual(VimCmdline.current?.openId, undefined);
	}));

	test('CTRL-W / CTRL-U act at the caret, the history is the engine\'s, CTRL-R inserts a register', () => withPrompt(({ vim, line, run, type }) => {
		vim.execute('devhubVim.cmdline', { kind: ':' });
		type('s/foo bar/x');
		line().setPosition({ lineNumber: 1, column: 10 });
		run('devhubVim.cmdline.deleteWord');
		assert.strictEqual(line().getModel()?.getValue(), 's/foo /x');
		run('devhubVim.cmdline.deleteToStart');
		assert.strictEqual(line().getModel()?.getValue(), '/x');
		run('devhubVim.cmdline.deleteToStart');
		type('noh');
		run('devhubVim.cmdline.submit');
		vim.execute('devhubVim.cmdline', { kind: ':' });
		type('n');
		run('devhubVim.cmdline.historyPrev');
		assert.strictEqual(line().getModel()?.getValue(), 'noh/x');
		run('devhubVim.cmdline.historyNext');
		assert.strictEqual(line().getModel()?.getValue(), 'n');
		run('devhubVim.cmdline.insertRegister', { register: '%' });
		assert.ok(line().getModel()?.getValue().startsWith('n'));
		run('devhubVim.cmdline.cancel');
	}));

	test('completion on the line\'s model: ex commands, :set options, :b open editors, :e files', () => withPrompt(async ({ vim, line, type, instantiation }) => {
		vim.execute('devhubVim.cmdline', { kind: ':' });
		const model = line().getModel()!;
		const providers = instantiation.invokeFunction(a => a.get(ILanguageFeaturesService)).completionProvider.ordered(model);
		assert.strictEqual(providers.length >= 1, true);
		const labels = async (text: string) => {
			model.setValue(text);
			const list = await providers[0].provideCompletionItems(model, new Position(1, text.length + 1), { triggerKind: CompletionTriggerKind.Invoke }, CancellationToken.None);
			return (list?.suggestions ?? []).map(s => typeof s.label === 'string' ? s.label : (s.label as CompletionItemLabel).label);
		};
		assert.deepStrictEqual(await labels('spl'), ['split']);
		assert.deepStrictEqual(await labels('set hls'), ['hlsearch', 'hls'].filter(l => l.startsWith('hls')));
		assert.deepStrictEqual(await labels('b ma'), ['main.ts']);
		assert.deepStrictEqual(await labels('e '), ['README.md', 'src/'], 'the directory, sorted, without dot files');
		assert.deepStrictEqual(await labels('e src/'), ['src/main.ts']);
		assert.deepStrictEqual(await labels('s/x'), []);
		// Tab with one match puts it in the line (no menu)
		model.setValue('');
		type('tabo');
		VimCmdline.current!.run('devhubVim.cmdline.complete', undefined);
		assert.strictEqual(model.getValue(), 'tabonly');
	}));

	test(':e {file} and :sp {file} run devhubVim.edit / devhubVim.open with the file and the editor they came from', () => withPrompt(async ({ vim, origin, run, type }) => {
		const seen: [string, unknown][] = [];
		// the commands the ex lines run, as the contribution's command service gets them
		const service = vim.commandService;
		const execute = service.executeCommand;
		service.executeCommand = async (id: string, ...args: unknown[]) => { seen.push([id, args[0]]); return undefined as never; };
		try {
			const from = origin.getModel()!.uri.toString();
			vim.execute('devhubVim.cmdline', { kind: ':' });
			type('e src/main.ts');
			run('devhubVim.cmdline.submit');
			vim.execute('devhubVim.cmdline', { kind: ':' });
			type('sp %:h/x');
			run('devhubVim.cmdline.submit');
			await new Promise(r => setTimeout(r, 0));
			assert.deepStrictEqual(seen, [
				['devhubVim.edit', { file: 'src/main.ts', bang: false, from }],
				['workbench.action.splitEditorUp', undefined],
				['devhubVim.open', { file: '%:h/x', replace: true, from }],
			]);
		} finally {
			service.executeCommand = execute;
		}
	}));

	/** The line's suggest controller with the methods the prompt's keys reach recorded (the real widget needs a layout this DOM has not). */
	function recordSuggest(editor: ICodeEditor): { calls: string[]; restore(): void } {
		const suggest = SuggestController.get(editor)!;
		const calls: string[] = [];
		const saved = { accept: suggest.acceptSelectedSuggestion, next: suggest.selectNextSuggestion, trigger: suggest.triggerSuggest, cancel: suggest.cancelSuggestWidget };
		suggest.acceptSelectedSuggestion = () => { calls.push('accept'); };
		suggest.selectNextSuggestion = () => { calls.push('next'); };
		suggest.triggerSuggest = (_from, auto) => { calls.push(auto ? 'trigger auto' : 'trigger'); };
		suggest.cancelSuggestWidget = () => { calls.push('cancel'); };
		return {
			calls,
			restore: () => {
				suggest.acceptSelectedSuggestion = saved.accept;
				suggest.selectNextSuggestion = saved.next;
				suggest.triggerSuggest = saved.trigger;
				suggest.cancelSuggestWidget = saved.cancel;
			},
		};
	}

	/** The menu as the suggest widget's context keys say: shown, and whether a match in it is selected. */
	function menuState(editor: ICodeEditor, visible: boolean, picked: boolean): void {
		const keys = editor.invokeWithinContext(a => a.get(IContextKeyService));
		SuggestContext.Visible.bindTo(keys).set(visible);
		SuggestContext.HasFocusedSuggestion.bindTo(keys).set(picked);
	}

	test('a `:` line completes as you type (space and `/` trigger it), with nothing selected; `/` and `?` do not', () => withPrompt(({ vim, line, run, instantiation }) => {
		vim.execute('devhubVim.cmdline', { kind: ':' });
		const editor = line();
		assert.deepStrictEqual(editor.getOption(EditorOption.quickSuggestions), { other: 'on', comments: 'on', strings: 'on' });
		assert.strictEqual(editor.getOption(EditorOption.suggestOnTriggerCharacters), true);
		const suggest = editor.getOption(EditorOption.suggest);
		assert.strictEqual(suggest.selectionMode, 'never', 'a menu that shows by itself has nothing selected');
		assert.strictEqual(suggest.filterGraceful, true);
		assert.strictEqual(editor.getOption(EditorOption.acceptSuggestionOnEnter), 'off');
		assert.strictEqual(editor.getOption(EditorOption.tabCompletion), 'off');
		const providers = instantiation.invokeFunction(a => a.get(ILanguageFeaturesService)).completionProvider.ordered(editor.getModel()!);
		assert.deepStrictEqual([...providers[0].triggerCharacters ?? []].sort(), [' ', '/']);
		run('devhubVim.cmdline.cancel');
		for (const kind of ['/', '?']) {
			vim.execute('devhubVim.cmdline', { kind });
			assert.deepStrictEqual(line().getOption(EditorOption.quickSuggestions), { other: 'off', comments: 'off', strings: 'off' }, kind);
			assert.strictEqual(line().getOption(EditorOption.suggestOnTriggerCharacters), false, kind);
			run('devhubVim.cmdline.cancel');
		}
	}));

	test('devhub.vim.cmdline.autoComplete off: the menu shows on Tab only', () => withPrompt(({ vim, line, run, configuration }) => {
		void configuration.setUserConfiguration(VIM_CMDLINE_AUTOCOMPLETE_SETTING, false);
		vim.execute('devhubVim.cmdline', { kind: ':' });
		assert.deepStrictEqual(line().getOption(EditorOption.quickSuggestions), { other: 'off', comments: 'off', strings: 'off' });
		assert.strictEqual(line().getOption(EditorOption.suggestOnTriggerCharacters), false);
		run('devhubVim.cmdline.cancel');
	}));

	test('Enter with the menu open and nothing picked runs what was typed; a picked match is taken first; Tab picks', () => withPrompt(async ({ vim, origin, line, run, type }) => {
		const seen: [string, unknown][] = [];
		const service = vim.commandService;
		const execute = service.executeCommand;
		service.executeCommand = async (id: string, ...args: unknown[]) => { seen.push([id, args[0]]); return undefined as never; };
		const from = origin.getModel()!.uri.toString();
		try {
			vim.execute('devhubVim.cmdline', { kind: ':' });
			type('e src/ma');
			const rec = recordSuggest(line());
			try {
				// the menu showed by itself: nothing in it is selected
				menuState(line(), true, false);
				run('devhubVim.cmdline.complete');
				assert.deepStrictEqual(rec.calls, ['next'], 'Tab selects in the menu');
				rec.calls.length = 0;
				// Enter (and CTRL-M, which takes a match when there is one) with nothing picked
				run('devhubVim.cmdline.submit', { accept: true });
				assert.deepStrictEqual(rec.calls.filter(c => c === 'accept'), []);
			} finally {
				menuState(line(), false, false);
				rec.restore();
			}
			vim.execute('devhubVim.cmdline', { kind: ':' });
			type('e src/ma');
			const rec2 = recordSuggest(line());
			try {
				menuState(line(), true, true);
				run('devhubVim.cmdline.submit', { accept: true });
				assert.deepStrictEqual(rec2.calls.filter(c => c === 'accept'), ['accept'], 'a picked match is taken');
			} finally {
				menuState(line(), false, false);
				rec2.restore();
			}
			await new Promise(r => setTimeout(r, 0));
			assert.deepStrictEqual(seen, [
				['devhubVim.edit', { file: 'src/ma', bang: false, from }],
				['devhubVim.edit', { file: 'src/ma', bang: false, from }],
			]);
		} finally {
			service.executeCommand = execute;
		}
	}));

	test('file completion as you type: the directory at once, the search after a pause, cancelled by a newer name, and merged in when it answers', () => withPrompt(async ({ vim, line }) => {
		const searches: { pattern: string; token?: CancellationToken; resolve(names: string[]): void }[] = [];
		fileSearch = (query, token) => new Promise<ISearchComplete>(resolve => {
			searches.push({ pattern: query.filePattern ?? '', token, resolve: names => resolve({ results: names.map(n => ({ resource: URI.joinPath(ROOT, n) })), messages: [] }) });
		});
		vim.execute('devhubVim.cmdline', { kind: ':' });
		const cmdline = VimCmdline.current!;
		// (quick open's query builder needs the workbench; the search service gets the pattern)
		(cmdline as unknown as { queryBuilder: unknown }).queryBuilder = { file: (_folders: unknown, o: { filePattern: string }) => ({ filePattern: o.filePattern }) };
		const model = line().getModel()!;
		const ask = async (text: string, triggerKind: CompletionTriggerKind) => {
			model.setValue(text);
			line().setPosition({ lineNumber: 1, column: text.length + 1 });
			const providers = vim.languageFeaturesService.completionProvider.ordered(model);
			const t0 = Date.now();
			const list = await providers[0].provideCompletionItems(model, new Position(1, text.length + 1), { triggerKind }, CancellationToken.None) as CompletionList;
			return { labels: list.suggestions.map(s => s.label as string), incomplete: list.incomplete, ms: Date.now() - t0 };
		};
		const rec = recordSuggest(line());
		try {
			// typed: answers at once with what the directory has, no search yet (it waits for a pause)
			const first = await ask('e m', CompletionTriggerKind.TriggerForIncompleteCompletions);
			assert.deepStrictEqual([first.labels, first.incomplete], [['README.md', 'src/'], true]);
			assert.ok(first.ms < 1000);
			assert.strictEqual(searches.length, 0);
			const second = await ask('e ma', CompletionTriggerKind.TriggerForIncompleteCompletions);
			assert.deepStrictEqual(second.labels, ['README.md', 'src/']);
			await new Promise(r => setTimeout(r, 200));
			// only the last name was searched for: the first never started
			assert.deepStrictEqual(searches.map(s => s.pattern), ['ma']);
			searches[0].resolve(['src/main.ts']);
			await new Promise(r => setTimeout(r, 0));
			// the menu is asked again, as typing asks it (nothing selected)
			assert.deepStrictEqual(rec.calls, ['trigger auto']);
			const third = await ask('e ma', CompletionTriggerKind.TriggerForIncompleteCompletions);
			assert.deepStrictEqual(third.labels, ['README.md', 'src/', 'src/main.ts'], 'the answer is kept for the same name');
			// a newer name cancels the search in flight
			await ask('e mai', CompletionTriggerKind.TriggerForIncompleteCompletions);
			await new Promise(r => setTimeout(r, 200));
			assert.deepStrictEqual(searches.map(s => s.pattern), ['ma', 'mai']);
			await ask('e mx', CompletionTriggerKind.TriggerForIncompleteCompletions);
			assert.strictEqual(searches[1].token?.isCancellationRequested, true);
			// Tab (an explicit request) waits for the search
			rec.calls.length = 0;
			const tab = ask('e READ', CompletionTriggerKind.Invoke);
			await new Promise(r => setTimeout(r, 0));
			assert.deepStrictEqual(searches.map(s => s.pattern), ['ma', 'mai', 'READ']);
			searches[2].resolve(['docs/READING.md']);
			assert.deepStrictEqual((await tab).labels, ['README.md', 'src/', 'docs/READING.md']);
			assert.deepStrictEqual(rec.calls, []);
		} finally {
			rec.restore();
		}
	}));

	test('every prompt command is registered with a keybinding on devhubVim.cmdlineFocus, and CTRL-W\'s nav prefix is not there', () => {
		const defaults = KeybindingsRegistry.getDefaultKeybindings();
		for (const id of VIM_CMDLINE_COMMANDS) {
			assert.ok(CommandsRegistry.getCommand(id), id);
			const rules = defaults.filter(k => k.command === id);
			assert.ok(rules.length > 0, id);
			for (const r of rules) {
				const when = r.when?.serialize() ?? '';
				assert.ok(when.includes('devhubVim.cmdlineFocus') && when.includes('config.devhub.vim.enabled'), `${id}: ${when}`);
			}
		}
		const nav = defaults.filter(k => k.command === 'devhubVim.nav.enter');
		assert.ok(nav.length > 0 && nav.every(k => k.when?.serialize().includes('!devhubVim.cmdlineFocus')));
	});
});
