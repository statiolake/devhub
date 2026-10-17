/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the `:` `/` `?` prompt line.
//
// One line at the bottom of the window, as Vim's command line: full width,
// just above the status bar (at the bottom edge when the status bar is
// hidden), in the window of the editor it was opened from, whatever the
// editor groups and panels are. It is shown only while a prompt is open and
// lies over the bottom of whatever part is there (as a quick input lies over
// the top), so the layout of the parts never changes.
//
// The line is an ordinary one-line CodeEditorWidget (a simple widget like
// the SCM input): typing, the caret, selection, IME, clipboard and undo are
// the editor's own. It is not a Vim editor (devhubVim.contribution.ts
// `vimDrives` leaves editors inside `.devhub-vim-cmdline` alone), so it is
// in insert mode all the time and Esc cancels it. Vim's command-line keys are
// keybindings on `devhubVim.cmdlineFocus` (common/vimCmdline.ts
// CMDLINE_KEYBINDINGS) running `devhubVim.cmdline.*` commands, which
// VimCmdlineController implements. The one key read here is the register
// name after CTRL-R (as `devhubVim.awaitChar` reads the character after `f`).
//
// The context keys are set in the line's own element (a scoped context key
// service), so they hold exactly while it has the focus: devhubVim.cmdlineFocus,
// devhubVim.cmdlineKind, devhubVim.cmdlineEmpty, devhubVim.cmdlineAwaitingRegister,
// and devhubVim.mode == 'cmdline'.
//
// Completion is VS Code's suggest widget on the line's model (scheme
// `devhubvim-cmdline`): ex command names, file names after `:e` `:sp` `:vs`
// `:new` `:tabnew` ..., option names after `:set`, open editors after `:b`.

import { addDisposableListener, getWindow, onDidUnregisterWindow } from '../../../../base/browser/dom.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { applyFontInfo } from '../../../../editor/browser/config/domFontInfo.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorExtensionsRegistry } from '../../../../editor/browser/editorExtensions.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EditorOption, IEditorOptions } from '../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { CompletionItem, CompletionItemKind, CompletionList } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { SnippetController2 } from '../../../../editor/contrib/snippet/browser/snippetController2.js';
import { SuggestController } from '../../../../editor/contrib/suggest/browser/suggestController.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { contrastBorder, editorBackground, editorForeground, registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { PANEL_BORDER } from '../../../common/theme.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import type { IVimCmdlineCompletionSources, IVimCmdlineLine, IVimCmdlineTarget, IVimCmdlineUi, VimCmdlineCompletionItem, VimCmdlineKind } from '../common/vimCmdline.js';
import { VIM_CMDLINE_COMMANDS, VIM_CMDLINE_CONTEXT, VimCmdlineController, cmdlineCompletionContext, cmdlineCompletions, splitFileArg } from '../common/vimCmdline.js';
import { captureKey } from '../common/vimKeys.js';
import './media/vimCmdline.css';

/** Editors inside an element with this class are never Vim editors (devhubVim.contribution.ts `vimDrives`). */
export const VIM_CMDLINE_CLASS = 'devhub-vim-cmdline';
/** The URI scheme of the line's model: completion is registered for it alone. */
export const VIM_CMDLINE_SCHEME = 'devhubvim-cmdline';

export const VIM_CMDLINE_FOCUS = new RawContextKey<boolean>(VIM_CMDLINE_CONTEXT.focus, false, localize('devhubVim.cmdlineFocus', "The Vim prompt line (: / ?) has the keyboard focus."));
const VIM_CMDLINE_KIND = new RawContextKey<string>(VIM_CMDLINE_CONTEXT.kind, '', localize('devhubVim.cmdlineKind', "The kind of the Vim prompt that has the focus: ':' (an ex command), '/' or '?' (a search), or empty."));
const VIM_CMDLINE_EMPTY = new RawContextKey<boolean>(VIM_CMDLINE_CONTEXT.empty, false, localize('devhubVim.cmdlineEmpty', "The Vim prompt line is empty (Backspace cancels it)."));
const VIM_CMDLINE_AWAITING_REGISTER = new RawContextKey<boolean>(VIM_CMDLINE_CONTEXT.awaitingRegister, false, localize('devhubVim.cmdlineAwaitingRegister', "CTRL-R in the Vim prompt waits for a register name."));

registerColor('devhubVim.cmdline.background', editorBackground, localize('devhubVim.cmdline.background', "Background of the Vim prompt line (: / ?) at the bottom of the window."));
registerColor('devhubVim.cmdline.foreground', editorForeground, localize('devhubVim.cmdline.foreground', "Text of the Vim prompt line."));
registerColor('devhubVim.cmdline.prefixForeground', 'devhubVim.cmdline.foreground', localize('devhubVim.cmdline.prefixForeground', "The `:` `/` `?` in front of the Vim prompt line."));
registerColor('devhubVim.cmdline.border', { dark: PANEL_BORDER, light: PANEL_BORDER, hcDark: contrastBorder, hcLight: contrastBorder }, localize('devhubVim.cmdline.border', "The line above the Vim prompt line."));

const REGISTER_PENDING = ModelDecorationOptions.register({
	description: 'devhub-vim-cmdline-register',
	showIfCollapsed: true,
	after: { content: '"', inlineClassName: 'devhub-vim-cmdline-register' },
});

/** Vertical padding of the line, in pixels (and the 1px border above it). */
const PADDING = 2;

/** The Vim editor a prompt was opened from: where focus goes back, what runs the line. */
export interface IVimCmdlineOrigin {
	readonly editor: ICodeEditor;
	readonly target: IVimCmdlineTarget;
	/** The engine's candidates (ex commands, options); open editors are added here. */
	readonly sources: IVimCmdlineCompletionSources;
}

/** The line, in one window: its element, its editor and model, its context keys. */
class CmdlineView extends Disposable {

	readonly container: HTMLElement;
	readonly prefix: HTMLElement;
	readonly editor: CodeEditorWidget;
	readonly model: ITextModel;
	readonly kindKey: IContextKey<string>;
	readonly emptyKey: IContextKey<boolean>;
	readonly awaitingKey: IContextKey<boolean>;
	readonly registerDecoration;
	/** The prompt's listeners on this view (VimCmdline.view). */
	readonly listeners = this._register(new DisposableStore());

	constructor(
		readonly window: CodeWindow,
		readonly parent: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IModelService modelService: IModelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const doc = window.document;
		this.container = doc.createElement('div');
		this.container.className = `${VIM_CMDLINE_CLASS} hidden`;
		this.prefix = this.container.appendChild(doc.createElement('span'));
		this.prefix.className = 'devhub-vim-cmdline-prefix';
		this.prefix.setAttribute('aria-hidden', 'true');
		const input = this.container.appendChild(doc.createElement('div'));
		input.className = 'devhub-vim-cmdline-input';
		parent.appendChild(this.container);
		this._register(toDisposable(() => this.container.remove()));

		const scoped = this._register(contextKeyService.createScoped(this.container));
		VIM_CMDLINE_FOCUS.bindTo(scoped).set(true);
		scoped.createKey('devhubVim.mode', 'cmdline');
		this.kindKey = VIM_CMDLINE_KIND.bindTo(scoped);
		this.emptyKey = VIM_CMDLINE_EMPTY.bindTo(scoped);
		this.awaitingKey = VIM_CMDLINE_AWAITING_REGISTER.bindTo(scoped);
		const services = instantiationService.createChild(new ServiceCollection([IContextKeyService, scoped]), this._store);

		this.model = this._register(modelService.createModel('', null, URI.from({ scheme: VIM_CMDLINE_SCHEME, path: `/${window.vscodeWindowId}` }), true));
		// Created inside `.devhub-vim-cmdline`, so the Vim layer's onCodeEditorAdd (in this constructor) leaves it alone.
		this.editor = this._register(services.createInstance(CodeEditorWidget, input, this.options(), {
			isSimpleWidget: true,
			contributions: EditorExtensionsRegistry.getSomeEditorContributions([SuggestController.ID, SnippetController2.ID]),
		}));
		this.editor.setModel(this.model);
		this.registerDecoration = this.editor.createDecorationsCollection();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('editor')) {
				this.editor.updateOptions(this.options());
				this.syncFont();
			}
		}));
		this.syncFont();
	}

	/** One line, the editor's font, nothing around the text; Tab and Enter are the prompt's keys. */
	private options(): IEditorOptions {
		const c = this.configurationService;
		return {
			ariaLabel: localize('devhubVim.cmdline.aria', "Vim command line"),
			fontFamily: c.getValue<string>('editor.fontFamily'),
			fontSize: c.getValue<number>('editor.fontSize'),
			fontWeight: c.getValue<string>('editor.fontWeight'),
			fontLigatures: c.getValue<boolean | string>('editor.fontLigatures'),
			letterSpacing: c.getValue<number>('editor.letterSpacing'),
			lineHeight: c.getValue<number>('editor.lineHeight'),
			cursorStyle: c.getValue<IEditorOptions['cursorStyle']>('editor.cursorStyle'),
			cursorBlinking: c.getValue<IEditorOptions['cursorBlinking']>('editor.cursorBlinking'),
			accessibilitySupport: c.getValue<IEditorOptions['accessibilitySupport']>('editor.accessibilitySupport'),
			editContext: c.getValue<boolean>('editor.editContext'),
			wordSegmenterLocales: c.getValue<string | string[]>('editor.wordSegmenterLocales'),
			lineNumbers: 'off',
			glyphMargin: false,
			folding: false,
			lineDecorationsWidth: 0,
			lineNumbersMinChars: 0,
			minimap: { enabled: false },
			overviewRulerLanes: 0,
			overviewRulerBorder: false,
			hideCursorInOverviewRuler: true,
			scrollbar: { vertical: 'hidden', horizontal: 'hidden', alwaysConsumeMouseWheel: false, handleMouseWheel: false, useShadows: false },
			scrollBeyondLastLine: false,
			scrollBeyondLastColumn: 0,
			wordWrap: 'off',
			renderLineHighlight: 'none',
			renderWhitespace: 'none',
			guides: { indentation: false },
			selectionHighlight: false,
			occurrencesHighlight: 'off',
			links: false,
			codeLens: false,
			hover: { enabled: 'off' },
			parameterHints: { enabled: false },
			inlineSuggest: { enabled: false },
			stickyScroll: { enabled: false },
			dragAndDrop: false,
			dropIntoEditor: { enabled: false },
			// a context menu would take the focus, and a line that loses it is abandoned
			contextmenu: false,
			fixedOverflowWidgets: true,
			revealHorizontalRightPadding: 5,
			defaultColorDecorators: 'never',
			unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
			// completion only on Tab (devhubVim.cmdline.complete), and Enter is the prompt's
			quickSuggestions: false,
			suggestOnTriggerCharacters: false,
			acceptSuggestionOnEnter: 'off',
			tabCompletion: 'off',
			suggestSelection: 'first',
			snippetSuggestions: 'none',
			suggest: { showWords: false, showSnippets: false, preview: true, insertMode: 'replace', filterGraceful: true, showStatusBar: false, showInlineDetails: true },
			allowVariableLineHeights: false,
			allowVariableFonts: false,
			allowVariableFontsInAccessibilityMode: false,
		};
	}

	private syncFont(): void {
		applyFontInfo(this.prefix, this.editor.getOption(EditorOption.fontInfo));
	}

	get lineHeight(): number {
		return this.editor.getOption(EditorOption.lineHeight);
	}

	get menuVisible(): boolean {
		return !!this.editor.invokeWithinContext(a => a.get(IContextKeyService)).getContextKeyValue<boolean>('suggestWidgetVisible');
	}
}

/** The editor's one line as the controller edits it. */
class EditorLine implements IVimCmdlineLine {
	constructor(private readonly editor: ICodeEditor, private readonly model: ITextModel) { }
	get text(): string {
		return this.model.getLineContent(1);
	}
	get caret(): number {
		const p = this.editor.getPosition();
		return p ? p.column - 1 : 0;
	}
	edit(start: number, end: number, text: string): void {
		const at = start + text.length + 1;
		this.editor.pushUndoStop();
		this.editor.executeEdits('devhubVim', [{ range: new Range(1, start + 1, 1, end + 1), text }], [new Selection(1, at, 1, at)]);
		this.editor.pushUndoStop();
	}
	setCaret(offset: number): void {
		this.editor.setPosition({ lineNumber: 1, column: offset + 1 });
	}
}

interface Session {
	readonly view: CmdlineView;
	readonly origin: IVimCmdlineOrigin;
	readonly controller: VimCmdlineController;
	readonly id: number;
	readonly sources: IVimCmdlineCompletionSources;
}

/**
 * The prompt line of the window: shows the prompt an engine opened (once per
 * prompt), runs its commands, hands focus back. Created when the first prompt
 * opens.
 */
export class VimCmdline extends Disposable {

	static current: VimCmdline | undefined;

	private readonly views = new Map<number, CmdlineView>();
	private session: Session | undefined;
	/** The number of the last prompt shown: an engine's prompt is shown once (VimEngine.cmdlineState.id). */
	private shownId = 0;
	/** The line is being given up because the focus left it: no focus to hand back. */
	private leaving = false;
	private queryBuilder: QueryBuilder | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		VimCmdline.current = this;
		this._register(toDisposable(() => {
			if (VimCmdline.current === this) {
				VimCmdline.current = undefined;
			}
		}));
		this._register(toDisposable(() => {
			for (const v of this.views.values()) {
				v.dispose();
			}
			this.views.clear();
		}));
		this._register(onDidUnregisterWindow(w => {
			const v = this.views.get(w.vscodeWindowId);
			if (v) {
				if (this.session?.view === v) {
					this.close();
				}
				v.dispose();
				this.views.delete(w.vscodeWindowId);
			}
		}));
		this._register(layoutService.onDidLayoutContainer(() => this.layout()));
		this._register(layoutService.onDidLayoutMainContainer(() => this.layout()));
		this._register(layoutService.onDidChangePartVisibility(() => this.layout()));
		// a simple widget's model is not synchronized to the extension host: the provider has to say it can see it
		this._register(languageFeaturesService.completionProvider.register({ scheme: VIM_CMDLINE_SCHEME, hasAccessToAllModels: true }, {
			_debugDisplayName: 'devhubVimCmdline',
			provideCompletionItems: (model, position, _context, token) => this.provideCompletions(model, position.column - 1, token),
		}));
	}

	/** The number of the prompt last shown. */
	get lastShown(): number {
		return this.shownId;
	}

	/** The editor the open prompt came from. */
	get originEditor(): ICodeEditor | undefined {
		return this.session?.origin.editor;
	}

	/** The open prompt's number. */
	get openId(): number | undefined {
		return this.session?.id;
	}

	/** The line has the keyboard focus. */
	get hasFocus(): boolean {
		return !!this.session?.view.editor.hasWidgetFocus();
	}

	/** The line's editor in the window, if made yet (tests, the attach predicate's test). */
	lineEditor(window: CodeWindow): ICodeEditor | undefined {
		return this.views.get(window.vscodeWindowId)?.editor;
	}

	/** Show prompt `id` of `origin`'s engine: its kind, its text, the caret at the end, the focus in the line. */
	open(origin: IVimCmdlineOrigin, kind: VimCmdlineKind, text: string, id: number): void {
		this.close();
		this.shownId = id;
		const view = this.view(getWindow(origin.editor.getContainerDomNode()));
		const engine = origin.target;
		const target: IVimCmdlineTarget = {
			history: k => engine.history(k),
			changed: t => engine.changed(t),
			submit: t => {
				// the origin has the focus again before the line runs, so `:sp`, `:w`, `gq` ... act on it
				this.end(true);
				engine.submit(t);
			},
			cancel: () => {
				this.end(!this.leaving);
				engine.cancel();
			},
			registerText: n => engine.registerText(n),
			prepareRegisters: () => engine.prepareRegisters(),
		};
		const sources: IVimCmdlineCompletionSources = {
			exCommands: () => origin.sources.exCommands(),
			options: () => origin.sources.options(),
			buffers: () => this.buffers(),
		};
		const ui: IVimCmdlineUi = {
			complete: d => this.complete(d),
			acceptCompletion: () => {
				if (view.menuVisible) {
					view.editor.trigger('devhubVim', 'acceptSelectedSuggestion', {});
				}
			},
			awaitingRegister: on => {
				view.awaitingKey.set(on);
				const p = view.editor.getPosition();
				view.registerDecoration.set(on && p ? [{ range: Range.fromPositions(p), options: REGISTER_PENDING }] : []);
			},
		};
		const controller = new VimCmdlineController(kind, new EditorLine(view.editor, view.model), target, sources, ui);
		view.model.setValue(text);
		this.session = { view, origin, controller, id, sources };
		view.kindKey.set(kind);
		view.emptyKey.set(text === '');
		view.awaitingKey.set(false);
		view.registerDecoration.clear();
		view.prefix.textContent = kind;
		view.editor.updateOptions({
			ariaLabel: kind === ':' ? localize('devhubVim.cmdline.ariaEx', "Vim command line, an ex command")
				: kind === '/' ? localize('devhubVim.cmdline.ariaSearch', "Vim command line, search forward")
					: localize('devhubVim.cmdline.ariaSearchBack', "Vim command line, search backward"),
		});
		view.container.classList.remove('hidden');
		this.layout();
		view.editor.setPosition({ lineNumber: 1, column: text.length + 1 });
		view.editor.focus();
	}

	/** Hide the line without running or cancelling anything (the engine closed its prompt itself). */
	close(): void {
		if (this.session) {
			this.end(this.hasFocus);
		}
	}

	/** A `devhubVim.cmdline.*` command, for the open prompt. */
	run(command: string, args: unknown): void {
		try {
			this.session?.controller.run(command, args);
		} catch (err) {
			onUnexpectedError(err);
		}
	}

	private end(refocus: boolean): void {
		const s = this.session;
		if (!s) {
			return;
		}
		this.session = undefined;
		s.view.registerDecoration.clear();
		s.view.awaitingKey.set(false);
		s.view.container.classList.add('hidden');
		if (refocus) {
			s.origin.editor.focus();
		}
	}

	private view(window: CodeWindow): CmdlineView {
		let v = this.views.get(window.vscodeWindowId);
		if (!v) {
			const parent = this.layoutService.getContainer(window);
			const view = v = this.instantiationService.createInstance(CmdlineView, window, parent);
			this.views.set(window.vscodeWindowId, view);
			const store = view.listeners;
			store.add(view.model.onDidChangeContent(() => this.contentChanged(view)));
			store.add(view.editor.onKeyDown(e => {
				// the register name after CTRL-R: the one key the prompt reads itself
				const s = this.session;
				if (s?.view !== view || !s.controller.awaitingRegister) {
					return;
				}
				const key = captureKey(e.browserEvent);
				if (key !== undefined) {
					e.preventDefault();
					e.stopPropagation();
					s.controller.registerKey(key);
				}
			}));
			store.add(view.editor.onDidBlurEditorWidget(() => {
				// the focus went elsewhere (a click into another editor, a quick pick): the prompt is
				// abandoned, as a rename box is; a window that lost the focus keeps it
				setTimeout(() => {
					const s = this.session;
					if (s?.view === view && !view.editor.hasWidgetFocus() && view.window.document.hasFocus()) {
						this.leaving = true;
						try {
							s.controller.cancel();
						} finally {
							this.leaving = false;
						}
					}
				}, 0);
			}));
			store.add(addDisposableListener(window, 'resize', () => this.layout()));
			store.add(view.editor.onDidChangeConfiguration(e => {
				if (e.hasChanged(EditorOption.lineHeight) || e.hasChanged(EditorOption.fontInfo)) {
					this.layout();
				}
			}));
		}
		return v;
	}

	private contentChanged(view: CmdlineView): void {
		const model = view.model;
		if (model.getLineCount() > 1) {
			// one line: what is pasted with line breaks becomes one line
			queueMicrotask(() => {
				if (!model.isDisposed() && model.getLineCount() > 1) {
					view.editor.executeEdits('devhubVim', [{ range: model.getFullModelRange(), text: model.getLinesContent().join(' ') }]);
				}
			});
			return;
		}
		view.emptyKey.set(model.getValueLength() === 0);
		const s = this.session;
		if (s?.view === view) {
			s.controller.textChanged();
		}
	}

	/** Above the status bar of the line's window, the window's full width. */
	private layout(): void {
		const s = this.session;
		if (!s) {
			return;
		}
		const v = s.view;
		const statusbar = this.layoutService.isVisible(Parts.STATUSBAR_PART, v.window) ? this.layoutService.getContainer(v.window, Parts.STATUSBAR_PART) : undefined;
		const bottom = statusbar ? Math.max(0, Math.round(v.parent.getBoundingClientRect().bottom - statusbar.getBoundingClientRect().top)) : 0;
		const lineHeight = v.lineHeight;
		v.container.style.bottom = `${bottom}px`;
		v.container.style.height = `${lineHeight + 2 * PADDING + 1}px`;
		const width = v.container.clientWidth - v.prefix.offsetWidth - parseFloat(v.window.getComputedStyle(v.container).paddingLeft || '0') * 2;
		v.editor.layout({ width: Math.max(1, width || v.parent.clientWidth), height: lineHeight });
	}

	// ---- completion -----------------------------------------------------------------

	/** Tab: through the menu when it shows; the one match straight into the line; otherwise the menu. */
	private complete(direction: 'next' | 'previous'): boolean {
		const s = this.session;
		if (!s) {
			return true;
		}
		const v = s.view;
		if (v.menuVisible) {
			v.editor.trigger('devhubVim', direction === 'next' ? 'selectNextSuggestion' : 'selectPrevSuggestion', {});
			return true;
		}
		const line = s.controller.line;
		const ctx = cmdlineCompletionContext(line.text, line.caret);
		if (!ctx) {
			return true;
		}
		if (ctx.kind !== 'file') {
			const items = cmdlineCompletions(ctx, s.sources);
			if (!items.length) {
				return true;
			}
			if (items.length === 1) {
				line.edit(ctx.start, line.caret, items[0].label);
				return true;
			}
		}
		v.editor.trigger('devhubVim', 'editor.action.triggerSuggest', {});
		return true;
	}

	private async provideCompletions(model: ITextModel, caret: number, token: CancellationToken): Promise<CompletionList | undefined> {
		const s = this.session;
		if (!s || s.view.model !== model || s.controller.kind !== ':') {
			return undefined;
		}
		const text = model.getLineContent(1);
		const ctx = cmdlineCompletionContext(text, caret);
		if (!ctx) {
			return undefined;
		}
		const items = ctx.kind === 'file' ? await this.fileItems(ctx.typed, s.origin, token) : cmdlineCompletions(ctx, s.sources);
		let end = caret;
		const word = ctx.kind === 'command' ? /[A-Za-z0-9]/ : /\S/;
		while (end < text.length && word.test(text[end])) {
			end++;
		}
		const range = { insert: new Range(1, ctx.start + 1, 1, caret + 1), replace: new Range(1, ctx.start + 1, 1, end + 1) };
		const kinds: Record<VimCmdlineCompletionItem['kind'], CompletionItemKind> = {
			command: CompletionItemKind.Function, option: CompletionItemKind.Property, buffer: CompletionItemKind.File,
			file: CompletionItemKind.File, folder: CompletionItemKind.Folder,
		};
		const suggestions: CompletionItem[] = items.map((it, i) => ({
			label: it.label,
			detail: it.detail,
			kind: kinds[it.kind],
			insertText: it.label,
			filterText: it.label,
			sortText: String(i).padStart(5, '0'),
			range,
			// a directory taken with CTRL-Y: on into it
			...(it.kind === 'folder' ? { command: { id: 'editor.action.triggerSuggest', title: '' } } : {}),
		}));
		return { suggestions, incomplete: ctx.kind === 'file' };
	}

	/** Open editors, most recent first, for `:b`. */
	private buffers(): { name: string; detail: string }[] {
		const seen = new Set<string>();
		const out: { name: string; detail: string }[] = [];
		for (const { editor } of this.editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
			const name = editor.getName();
			const detail = editor.getDescription() ?? '';
			const k = `${name}\0${detail}`;
			if (!seen.has(k)) {
				seen.add(k);
				out.push({ name, detail });
			}
		}
		return out;
	}

	/** The directory relative names start from: the workspace folder of the origin's file (the first one), or its directory. */
	private baseDirectory(origin: IVimCmdlineOrigin): URI | undefined {
		const resource = origin.editor.getModel()?.uri;
		const folder = (resource && this.workspaceService.getWorkspaceFolder(resource)) ?? this.workspaceService.getWorkspace().folders[0];
		if (folder) {
			return folder.uri;
		}
		return resource && resource.scheme !== 'untitled' ? dirname(resource) : undefined;
	}

	/**
	 * File names for `:e` `:sp` ...: the entries of the directory typed so far
	 * (relative to the workspace folder, or absolute), as Vim lists them, and
	 * for a bare name also the workspace's files that match it (quick open's
	 * file search).
	 */
	private async fileItems(typed: string, origin: IVimCmdlineOrigin, token: CancellationToken): Promise<VimCmdlineCompletionItem[]> {
		const base = this.baseDirectory(origin);
		if (!base) {
			return [];
		}
		const { dir, base: name } = splitFileArg(typed);
		const out: VimCmdlineCompletionItem[] = [];
		const seen = new Set<string>();
		const add = (label: string, kind: 'file' | 'folder', detail?: string) => {
			if (!seen.has(label)) {
				seen.add(label);
				out.push({ label, kind, ...(detail ? { detail } : {}) });
			}
		};
		try {
			const path = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
			const dirUri = path.startsWith('/') ? base.with({ path }) : path ? joinPath(base, path) : base;
			const stat = await this.fileService.resolve(dirUri);
			const children = [...(stat.children ?? [])]
				.filter(c => !c.name.startsWith('.') || name.startsWith('.'))
				.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
			for (const c of children) {
				add(dir + c.name + (c.isDirectory ? '/' : ''), c.isDirectory ? 'folder' : 'file');
			}
		} catch {
			// not a directory (yet): the search below, or nothing
		}
		const folders = this.workspaceService.getWorkspace().folders;
		if (!dir && name && folders.length && !token.isCancellationRequested) {
			try {
				this.queryBuilder ??= this.instantiationService.createInstance(QueryBuilder);
				const query = this.queryBuilder.file(folders, { filePattern: name, sortByScore: true, maxResults: 50 });
				const found = await this.searchService.fileSearch(query, token);
				for (const r of found.results) {
					const rel = relativePath(base, r.resource);
					if (rel) {
						add(rel, 'file');
					}
				}
			} catch {
				// a search that failed or was cancelled completes nothing more
			}
		}
		return out;
	}
}

const CMDLINE_COMMAND_DESCRIPTIONS: Record<typeof VIM_CMDLINE_COMMANDS[number], string> = {
	'devhubVim.cmdline.submit': localize('devhubVim.cmdline.submit', "Vim prompt: run the line { accept?: true takes the selected completion first } (Enter)"),
	'devhubVim.cmdline.cancel': localize('devhubVim.cmdline.cancel', "Vim prompt: abandon the line (Esc, CTRL-C, CTRL-[, Backspace on an empty line)"),
	'devhubVim.cmdline.historyPrev': localize('devhubVim.cmdline.historyPrev', "Vim prompt: older history entry { filter?: false for all of them } (Up: those starting like the line; CTRL-P, Shift+Up, PageUp: all)"),
	'devhubVim.cmdline.historyNext': localize('devhubVim.cmdline.historyNext', "Vim prompt: newer history entry { filter?: false for all of them } (Down; CTRL-N, Shift+Down, PageDown)"),
	'devhubVim.cmdline.insertRegister': localize('devhubVim.cmdline.insertRegister', "Vim prompt: insert a register { register?: name; without one the next key names it } (CTRL-R)"),
	'devhubVim.cmdline.deleteWord': localize('devhubVim.cmdline.deleteWord', "Vim prompt: delete the word before the caret (CTRL-W)"),
	'devhubVim.cmdline.deleteToStart': localize('devhubVim.cmdline.deleteToStart', "Vim prompt: delete everything before the caret (CTRL-U)"),
	'devhubVim.cmdline.complete': localize('devhubVim.cmdline.complete', "Vim prompt: complete the ex command, file, option or buffer name { direction?: 'previous' } (Tab, Shift+Tab)"),
};

for (const id of VIM_CMDLINE_COMMANDS) {
	CommandsRegistry.registerCommand({
		id,
		handler: (_accessor, args: unknown) => VimCmdline.current?.run(id, args),
		metadata: { description: CMDLINE_COMMAND_DESCRIPTIONS[id], args: [{ name: 'args', isOptional: true, schema: { type: 'object' } }] },
	});
}
