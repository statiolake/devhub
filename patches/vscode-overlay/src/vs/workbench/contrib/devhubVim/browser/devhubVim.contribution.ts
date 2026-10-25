/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the workbench half.
//
// Design: Vim keys are native VS Code keybindings.
//
// * The engine (../common/vimEngine.ts) is commands + state + context keys.
//   Every Vim action is a command with args - `devhubVim.motion {motion}`,
//   `devhubVim.operator {operator}`, `devhubVim.textObjectPrefix {kind}` /
//   `devhubVim.textObject {object}`, `devhubVim.count {digit}`,
//   `devhubVim.register {name}`, `devhubVim.mode {to, at}`,
//   `devhubVim.action {action}`, `devhubVim.mark {char}`,
//   `devhubVim.scroll {...}`, `devhubVim.insert {action}`,
//   `devhubVim.run {command}`, `devhubVim.repeat {command, count}`,
//   `devhubVim.awaitChar {then}`,
//   `devhubVim.cmdline {kind}`, `devhubVim.search`, `devhubVim.ex {command}`,
//   `devhubVim.escape` - run on the focused Vim editor. The engine keeps the
//   grammar (count, register, pending operator / text object, visual range,
//   marks, last change, macros) and composes: `d` marks an operator
//   pending and the next motion or text object command completes it,
//   whatever key ran it. The behaviour is Neovim's, defaults included.
//   Other commands get the count as an argument: `devhubVim.run` and
//   `devhubVim.repeat` have `${count}` `${rawCount}` `${register}` `${char}`
//   put into their args where a key runs them (VimEngine.expandVimState),
//   and are plain functions of their args after that.
// * The default keymap (../common/vimKeymap.ts) is registered here as
//   ordinary default keybindings (KeybindingsRegistry), each with a `when` on
//   the context keys below. They show in the Keyboard Shortcuts editor,
//   keybindings.json overrides them, `-devhubVim.motion` removes one, and a
//   user may bind any other command in a Vim mode (it just does not compose
//   with counts or operators). The editor's own keys that type or erase at
//   the caret (Backspace, Delete, Tab, Shift-Tab, word / line-start /
//   line-end deletes, insert line above / below, transpose, line break, and
//   their macOS Emacs aliases) do not apply outside insert and replace mode
//   at all: their `when` has EditorContextKeys.devhubVimAllowsTyping, so in
//   normal, visual, operator-pending and nav mode such a key resolves to the
//   Vim binding or to nothing, as any other `when` decides. Weight:
//   EditorContrib, so the editor's other defaults on the same keys (cursor
//   moves) lose while a Vim mode's `when` holds, and widgets (suggest, ...)
//   still win; CTRL keys and Tab at WorkbenchContrib + 50, for workbench-wide
//   defaults (Ctrl-R is Open Recent on macOS, Ctrl-O Open File elsewhere) and
//   Tab's inline suggestion / next edit accept; Esc at EditorCore + 50, below
//   every widget's Esc.
// * `.` and macros replay the commands the engine executed (with captured
//   characters and the text typed in insert mode), so remapping cannot break
//   them.
// * The editor's own keydown is read only where a keybinding cannot be:
//   the character after `devhubVim.awaitChar` (f t r " q @ m ' `, CTRL-R in
//   insert mode, or a binding of one's own), the text an IME commits, and a
//   printable key no keybinding took while a command is half built (it
//   cancels it, as in Vim; the dispatcher is asked first). Everything else
//   reaches the keybinding dispatcher untouched, so nothing is handled twice
//   and every Vim key is a keybinding.
// * The `:` `/` `?` prompt is a one-line editor of its own at the bottom of
//   the window (vimCmdline.ts), shown for the prompt an engine opened
//   (VimEngine.cmdlineState, once per prompt) and hidden when the engine
//   closes it, by `update` like everything else. Its keys are keybindings on
//   `devhubVim.cmdlineFocus` (common/vimCmdline.ts); it is not a Vim editor
//   (`vimDrives`).
// * `:` commands (../common/vimEx.ts): one registry of ExSpecs and one
//   parser. Vim's editing commands (:s :g :d :m :t :normal :sort ...) run in
//   the engine; the other built-ins run VS Code commands; `devhub.vim.exCommands`
//   adds the user's (uppercase names, unique prefixes) or overrides a
//   built-in, declaratively: the steps with `${args}` `${range}` `${bang}` ...
//   placeholders and what the command takes (nargs, range, bang, register,
//   complete, bar), validated by the JSON schema registered here. It is read
//   from the user's (local and remote) settings only (`exCommandsSetting`):
//   a workspace cannot define commands.
// * The last search is VS Code's find state. A search made in Vim (`/` `?`
//   `*` `#` `gd` `:s` `:g`) becomes the editor's FindReplaceState
//   (CommonFindController's: searchString, isRegex on, matchCase, wholeWord)
//   without opening the widget, so F3 / Cmd+G and the widget search for it;
//   a search made in the widget becomes Vim's last search, which `n` / `N`
//   follow (VimEditor.findStateChanged). The last search is global, as
//   Vim's; an editor's find state catches up with it when `n` runs there.
// * 'hlsearch' and 'incsearch' are editor decorations drawn here (the find
//   widget's colours). While an editor's find widget is open its FindModel
//   draws the matches of the same search, and 'hlsearch' steps aside there.
// * Modal "to the bone": outside insert mode an editor is switched to modal
//   text input in the editor core (editor/browser/controller/editContext/
//   modalTextInput.ts): typed text, IME composition and drop from any
//   caller never reach the model, so a key no keybinding takes types nothing.
//   A paste does (Cmd+V is a command, as cut and undo are).
//   An IME that is on still composes (its keys dispatch no keybinding); what
//   it commits goes to VimEngine.handleText: a command waiting for a
//   character takes it, as does the prompt, and anything else is dropped.
//   Replace mode is the editor's overtype input mode. The caret is on a
//   character outside insert mode, never past the end of a line, as a rule of
//   the editor's cursor (editor/common/cursor/modalCursor.ts) that this
//   contribution switches by the engine's mode: a click, a restored view
//   state, undo or any other caller cannot put it there, not even for a frame.
//   In a visual mode the block caret is drawn on the cursor's character (the
//   engine's visual head), not after the selection's last one where VS Code
//   would draw it; the selection is left as it is (ModalCursor.setVisual).
// * Mode, caret style, modal input and context keys are recomputed from the
//   engine's state after every command and every focus or model change, never
//   toggled, and a command that throws leaves the engine in plain normal mode.
// * From the first key: this contribution is BlockStartup, so it exists
//   before the first editor, and it attaches its engine to each editor in
//   that editor's constructor (onCodeEditorAdd fires synchronously at its
//   end), where the editor is made modal, in normal mode, with Vim's caret,
//   before it can have focus, a key or a frame. Editors that exist already
//   when Vim is turned on are attached then (listCodeEditors). There is no
//   other mechanism: an editor is either driven by an engine or an ordinary
//   editor, never modal with no engine to leave normal mode.
// * Undo is VS Code's: `u` / CTRL-R are the `undo` / `redo` commands
//   (devhubVim.repeat, for a count), so an undo step is the model's own (a
//   format on save is one). The engine closes the undo stack element where
//   a change begins and ends (beginChange / endChange), so each normal-mode
//   change is a step of its own; inside an insert the editor's own typing
//   stops apply (a word, a newline, ...), as when typing in any editor.
//   After any undo or redo outside insert mode the editor is in normal mode
//   with one collapsed caret (settle). Cmd+C / Cmd+X / Cmd+V are VS Code's
//   clipboard actions in every mode; a cut or paste over the visual
//   selection ends visual mode the same way.
// * Esc only ever cancels: pressed any number of times it lands in plain
//   normal mode and nowhere else.
// * Moving between parts is Vim's window prefix: `<C-w>` (devhubVim.nav.enter)
//   then one key (h j k l, w p t b, s v n c q o, = _ + - < >, H J K L, d ] }:
//   devhubVim.nav.*, or whatever else the key is bound to while
//   `devhubVim.mode == 'nav'`). It is one-shot (common/vimKeys.ts
//   VimNavPrefix). In a Vim editor's insert
//   mode Ctrl-W is Vim's delete-word-before-the-caret.
//
// User documentation: docs/vim.md in the DevHub repository.

import { addDisposableListener, getActiveElement, isEditableElement, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { IKeyboardEvent, StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingParser } from '../../../../base/common/keybindingParser.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ModalTextInput } from '../../../../editor/browser/controller/editContext/modalTextInput.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption, cursorStyleToString } from '../../../../editor/common/config/editorOptions.js';
import { ModalCursor } from '../../../../editor/common/cursor/modalCursor.js';
import { CursorChangeReason } from '../../../../editor/common/cursorEvents.js';
import { IPosition, Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { ScrollType } from '../../../../editor/common/editorCommon.js';
import { InputMode } from '../../../../editor/common/inputMode.js';
import { ILanguageConfigurationService } from '../../../../editor/common/languages/languageConfigurationRegistry.js';
import { FindMatch, IModelDeltaDecoration, InjectedTextCursorStops, OverviewRulerLane, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, ContextKeyExpression, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ResultKind } from '../../../../platform/keybinding/common/keybindingResolver.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { overviewRulerFindMatchForeground } from '../../../../platform/theme/common/colorRegistry.js';
import { themeColorFromId } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { DEFAULT_VIM_OPTIONS, IVimHost, VIM_ENGINE_COMMANDS, VimContext, VimEdit, VimEngine, VimIndentOptions, VimMatch, VimPos, VimRange, VimSearchQuery, VimSharedState, VimSubstitution } from '../common/vimEngine.js';
import { parseReplaceString } from '../../../../editor/contrib/find/browser/replacePattern.js';
import { CommonFindController } from '../../../../editor/contrib/find/browser/findController.js';
import { FindReplaceState, FindReplaceStateChangedEvent } from '../../../../editor/contrib/find/browser/findState.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import './media/devhubVim.css';
import { BUILTIN_EX_SPECS, builtinExNameForms } from '../common/vimEx.js';
import { DEFAULT_KEYBINDINGS, INSERT_ESCAPE_DISMISSES, VIM_WEIGHTS, jisKeys } from '../common/vimKeymap.js';
import { CMDLINE_KEYBINDINGS } from '../common/vimCmdline.js';
import { IVimCmdlineOrigin, VIM_CMDLINE_AUTOCOMPLETE_SETTING, VIM_CMDLINE_CLASS, VIM_CMDLINE_FOCUS, VimCmdline } from './vimCmdline.js';
import { VIM_EDIT_COMMANDS } from './vimEdit.js';
import { VIM_SHELL_COMMANDS } from './vimShell.js';
import { VIM_JS_COMMANDS } from './vimJs.js';
import { VimCursorStyle, VimNavFocus, VimNavPrefix, captureKey, typedChar, vimCursorStyle } from '../common/vimKeys.js';

/** The workbench commands an ex command runs that take the file it ran in (`from`). */
const FROM_COMMANDS = [...VIM_EDIT_COMMANDS, ...VIM_SHELL_COMMANDS, ...VIM_JS_COMMANDS];

const SETTING = 'devhub.vim.enabled';
const EX_SETTING = 'devhub.vim.exCommands';
const OPTIONS_SETTING = 'devhub.vim.options';
const INCCOMMAND_SETTING = 'devhub.vim.inccommand';

const exArgsDescription = localize('devhubVim.ex.args', "Its arguments (any JSON). Strings may use ${args}, ${argList}, ${bang}, ${range}, ${line1}, ${line2}, ${count} and ${register}: a string that is exactly one becomes the typed value.");
const exStepSchema: IJSONSchema = {
	type: 'object',
	required: ['command'],
	additionalProperties: false,
	properties: {
		command: { type: 'string', minLength: 1, description: localize('devhubVim.ex.command', "The command to run (any command id, as in keybindings.json).") },
		args: { description: exArgsDescription },
		ifBang: { type: 'boolean', description: localize('devhubVim.ex.ifBang', "Run this step only with `!` (true) or only without it (false).") },
	},
};

/** The JSON schema of one `devhub.vim.exCommands` entry (common/vimEx.ts ExCommandSpec, validateExCommandSpec). */
export const EX_COMMAND_SPEC_SCHEMA: IJSONSchema = {
	type: 'object',
	additionalProperties: false,
	oneOf: [{ required: ['command'] }, { required: ['commands'] }],
	properties: {
		command: { type: 'string', minLength: 1, description: localize('devhubVim.ex.spec.command', "The command to run (or give `commands`).") },
		args: { description: exArgsDescription },
		commands: {
			type: 'array', minItems: 1,
			items: { anyOf: [{ type: 'string', minLength: 1 }, exStepSchema] },
			description: localize('devhubVim.ex.spec.commands', "Several commands, run in order, each awaited: command ids or `{ command, args?, ifBang? }`."),
		},
		nargs: {
			enum: ['none', '0', '1', '?', '*', '+'],
			enumDescriptions: [
				localize('devhubVim.ex.nargs.none', "No argument (E488 when one is given). The default unless `args` uses ${args} or ${argList}."),
				localize('devhubVim.ex.nargs.0', "Same as none (Vim's -nargs=0)."),
				localize('devhubVim.ex.nargs.1', "Exactly one argument, blanks included (E471 without one)."),
				localize('devhubVim.ex.nargs.optional', "No argument or one, blanks included."),
				localize('devhubVim.ex.nargs.any', "Any number, split on blanks. The default when `args` uses ${args} or ${argList}."),
				localize('devhubVim.ex.nargs.some', "One or more, split on blanks (E471 without one)."),
			],
			description: localize('devhubVim.ex.spec.nargs', "How many arguments it takes (Vim's -nargs)."),
		},
		range: {
			enum: ['none', 'line', 'range', 'count'],
			enumDescriptions: [
				localize('devhubVim.ex.range.none', "No range (E481 when one is given). The default."),
				localize('devhubVim.ex.range.line', "One line (`:5Name`, `:'aName`): ${line1} = ${line2}."),
				localize('devhubVim.ex.range.range', "A range of lines (`:'<,'>Name`, `:%Name`), selected while the commands run: ${range}, ${line1}, ${line2}."),
				localize('devhubVim.ex.range.count', "A count, before the name or as the first argument (`:3Name`, `:Name 3`): ${count}."),
			],
			description: localize('devhubVim.ex.spec.range', "What may come before the name (Vim's -range / -count)."),
		},
		defaultRange: {
			anyOf: [{ enum: ['.', '%'] }, { type: 'integer', minimum: 0 }],
			description: localize('devhubVim.ex.spec.defaultRange', "Without a typed range: `.` the cursor line (the default), `%` the whole file (range \"range\"), or the count (range \"count\", default 0)."),
		},
		bang: { type: 'boolean', description: localize('devhubVim.ex.spec.bang', "It takes `!` (${bang}; E477 otherwise).") },
		register: { type: 'boolean', description: localize('devhubVim.ex.spec.register', "The first argument may be a register name (${register}), as `:d x`.") },
		complete: {
			anyOf: [
				{ enum: ['file', 'command', 'option', 'buffer'], enumDescriptions: [localize('devhubVim.ex.complete.file', "File names."), localize('devhubVim.ex.complete.command', "Ex command names."), localize('devhubVim.ex.complete.option', "`:set` options."), localize('devhubVim.ex.complete.buffer', "Open editors.")] },
				{ type: 'string', pattern: '^command:\\S+$', patternErrorMessage: localize('devhubVim.ex.complete.custom', "`command:<id>`: a command that returns the candidates (strings or { label, detail? }) for { typed, line, caret }.") },
			],
			description: localize('devhubVim.ex.spec.complete', "What Tab completes in the argument."),
		},
		bar: { type: 'boolean', description: localize('devhubVim.ex.spec.bar', "`|` ends the command and starts the next one (the default); false: `|` is part of the argument.") },
		description: { type: 'string', description: localize('devhubVim.ex.spec.description', "Shown in the `:` prompt's completion.") },
	},
	defaultSnippets: [
		{ label: 'command', body: { command: '$1' } },
		{ label: 'command with the argument', body: { command: '$1', args: { '$2': '\\${args}' }, nargs: '*' } },
		{ label: 'commands on a range', body: { commands: ['$1'], range: 'range' } },
	],
};

function escapeForPattern(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'devhubVim',
	order: 100,
	title: localize('devhubVim', "Vim"),
	type: 'object',
	properties: {
		[SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('devhubVim.enabled', "Modal (Vim) editing in every editor and input, built into DevHub, with Neovim's defaults. Every Vim key is an ordinary keybinding (`devhubVim.*` commands): rebind or remove them in keybindings.json or the Keyboard Shortcuts editor. Esc always ends in normal mode. Ctrl-W then h/j/k/l moves to the part on the left/below/above/right."),
		},
		[EX_SETTING]: {
			type: 'object',
			default: {},
			// a workspace cannot define commands (vimEx.ts): local and remote user settings only, and they are read so (exCommandsSetting)
			scope: ConfigurationScope.MACHINE,
			markdownDescription: localize('devhubVim.exCommands', "Your own `:` commands (user settings only; a workspace's are ignored). A name starts with an uppercase letter (as Vim's `:command`; a unique prefix runs it), or is a built-in name to override it ({0}; an override keeps the attributes it does not set). The value is a command id, or `{ \"command\": ..., \"args\": ... }` / `{ \"commands\": [...] }` (run in order, each awaited; a step with `\"ifBang\": true` runs only for `:Name!`) with what it takes: `nargs`, `range`, `defaultRange`, `bang`, `register`, `complete`, `bar`. In `args`, strings may use `${args}`, `${argList}`, `${bang}`, `${range}` (`{ start, end }` 1-based, null without a typed range), `${line1}`, `${line2}`, `${count}`, `${register}`.", Object.keys(BUILTIN_EX_SPECS).filter(n => /^[a-z]/.test(n)).map(n => `\`${n}\``).join(', ')),
			propertyNames: {
				pattern: `^(?:[A-Z][A-Za-z0-9]*|${builtinExNameForms().map(escapeForPattern).join('|')})$`,
				patternErrorMessage: localize('devhubVim.exCommands.name', "E183: User defined commands must start with an uppercase letter (or be a built-in name, to override it)."),
			},
			additionalProperties: {
				anyOf: [
					{ type: 'string', minLength: 1, description: localize('devhubVim.ex.commandId', "A command id, run without arguments.") },
					EX_COMMAND_SPEC_SCHEMA,
				],
			},
		},
		[OPTIONS_SETTING]: {
			type: 'object',
			default: {},
			markdownDescription: localize('devhubVim.options', "Vim options at startup, as with `:set` (Neovim's defaults otherwise). For example `{ \"ignorecase\": true, \"smartcase\": true }`."),
			properties: Object.fromEntries(Object.entries(DEFAULT_VIM_OPTIONS).map(([k, v]) => [k, { type: typeof v as 'boolean' | 'number' | 'string', default: v }])),
		},
		[INCCOMMAND_SETTING]: {
			type: 'string',
			enum: ['nosplit', ''],
			default: 'nosplit',
			markdownDescription: localize('devhubVim.inccommand', "Neovim's 'inccommand': while `:s/pattern/replacement/` is typed, show in the editor what it would replace (on the lines on screen): each match struck through with its replacement after it, and just the matches while only the pattern is typed. Esc takes it all away, Enter replaces. `\"\"`: no preview."),
		},
		[VIM_CMDLINE_AUTOCOMPLETE_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('devhubVim.cmdline.autoComplete', "In the `:` prompt, show the completion menu (ex commands, `:set` options, `:b` buffers, `:e` files) as you type, as IntelliSense does. Nothing in it is selected until you pick a match (Tab, Down, CTRL-N), so Enter runs the line exactly as typed. Off: the menu shows on Tab only."),
		},
	},
});

const VIM_MODE = new RawContextKey<string>('devhubVim.mode', '', localize('devhubVim.mode', "The Vim mode of the focused editor or input: normal, insert, replace, visual, visualLine, visualBlock, operatorPending, cmdline, nav (Ctrl-W waits for its key), or empty."));
const VIM_ACTIVE = new RawContextKey<boolean>('devhubVim.active', false, localize('devhubVim.active', "Whether the focused text editor is driven by DevHub Vim."));
/** The PoC's name for `devhubVim.active`, kept for existing `when` clauses. */
const VIM_ATTACHED = new RawContextKey<boolean>('devhubVim.attached', false, localize('devhubVim.attached', "Same as devhubVim.active."));
const VIM_ACCEPTS_MOTION = new RawContextKey<boolean>('devhubVim.acceptsMotion', false, localize('devhubVim.acceptsMotion', "A Vim motion, operator, count or action may come next (normal, visual or operator-pending mode, and no key is being captured)."));
const VIM_HAS_COUNT = new RawContextKey<boolean>('devhubVim.hasCount', false, localize('devhubVim.hasCount', "A Vim count is being typed (so `0` is a digit)."));
const VIM_PENDING = new RawContextKey<boolean>('devhubVim.pending', false, localize('devhubVim.pending', "A Vim command is half built: a count, register, operator, text object prefix or character argument."));
const VIM_PENDING_OPERATOR = new RawContextKey<string>('devhubVim.pendingOperator', '', localize('devhubVim.pendingOperator', "The pending Vim operator: delete, change, yank, indent, outdent, reindent, lowercase, uppercase, toggleCase, rot13, format, formatKeep, comment, fold, or empty."));
const VIM_TEXT_OBJECT_PENDING = new RawContextKey<string>('devhubVim.textObjectPending', '', localize('devhubVim.textObjectPending', "inner or around after Vim's `i` / `a`: the next key names the text object."));
const VIM_AWAITING_CHAR = new RawContextKey<boolean>('devhubVim.awaitingChar', false, localize('devhubVim.awaitingChar', "The next key is a Vim character argument (f t r \" q @ m ...)."));
const VIM_RECORDING = new RawContextKey<boolean>('devhubVim.recording', false, localize('devhubVim.recording', "A Vim macro is being recorded."));
const VIM_VISUAL = new RawContextKey<boolean>('devhubVim.visual', false, localize('devhubVim.visual', "The focused Vim editor is in a visual mode (characterwise, linewise or blockwise)."));
const VIM_INSERT = new RawContextKey<boolean>('devhubVim.insert', false, localize('devhubVim.insert', "The focused Vim editor is in insert or replace mode."));
const ENABLED = ContextKeyExpr.equals(`config.${SETTING}`, true);

/**
 * The editors Vim drives: all of them but the settings / extensions search
 * boxes, which behave as plain inputs, and the Vim prompt line itself
 * (vimCmdline.ts: insert-only, Esc cancels it).
 */
export function vimDrives(container: HTMLElement): boolean {
	return !container.closest(`.suggest-input-container, .${VIM_CMDLINE_CLASS}`);
}

type CursorStyle = ReturnType<typeof cursorStyleToString>;
const CURSOR_STYLES: readonly CursorStyle[] = ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'];

const HLSEARCH_DECORATION = ModelDecorationOptions.register({
	description: 'devhub-vim-hlsearch',
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	className: 'findMatch',
	showIfCollapsed: true,
	overviewRuler: { color: themeColorFromId(overviewRulerFindMatchForeground), position: OverviewRulerLane.Center },
});
const INCSEARCH_DECORATION = ModelDecorationOptions.register({
	description: 'devhub-vim-incsearch',
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	className: 'currentFindMatch',
	showIfCollapsed: true,
	zIndex: 13,
});
/** 'inccommand': a match `:s` would replace (struck through), and what replaces it after it. */
const INCCOMMAND_OLD_CLASS = 'devhub-vim-inccommand-old';
const INCCOMMAND_NEW_CLASS = 'devhub-vim-inccommand-new';
function inccommandDecoration(text: string): ModelDecorationOptions {
	return ModelDecorationOptions.createDynamic({
		description: 'devhub-vim-inccommand',
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		inlineClassName: INCCOMMAND_OLD_CLASS,
		showIfCollapsed: true,
		// a line break in the replacement is shown as one character
		after: { content: text.replace(/\n/g, '\u21b5'), inlineClassName: INCCOMMAND_NEW_CLASS, cursorStops: InjectedTextCursorStops.None },
	});
}
/** Matches drawn for 'hlsearch' at most (around the visible lines first). */
const HLSEARCH_LIMIT = 5000;

/**
 * The source a cursor move is put with. A Vim jump is VS Code's JUMP (what Go
 * to Definition and Go to Line use): VS Code's history (Go Back / Go Forward,
 * which CTRL-O / CTRL-I are) adds an entry for it even a few lines away, and
 * its navigation locations get both ends. Every other move is the user's own,
 * which the history only records once it is 10 lines or more away.
 */
function selectionSource(jump: boolean | undefined): string {
	return jump ? TextEditorSelectionSource.JUMP : 'devhubVim';
}

function toRange(r: VimRange): Range {
	return new Range(r.start.line + 1, r.start.col + 1, r.end.line + 1, r.end.col + 1);
}

function toVimMatch(m: FindMatch): VimMatch {
	const r = m.range;
	return {
		range: { start: { line: r.startLineNumber - 1, col: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, col: r.endColumn - 1 } },
		groups: m.matches ?? [],
	};
}

/**
 * `devhub.vim.exCommands` as the user's settings have it, never a
 * workspace's: the local user settings, with the remote user settings' entries
 * on top in a remote window (inspect: userLocalValue / userRemoteValue,
 * userValue when neither is there). The setting is MACHINE-scoped, so the
 * configuration service already leaves a workspace's value out; reading it
 * this way keeps it so whatever the scope (a workspace could otherwise run
 * any command, :js included, from a `:` line the user types).
 */
export function exCommandsSetting(configurationService: Pick<IConfigurationService, 'inspect'>): Record<string, unknown> {
	const v = configurationService.inspect<Record<string, unknown>>(EX_SETTING);
	const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
	if (!isRecord(v.userLocalValue) && !isRecord(v.userRemoteValue)) {
		return isRecord(v.userValue) ? { ...v.userValue } : {};
	}
	return { ...(isRecord(v.userLocalValue) ? v.userLocalValue : {}), ...(isRecord(v.userRemoteValue) ? v.userRemoteValue : {}) };
}

/** `devhub.vim.inccommand`: 'nosplit' unless turned off. */
function inccommandOf(value: unknown): string {
	return value === '' ? '' : 'nosplit';
}

/** One CodeEditorWidget with its engine; it is the engine's IVimHost. */
class VimEditor extends Disposable implements IVimHost {

	readonly engine: VimEngine;
	private readonly modelListener = this._register(new DisposableStore());
	private undoQueue: Promise<void> = Promise.resolve();
	/** settle() is queued (after an undo / redo, or a paste or cut over the visual selection). */
	private settleQueued = false;
	/** Inside applyEdits: the engine's own edits. */
	private applying = 0;
	/** The selections a visual mode put, as ranges (what Cmd+X / Cmd+V replace). */
	private visualRanges: Range[] = [];
	private appliedStyle: CursorStyle | undefined;
	private applyingStyle = false;
	private insertStyle: VimCursorStyle;
	private readonly hlDecorations;
	private readonly incDecorations;
	private readonly hlScheduler = this._register(new RunOnceScheduler(() => this.drawHighlight(), 50));
	private readonly previewDecorations;
	/** 'inccommand': what the `:s` being typed would do, computed and drawn shortly after the last key. */
	private previewCompute: (() => readonly VimSubstitution[] | undefined) | undefined;
	private readonly previewScheduler = this._register(new RunOnceScheduler(() => this.drawPreview(), 30));
	private incOrigin: { scrollTop: number; scrollLeft: number } | undefined;
	/** Inside scrollToLine's cursor move: the cursor is not revealed, the scroll says where the window goes. */
	private revealSuppressed = 0;
	/** Inside the engine's handling of a selection the mouse made. */
	private mouseSelecting = 0;
	/** The primary selection last put for a visual mode, with the character its cursor is on. */
	private visualPrimary: { selection: Selection; cursor: Position } | undefined;
	/** VS Code's find controller of this editor (its FindReplaceState is the find widget's, F3's and Cmd+G's), once there is one. */
	private findCtl: CommonFindController | undefined;
	/** Inside syncFindState: the find state changes because Vim searched, not the widget. */
	private writingFind = 0;
	/** Between onWillChangeModel and onDidChangeModel: the find controller puts its stored toggles back, which nobody searched for. */
	private modelChanging = false;

	constructor(
		readonly editor: ICodeEditor,
		private readonly owner: DevhubVim,
		shared: VimSharedState,
	) {
		super();
		this.engine = new VimEngine(this, shared);
		// Outside insert and replace mode the caret is on a character, at every
		// cursor move, whoever makes it (the editor core applies it, modalCursor.ts).
		this._register(ModalCursor.set(editor.getId(), () => !this.typing()));
		// In a visual mode the caret is drawn on the cursor's character, not after
		// the selection's last one (modalCursor.ts); the selection stays as it is.
		this._register(ModalCursor.setVisual(editor.getId(), () => this.engine.visualCursor() ? { primary: this.visualPrimary, block: this.engine.mode === 'visualBlock' } : undefined));
		this.insertStyle = this.readInsertCursorStyle();
		this.hlDecorations = editor.createDecorationsCollection();
		this.incDecorations = editor.createDecorationsCollection();
		this.previewDecorations = editor.createDecorationsCollection();
		this._register({ dispose: () => { this.hlDecorations.clear(); this.incDecorations.clear(); this.previewDecorations.clear(); } });

		this._register(editor.onKeyDown(e => this.onKeyDown(e)));
		this._register(editor.onDidFocusEditorText(() => owner.update()));
		this._register(editor.onDidBlurEditorText(() => owner.update()));
		this.findController();
		this._register(editor.onWillChangeModel(() => this.modelChanging = true));
		this._register(editor.onDidChangeModel(() => {
			this.modelChanging = false;
			this.engine.reset();
			this.modelListener.clear();
			this.insertStyle = this.readInsertCursorStyle();
			this.incDecorations.clear();
			this.previewSubstitute(undefined);
			this.scheduleHighlight();
			owner.update();
		}));
		this._register(editor.onDidChangeModelContent(e => {
			// marks and an insert in progress follow every edit
			try {
				this.engine.contentChanged(e.changes.map(c => ({
					start: { line: c.range.startLineNumber - 1, col: c.range.startColumn - 1 },
					end: { line: c.range.endLineNumber - 1, col: c.range.endColumn - 1 },
					text: c.text.replace(/\r\n/g, '\n'),
				})));
			} catch (err) {
				onUnexpectedError(err);
			}
			if (e.isUndoing || e.isRedoing) {
				this.queueSettle();
			} else if (!this.applying && this.engine.mode.startsWith('visual') && e.changes.length > 0 && e.changes.every(c => this.visualRanges.some(r => r.equalsRange(c.range)))) {
				// Cmd+X, Cmd+V or any other command that wrote over the visual
				// selection: back in normal mode, as Vim's d / c / p leave visual mode
				this.queueSettle();
			}
			this.scheduleHighlight();
		}));
		this._register(editor.onWillPaste(() => {
			// Cmd+V outside insert mode (VS Code's paste, modalTextInput.ts): a half-built command is dropped first
			if (!this.typing() && this.engine.pending) {
				this.engine.cancelPending();
			}
		}));
		this._register(editor.onDidScrollChange(e => {
			if (e.scrollTopChanged && owner.searchHighlight) {
				this.scheduleHighlight();
			}
		}));
		this._register(editor.onDidChangeCursorSelection(e => {
			if (e.source !== 'mouse') {
				return;
			}
			const s = e.selection;
			this.mouseSelecting++;
			try {
				this.engine.selectionChanged(
					{ line: s.selectionStartLineNumber - 1, col: s.selectionStartColumn - 1 },
					{ line: s.positionLineNumber - 1, col: s.positionColumn - 1 });
			} finally {
				this.mouseSelecting--;
			}
			owner.update();
		}));
		this._register(editor.onDidChangeConfiguration(e => {
			if (!this.applyingStyle && e.hasChanged(EditorOption.cursorStyle)) {
				// Someone else set it (the workbench re-applying settings, a parent
				// editor's options copied into a peek or inline diff editor, an
				// extension): Vim's style wins again. What the user wants in insert
				// mode is read from the settings (readInsertCursorStyle), never from the
				// editor, whose cursorStyle is Vim's own and leaks into the editors
				// that copy it.
				this.appliedStyle = undefined;
				this.syncCursorStyle();
			}
		}));
		this.scheduleHighlight();
	}

	override dispose(): void {
		ModalTextInput.set(this.editor.getId(), false);
		this.setCursorStyle(this.insertStyle);
		super.dispose();
	}

	/** The user's `editor.cursorStyle` for this editor's file and language: the insert-mode caret. */
	private readInsertCursorStyle(): VimCursorStyle {
		const model = this.editor.getModel();
		const value = this.owner.configurationService.getValue<string>('editor.cursorStyle', model ? { resource: model.uri, overrideIdentifier: model.getLanguageId() } : {});
		return CURSOR_STYLES.includes(value as CursorStyle) ? value as CursorStyle : 'line';
	}

	context(): VimContext {
		return this.engine.context();
	}

	private typing(): boolean {
		return this.engine.mode === 'insert' || this.engine.mode === 'replace';
	}

	/** Caret style, modal text input and the caret's column, all derived from the current state. */
	syncCursorStyle(): void {
		const nav = this.owner.nav.active && this.editor.hasTextFocus();
		const typing = this.typing();
		ModalTextInput.set(this.editor.getId(), !typing);
		if (!typing) {
			this.caretOnCharacter();
		}
		this.setCursorStyle(vimCursorStyle(this.engine.mode, nav, this.insertStyle));
	}

	/**
	 * Every cursor move outside insert mode keeps the caret on a character
	 * (ModalCursor). A caret that was past the end of its line before that held
	 * (an editor Vim was just turned on for, or one whose engine went back to
	 * normal mode without moving it: a model change, a command that threw) is
	 * put through the same rule once, in the same task, before a frame.
	 */
	private caretOnCharacter(): void {
		const model = this.editor.getModel();
		const selections = this.editor.getSelections();
		if (model && selections?.some(s => s.isEmpty() && s.positionColumn > 1 && s.positionColumn === model.getLineMaxColumn(s.positionLineNumber))) {
			this.editor.setSelections(selections, 'devhubVim');
		}
	}

	/** Re-read the insert caret from the settings and re-apply. */
	refreshCursorStyle(): void {
		this.insertStyle = this.readInsertCursorStyle();
		this.appliedStyle = undefined;
		this.syncCursorStyle();
	}

	private setCursorStyle(style: CursorStyle): void {
		if (this.appliedStyle === style) {
			return;
		}
		this.appliedStyle = style;
		this.applyingStyle = true;
		try {
			this.editor.updateOptions({ cursorStyle: style });
		} finally {
			this.applyingStyle = false;
		}
	}

	/**
	 * Only what a keybinding cannot express (see the design comment). Runs
	 * before the keybinding dispatcher; a key taken here is stopped, so the
	 * dispatcher never sees it, and a key left alone is never acted on here.
	 */
	private onKeyDown(e: IKeyboardEvent): void {
		if (this.owner.nav.active || !this.editor.hasModel()) {
			return;
		}
		const typing = this.engine.mode === 'insert' || this.engine.mode === 'replace';
		const be = e.browserEvent;
		if (this.engine.awaitingChar) {
			const key = captureKey(be);
			if (key === undefined) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.guard(() => this.engine.awaitKey(key));
			return;
		}
		if (typing) {
			return;
		}
		// Vim: a printable key that means nothing here cancels the half-built
		// command (`d` then a key with no binding). "Any key no binding takes"
		// cannot be a keybinding; this asks the dispatcher first and acts only
		// when it has nothing, so every binding (the defaults, the user's, an
		// extension's) still wins. It types nothing either way: the editor is modal.
		const keybindings = this.owner.keybindingService;
		if (!this.engine.pending || typedChar(be) === undefined || keybindings.inChordMode) {
			return;
		}
		if (keybindings.softDispatch(e, e.target).kind === ResultKind.NoMatchingKb) {
			e.preventDefault();
			e.stopPropagation();
			this.guard(() => this.engine.cancelPending());
		}
	}

	/** Leaving insert mode: the completion menu, ghost text, signature help, ... go with it (one Esc, as in Vim). */
	private dismissInsertWidgets(): void {
		const keys = this.editor.invokeWithinContext(a => a.get(IContextKeyService));
		for (const d of INSERT_ESCAPE_DISMISSES) {
			try {
				if (keys.contextMatchesRules(this.owner.whenExpr(d.when))) {
					this.editor.trigger('devhubVim', d.command, undefined);
				}
			} catch (err) {
				onUnexpectedError(err);
			}
		}
	}

	/** Text an IME committed while this editor was modal (ModalTextInput.onDidCommitText). */
	commitText(text: string): void {
		this.guard(() => this.engine.handleText(text));
	}

	/** An engine command, or any command a Vim binding names (awaitChar targets). */
	execute(command: string, args: unknown): void {
		if (command === 'devhubVim.escape' && (this.engine.mode === 'insert' || this.engine.mode === 'replace')) {
			this.dismissInsertWidgets();
		}
		this.guard(() => {
			if (!this.engine.execute(command, args)) {
				void this.executeCommand(command, args);
			}
		});
	}

	/** What the prompt line needs of this editor: where the focus goes back, what runs the line. */
	cmdlineOrigin(): IVimCmdlineOrigin {
		const t = this.engine.cmdlineTarget();
		return {
			editor: this.editor,
			target: {
				history: kind => t.history(kind),
				changed: text => this.guard(() => t.changed(text)),
				submit: text => this.guard(() => t.submit(text)),
				cancel: () => this.guard(() => t.cancel()),
				registerText: name => t.registerText(name),
				prepareRegisters: () => t.prepareRegisters(),
			},
			sources: this.engine.cmdlineSources(),
		};
	}

	/** Whatever happens, the engine, caret and context keys agree afterwards. */
	private guard(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			this.engine.recover(err);
			onUnexpectedError(err);
		} finally {
			this.owner.update();
		}
	}

	// ---- 'hlsearch' / 'incsearch' -------------------------------------------

	scheduleHighlight(): void {
		this.hlScheduler.schedule();
	}

	private drawHighlight(): void {
		const model = this.editor.getModel();
		const r = this.owner.searchHighlight;
		// the open find widget's FindModel highlights the same matches (findDecorations.ts): not twice
		if (!model || !r || this.findController()?.getState().isRevealed) {
			this.hlDecorations.clear();
			return;
		}
		// the visible lines with some margin; the whole file when it is small
		const visible = this.editor.getVisibleRanges();
		const lines = model.getLineCount();
		const from = lines <= 20000 || !visible.length ? 1 : Math.max(1, visible[0].startLineNumber - 500);
		const to = lines <= 20000 || !visible.length ? lines : Math.min(lines, visible[visible.length - 1].endLineNumber + 500);
		let decorations: IModelDeltaDecoration[] = [];
		try {
			const scope = new Range(from, 1, to, model.getLineMaxColumn(to));
			decorations = model.findMatches(r.pattern, scope, true, r.matchCase, this.wordSeparators(r), false, HLSEARCH_LIMIT)
				.map(m => ({ range: m.range, options: HLSEARCH_DECORATION }));
		} catch {
			// the engine checked the pattern; nothing else can be wrong but the model going away
		}
		this.hlDecorations.set(decorations);
	}

	// ---- the find widget's state ----------------------------------------------

	/** This editor's CommonFindController (none in an editor made without contributions), listened to once it is there. */
	private findController(): CommonFindController | undefined {
		if (!this.findCtl) {
			const c = CommonFindController.get(this.editor) ?? undefined;
			if (c) {
				this.findCtl = c;
				this._register(c.getState().onFindReplaceStateChange(e => this.findStateChanged(c.getState(), e)));
			}
		}
		return this.findCtl;
	}

	/**
	 * The find state changed. A search made in the widget (typed, seeded by
	 * Cmd+F / Cmd+E, read from macOS's find clipboard, or a toggle) is Vim's
	 * last search; one Vim made (syncFindState) or the toggles the controller
	 * restores with a new model are not. A toggle (Alt+C ...) while the widget
	 * is closed counts only when this editor's find state is the last search:
	 * on an older one nobody sees, it searches for nothing new.
	 */
	private findStateChanged(state: FindReplaceState, e: FindReplaceStateChangedEvent): void {
		if (e.isRevealed) {
			// 'hlsearch' steps aside while the widget draws, and is back when it closes
			this.scheduleHighlight();
		}
		if (this.writingFind || this.modelChanging || !(e.searchString || e.isRegex || e.matchCase || e.wholeWord)) {
			return;
		}
		if (!e.searchString && !state.isRevealed && !this.findStateIsLastSearch(state)) {
			return;
		}
		try {
			this.engine.adoptFindSearch(state.searchString ? {
				pattern: state.isRegex ? state.searchString : escapeRegExpCharacters(state.searchString),
				matchCase: state.matchCase,
				wholeWord: state.wholeWord,
			} : undefined);
		} catch (err) {
			onUnexpectedError(err);
		}
		this.owner.update();
	}

	private findStateIsLastSearch(state: FindReplaceState): boolean {
		const q = this.engine.lastSearchQuery();
		return !!q && (q.pattern === state.searchString || q.pattern === escapeRegExpCharacters(state.searchString));
	}

	syncFindState(query: VimSearchQuery, isNew: boolean): void {
		const c = this.findController();
		if (!c) {
			return;
		}
		const state = c.getState();
		// the widget's own search for the same thing (its text with the regex toggle off) is left as the user typed it
		const hadString = (state.isRegex ? state.searchString : escapeRegExpCharacters(state.searchString)) === query.pattern;
		if (!hadString || state.matchCase !== query.matchCase || state.wholeWord !== query.wholeWord) {
			this.writingFind++;
			try {
				// moveCursor false: an open widget's FindModel searches again where the cursor is, which Vim already moved
				state.change({ searchString: query.pattern, isRegex: true, matchCase: query.matchCase, wholeWord: query.wholeWord }, false, isNew);
			} finally {
				this.writingFind--;
			}
		}
		if (isNew && hadString) {
			// a new search for the same pattern still is the find clipboard's (the controller writes it when the string changes)
			c.setGlobalBufferTerm(state.searchString);
		}
	}

	/** :nohlsearch: the find widget, whose matches are highlights too, closes (without taking the focus). */
	closeFindWidget(): void {
		const state = this.findCtl?.getState();
		if (state?.isRevealed) {
			state.change({ isRevealed: false, searchScope: null }, false);
		}
	}

	/** VS Code's Match Whole Word: the editor's word separators (null: any match). */
	private wordSeparators(q: VimSearchQuery): string | null {
		return q.wholeWord ? this.editor.getOption(EditorOption.wordSeparators) : null;
	}

	previewSubstitute(compute: (() => readonly VimSubstitution[] | undefined) | undefined): void {
		this.previewCompute = compute;
		if (compute) {
			this.previewScheduler.schedule();
		} else {
			this.previewScheduler.cancel();
			this.previewDecorations.clear();
		}
	}

	private drawPreview(): void {
		let subs: readonly VimSubstitution[] | undefined;
		try {
			subs = this.previewCompute?.();
		} catch {
			// a line typed half-way: no preview, no error
			subs = undefined;
		}
		this.previewDecorations.set((subs ?? []).map(x => ({
			range: toRange(x.range),
			options: x.text === undefined ? HLSEARCH_DECORATION : inccommandDecoration(x.text),
		})));
	}

	// ---- IVimHost -----------------------------------------------------------

	private get model() {
		return this.editor.getModel()!;
	}

	lineCount(): number {
		return this.model.getLineCount();
	}

	lineText(line: number): string {
		return this.model.getLineContent(line + 1);
	}

	getCursor(): VimPos {
		const p = this.editor.getPosition();
		return p ? { line: p.lineNumber - 1, col: p.column - 1 } : { line: 0, col: 0 };
	}

	setCursor(p: VimPos, jump?: boolean): void {
		const position = { lineNumber: p.line + 1, column: p.col + 1 };
		this.editor.setPosition(position, selectionSource(jump));
		this.reveal(position, jump);
	}

	/**
	 * How this editor scrolls: animated when the user's `editor.smoothScrolling`
	 * is on, as VS Code's own scroll and reveal commands do (they pass
	 * ScrollType.Smooth, which the editor's scrollable animates only then).
	 */
	scrollType(): ScrollType {
		return this.editor.getOption(EditorOption.smoothScrolling) ? ScrollType.Smooth : ScrollType.Immediate;
	}

	/**
	 * Bring the caret into view (against where the window is going, so an
	 * animation in flight is not fought). A jump is revealed as VS Code's find
	 * widget reveals a match, in the center if it is outside the viewport: the
	 * rule the 'incsearch' preview uses, so Enter after `/foo` lands where the
	 * preview showed without moving the view again.
	 */
	private reveal(position: IPosition, jump?: boolean): void {
		if (this.revealSuppressed) {
			return;
		}
		if (jump) {
			this.editor.revealRangeInCenterIfOutsideViewport(Range.fromPositions(position), this.scrollType());
		} else {
			this.editor.revealPosition(position, this.scrollType());
		}
	}

	getSelection(): { anchor: VimPos; active: VimPos } {
		const s = this.editor.getSelection();
		if (!s) {
			const c = this.getCursor();
			return { anchor: c, active: c };
		}
		return {
			anchor: { line: s.selectionStartLineNumber - 1, col: s.selectionStartColumn - 1 },
			active: { line: s.positionLineNumber - 1, col: s.positionColumn - 1 },
		};
	}

	setSelection(start: VimPos, end: VimPos, cursorAtStart: boolean, jump?: boolean): void {
		const sel = cursorAtStart
			? new Selection(end.line + 1, end.col + 1, start.line + 1, start.col + 1)
			: new Selection(start.line + 1, start.col + 1, end.line + 1, end.col + 1);
		// The visual mode the mouse just made covers the mouse's selection: the
		// editor's cursor state stays as it is, only the caret is drawn anew.
		// Putting the selection would make a new cursor state, and the mouse's
		// drag goes on from that state's start (a word or line drag from its
		// whole first word or line, which a put selection forgets) and keeps
		// its direction, which a one-character selection does not say.
		const vm = this.mouseSelecting ? this.editor._getViewModel() : undefined;
		const states = vm?.getCursorStates();
		const current = this.editor.getSelection();
		const keep = vm && states?.length === 1 && current?.equalsRange(sel) ? states : undefined;
		const put = keep ? current! : sel;
		const caret = this.noteVisual(put);
		this.visualRanges = this.visualPrimary ? [put] : [];
		ModalCursor.redraw(this.editor.getId(), () => keep
			? vm!.setCursorStates(selectionSource(jump), CursorChangeReason.NotSet, keep)
			: this.editor.setSelection(sel, selectionSource(jump)));
		this.reveal(caret, jump);
	}

	/**
	 * Before a selection is put: in a visual mode, the character its caret is
	 * drawn on (the cursor's, which the selection does not say: `V` covers whole
	 * lines, a forward selection ends after its last character). That is the
	 * position revealed, too. The selection is then put with ModalCursor.redraw,
	 * so the caret is drawn anew though the selection may be the same.
	 */
	private noteVisual(primary: Selection): IPosition {
		const head = this.engine.visualCursor();
		this.visualPrimary = head ? { selection: primary, cursor: new Position(head.line + 1, head.col + 1) } : undefined;
		return this.visualPrimary?.cursor ?? primary.getPosition();
	}

	setSelections(ranges: readonly VimRange[], primary: number, cursorAtStart: boolean, jump?: boolean): void {
		const toSel = (r: VimRange) => cursorAtStart
			? new Selection(r.end.line + 1, r.end.col + 1, r.start.line + 1, r.start.col + 1)
			: new Selection(r.start.line + 1, r.start.col + 1, r.end.line + 1, r.end.col + 1);
		// VS Code's primary selection is the first
		const sels = [toSel(ranges[primary]), ...ranges.filter((_, i) => i !== primary).map(toSel)];
		const caret = this.noteVisual(sels[0]);
		this.visualRanges = this.visualPrimary ? sels : [];
		ModalCursor.redraw(this.editor.getId(), () => this.editor.setSelections(sels, selectionSource(jump)));
		this.reveal(caret, jump);
	}

	applyEdits(edits: readonly VimEdit[]): void {
		this.applying++;
		try {
			this.editor.executeEdits('devhubVim', edits.map(e => ({
				range: new Range(e.start.line + 1, e.start.col + 1, e.end.line + 1, e.end.col + 1),
				text: e.text,
			})));
		} finally {
			this.applying--;
		}
	}

	// Undo is VS Code's: `u` and CTRL-R are the `undo` / `redo` commands (the
	// model's own undo stack), so an undo step is whatever VS Code made one, a
	// format on save, a refactoring or a code action included. The engine
	// closes the stack element where a change begins and ends, so each
	// normal-mode change is one step; typing in an insert keeps the editor's
	// own undo stops.

	beginChange(): void {
		this.editor.pushUndoStop();
	}

	endChange(): void {
		this.editor.pushUndoStop();
	}

	// `:undo` / `:redo` (and `devhubVim.action undo` / `redo`): what the `undo`
	// and `redo` commands do in a focused editor, one after another so a held
	// key cannot interleave two.

	undo(): void {
		const model = this.model;
		this.enqueue(() => model.canUndo() ? model.undo() : undefined);
	}

	redo(): void {
		const model = this.model;
		this.enqueue(() => model.canRedo() ? model.redo() : undefined);
	}

	private enqueue(step: () => void | Promise<void>): void {
		const model = this.model;
		this.undoQueue = this.undoQueue.then(async () => {
			if (!model.isDisposed() && !this.editor.getOption(EditorOption.readOnly)) {
				await step();
			}
		}).catch(onUnexpectedError);
	}

	private queueSettle(): void {
		if (!this.settleQueued) {
			// the cursor is put after the edit, in this same task
			this.settleQueued = true;
			queueMicrotask(() => this.settle());
		}
	}

	/**
	 * After an edit Vim did not make that leaves it in no mode of its own: an
	 * undo or redo by any means (`u`, CTRL-R, `Cmd+Z`, the Edit menu, another
	 * file's refactoring undone), or a Cmd+X / Cmd+V (or any command) over the
	 * visual selection. Outside insert mode the editor is then in normal mode
	 * with one caret. VS Code puts back the selection the change started from,
	 * which after a visual-mode change is the visual area; the caret goes to
	 * its start, where Vim puts it (the change's start), and the caret rule
	 * keeps it on a character (modalCursor.ts). After a paste the caret is
	 * VS Code's, after the pasted text.
	 */
	private settle(): void {
		this.settleQueued = false;
		if (!this.editor.getModel() || this.typing()) {
			return;
		}
		if (this.engine.mode !== 'normal' || this.engine.pending) {
			this.engine.reset();
		}
		const selections = this.editor.getSelections();
		if (selections?.some(s => !s.isEmpty())) {
			const start = selections.map(s => s.getStartPosition()).reduce((a, b) => b.isBefore(a) ? b : a);
			this.editor.setPosition(start, 'devhubVim');
		}
		this.owner.update();
	}

	indentUnit(): string {
		const o = this.model.getOptions();
		return o.insertSpaces ? ' '.repeat(o.indentSize) : '\t';
	}

	tabSize(): number {
		return this.model.getOptions().tabSize;
	}

	indentOptions(): VimIndentOptions {
		const o = this.model.getOptions();
		return { tabSize: o.tabSize, indentSize: o.originalIndentSize === 'tabSize' ? 'tabSize' : o.indentSize, insertSpaces: o.insertSpaces };
	}

	setIndentOptions(options: Partial<VimIndentOptions>): void {
		this.model.updateOptions(options);
	}

	defaultIndentOptions(): VimIndentOptions {
		const model = this.model;
		const editor = this.owner.configurationService.getValue<{ tabSize?: unknown; indentSize?: unknown; insertSpaces?: unknown }>('editor', { resource: model.uri, overrideIdentifier: model.getLanguageId() }) ?? {};
		const tabSize = typeof editor.tabSize === 'number' && editor.tabSize > 0 ? editor.tabSize : 4;
		const indentSize = typeof editor.indentSize === 'number' && editor.indentSize > 0 ? editor.indentSize : 'tabSize';
		return { tabSize, indentSize, insertSpaces: typeof editor.insertSpaces === 'boolean' ? editor.insertSpaces : true };
	}

	/**
	 * The lines completely in the window where it is going: during a smooth
	 * scroll that is the animation's target, not the frame on screen, so a
	 * CTRL-D pressed (or repeating) while the last one still animates goes on
	 * from where that one ends, as VS Code's editorScroll does.
	 */
	visibleLines(): { top: number; bottom: number } {
		const vm = this.editor._getViewModel();
		if (vm && this.editor.getLayoutInfo().height > 0) {
			const view = vm.getCompletelyVisibleViewRangeAtScrollTop(vm.viewLayout.getFutureViewport().top);
			const range = vm.coordinatesConverter.convertViewRangeToModelRange(view);
			return { top: range.startLineNumber - 1, bottom: range.endLineNumber - 1 };
		}
		const ranges = this.editor.getVisibleRanges();
		if (!ranges.length) {
			const c = this.getCursor().line;
			return { top: c, bottom: c };
		}
		return { top: ranges[0].startLineNumber - 1, bottom: ranges[ranges.length - 1].endLineNumber - 1 };
	}

	/**
	 * One scroll per command: the target is computed first, the cursor is put
	 * (by `moveCursor`) without a reveal of its own, and then the window goes to
	 * the target in one setScrollTop, animated when `editor.smoothScrolling` is
	 * on. A new target while an animation runs retargets it (the scrollable
	 * combines the two) instead of starting over from where the last one began.
	 * A reveal here would be a second scroll: computed against the target it is
	 * a no-op at best, and when it is under a line from the frame on screen the
	 * editor makes it immediate, which jumps the animation to its end.
	 */
	scrollToLine(line: number, at: 'top' | 'center' | 'bottom', moveCursor?: () => void): void {
		const lineNumber = Math.max(1, Math.min(this.model.getLineCount(), line + 1));
		const top = this.editor.getTopForLineNumber(lineNumber);
		const height = this.editor.getLayoutInfo().height;
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const scrollTop = at === 'top' ? top : at === 'center' ? top - (height - lineHeight) / 2 : top - height + lineHeight;
		if (moveCursor) {
			this.revealSuppressed++;
			try {
				moveCursor();
			} finally {
				this.revealSuppressed--;
			}
		}
		this.editor.setScrollTop(Math.max(0, scrollTop), this.scrollType());
	}

	isLineHidden(line: number): boolean {
		const vm = this.editor._getViewModel();
		return !!vm && !vm.coordinatesConverter.modelPositionIsVisible(new Position(line + 1, 1));
	}

	displayLineMove(from: VimPos, count: number): VimPos | undefined {
		const vm = this.editor._getViewModel();
		const model = this.model;
		if (!vm) {
			const line = from.line + count;
			return line < 0 || line >= model.getLineCount() ? undefined : { line, col: Math.min(from.col, Math.max(0, model.getLineLength(line + 1) - 1)) };
		}
		const view = vm.coordinatesConverter.convertModelPositionToViewPosition(new Position(from.line + 1, from.col + 1));
		const target = view.lineNumber + count;
		if (target < 1 || target > vm.getLineCount()) {
			return undefined;
		}
		const column = Math.min(view.column, vm.getLineMaxColumn(target));
		const m = vm.coordinatesConverter.convertViewPositionToModelPosition(new Position(target, column));
		const len = model.getLineLength(m.lineNumber);
		return { line: m.lineNumber - 1, col: Math.min(m.column - 1, Math.max(0, len - 1)) };
	}

	setClipboard(text: string): void {
		this.owner.clipboardCache = text;
		void this.owner.clipboardService.writeText(text);
	}

	getClipboard(): string {
		return this.owner.clipboardCache;
	}

	prefetchClipboard(): void {
		this.owner.prefetchClipboard();
	}

	findMatches(query: VimSearchQuery, within: VimRange, limit: number): VimMatch[] {
		return this.model.findMatches(query.pattern, toRange(within), true, query.matchCase, this.wordSeparators(query), true, limit).map(toVimMatch);
	}

	findNextMatch(query: VimSearchQuery, from: VimPos, backwards: boolean): VimMatch | undefined {
		const at = new Position(from.line + 1, from.col + 1);
		const m = backwards
			? this.model.findPreviousMatch(query.pattern, at, true, query.matchCase, this.wordSeparators(query), true)
			: this.model.findNextMatch(query.pattern, at, true, query.matchCase, this.wordSeparators(query), true);
		return m ? toVimMatch(m) : undefined;
	}

	replaceString(replacement: string, match: VimMatch): string {
		return parseReplaceString(replacement).buildReplaceString(match.groups as string[]);
	}

	highlightSearch(query: VimSearchQuery | undefined): void {
		this.owner.setSearchHighlight(query);
	}

	closeFindWidgets(): void {
		this.owner.closeFindWidgets();
	}

	showIncSearch(range: VimRange | undefined, keepView?: boolean): void {
		if (!range) {
			this.incDecorations.clear();
			if (this.incOrigin && !keepView) {
				// back exactly where the view was before the pattern was typed
				this.editor.setScrollPosition(this.incOrigin, this.scrollType());
			}
			this.incOrigin = undefined;
			return;
		}
		if (!this.incOrigin) {
			this.incOrigin = { scrollTop: this.editor.getScrollTop(), scrollLeft: this.editor.getScrollLeft() };
		}
		const r = new Range(range.start.line + 1, range.start.col + 1, range.end.line + 1, range.end.col + 1);
		this.incDecorations.set([{ range: r, options: INCSEARCH_DECORATION }]);
		this.editor.revealRangeInCenterIfOutsideViewport(r, this.scrollType());
	}

	lineComment(): string | undefined {
		const model = this.model;
		return this.owner.languageConfigurationService.getLanguageConfiguration(model.getLanguageId()).comments?.lineCommentToken;
	}

	hasRangeFormatter(): boolean {
		return this.owner.languageFeaturesService.documentRangeFormattingEditProvider.has(this.model);
	}

	fileName(): string {
		return this.owner.labelService.getUriLabel(this.model.uri, { relative: true });
	}

	executeCommand(command: string, args: unknown): Promise<unknown> {
		if ((FROM_COMMANDS as readonly string[]).includes(command) && (args === undefined || (typeof args === 'object' && args !== null && !('from' in args)))) {
			// `:e {file}` `:sp {file}` `:w {file}` `:!cmd` ...: `%` and the current directory are this editor's, even after a split moved the focus
			args = { ...(args as object | undefined), from: this.model.uri.toString() };
		}
		return this.owner.commandService.executeCommand(command, ...(args === undefined ? [] : [args]));
	}

	refresh(): void {
		this.owner.update();
	}
}

export class DevhubVim extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.devhubVim';
	static instance: DevhubVim | undefined;

	private readonly editors = new Map<ICodeEditor, VimEditor>();
	private readonly attached = this._register(new DisposableStore());
	private readonly shared = new VimSharedState();
	private readonly modeKey: IContextKey<string>;
	private readonly activeKeys: IContextKey<boolean>[];
	private readonly engineKeys: { [K in keyof VimContext]?: IContextKey<VimContext[K]> };
	private readonly whenCache = new Map<string, ContextKeyExpression | undefined>();
	private statusEntry: IStatusbarEntryAccessor | undefined;
	private enabled = false;
	/** Whether the editor's overtype input mode is Vim's replace mode (so leaving it puts insert back). */
	private overtypeOwned = false;
	/** 'hlsearch': the last pattern, shared by every editor, until :nohlsearch. */
	searchHighlight: VimSearchQuery | undefined;
	/** The prompt line, made when the first prompt opens. */
	private cmdline: VimCmdline | undefined;
	readonly nav = new VimNavPrefix();
	clipboardCache = '';

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IConfigurationService readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IKeybindingService readonly keybindingService: IKeybindingService,
		@ICommandService readonly commandService: ICommandService,
		@IClipboardService readonly clipboardService: IClipboardService,
		@ILanguageConfigurationService readonly languageConfigurationService: ILanguageConfigurationService,
		@ILanguageFeaturesService readonly languageFeaturesService: ILanguageFeaturesService,
		@ILabelService readonly labelService: ILabelService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		DevhubVim.instance = this;
		this.modeKey = VIM_MODE.bindTo(contextKeyService);
		this.activeKeys = [VIM_ACTIVE.bindTo(contextKeyService), VIM_ATTACHED.bindTo(contextKeyService)];
		this.engineKeys = {
			acceptsMotion: VIM_ACCEPTS_MOTION.bindTo(contextKeyService),
			hasCount: VIM_HAS_COUNT.bindTo(contextKeyService),
			pending: VIM_PENDING.bindTo(contextKeyService),
			pendingOperator: VIM_PENDING_OPERATOR.bindTo(contextKeyService),
			textObjectPending: VIM_TEXT_OBJECT_PENDING.bindTo(contextKeyService),
			awaitingChar: VIM_AWAITING_CHAR.bindTo(contextKeyService),
			recording: VIM_RECORDING.bindTo(contextKeyService),
			visual: VIM_VISUAL.bindTo(contextKeyService),
			insert: VIM_INSERT.bindTo(contextKeyService),
		};
		this.shared.setUserExCommands(exCommandsSetting(configurationService));
		this.shared.setOptions(configurationService.getValue(OPTIONS_SETTING));
		this.shared.inccommand = inccommandOf(configurationService.getValue(INCCOMMAND_SETTING));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SETTING)) {
				this.setEnabled(!!configurationService.getValue<boolean>(SETTING));
			}
			if (e.affectsConfiguration(EX_SETTING)) {
				this.shared.setUserExCommands(exCommandsSetting(configurationService));
			}
			if (e.affectsConfiguration(OPTIONS_SETTING)) {
				this.shared.setOptions(configurationService.getValue(OPTIONS_SETTING));
			}
			if (e.affectsConfiguration(INCCOMMAND_SETTING)) {
				this.shared.inccommand = inccommandOf(configurationService.getValue(INCCOMMAND_SETTING));
			}
			if (e.affectsConfiguration('editor.cursorStyle')) {
				for (const v of this.editors.values()) {
					v.refreshCursorStyle();
				}
			}
		}));
		this.setEnabled(!!configurationService.getValue<boolean>(SETTING));
	}

	override dispose(): void {
		this.setEnabled(false);
		if (DevhubVim.instance === this) {
			DevhubVim.instance = undefined;
		}
		super.dispose();
	}

	/** A when clause of the keymap's, parsed once. */
	whenExpr(when: string): ContextKeyExpression | undefined {
		if (!this.whenCache.has(when)) {
			this.whenCache.set(when, ContextKeyExpr.deserialize(when));
		}
		return this.whenCache.get(when);
	}

	private setEnabled(enabled: boolean): void {
		if (enabled === this.enabled) {
			return;
		}
		this.enabled = enabled;
		this.cmdline?.dispose();
		this.cmdline = undefined;
		this.attached.clear();
		this.editors.clear();
		this.nav.cancel();
		this.statusEntry = undefined;
		if (!enabled) {
			this.modeKey.reset();
			for (const k of this.activeKeys) {
				k.reset();
			}
			for (const k of Object.values(this.engineKeys)) {
				k.reset();
			}
			this.syncOvertype(false);
			return;
		}
		const store = this.attached;
		for (const editor of this.codeEditorService.listCodeEditors()) {
			this.attach(editor);
		}
		store.add(this.codeEditorService.onCodeEditorAdd(editor => this.attach(editor)));
		store.add(this.codeEditorService.onCodeEditorRemove(editor => this.detach(editor)));
		store.add(ModalTextInput.onDidCommitText(({ editorId, text }) => {
			for (const v of this.editors.values()) {
				if (v.editor.getId() === editorId) {
					v.commitText(text);
				}
			}
		}));
		store.add({ dispose: () => { for (const v of this.editors.values()) { v.dispose(); } } });
		store.add(Event.runAndSubscribe(onDidRegisterWindow, ({ window, disposables }) => {
			const local = new DisposableStore();
			disposables.add(local);
			store.add(local);
			local.add(addDisposableListener(window, 'keydown', e => this.onWindowKeyDown(e), true));
			local.add(addDisposableListener(window, 'pointerdown', () => this.cancelNav(), true));
			local.add(addDisposableListener(window, 'blur', () => this.cancelNav()));
			local.add(addDisposableListener(window, 'focusin', () => this.update(), true));
			local.add(addDisposableListener(window, 'focusout', () => queueMicrotask(() => this.update()), true));
		}, { window: mainWindow, disposables: store }));
		this.statusEntry = this.statusbarService.addEntry(this.statusProps(''), 'status.devhubVim', StatusbarAlignment.LEFT, -100);
		store.add(this.statusEntry);
		this.update();
	}

	private attach(editor: ICodeEditor): void {
		if (this.editors.has(editor)) {
			return;
		}
		if (!vimDrives(editor.getContainerDomNode())) {
			return;
		}
		// Synchronous, in the editor's constructor (onCodeEditorAdd): modal in
		// normal mode with Vim's caret before the editor can take a key.
		const v = new VimEditor(editor, this, this.shared);
		this.editors.set(editor, v);
		v.syncCursorStyle();
	}

	private detach(editor: ICodeEditor): void {
		this.editors.get(editor)?.dispose();
		this.editors.delete(editor);
	}

	private focused(): VimEditor | undefined {
		for (const v of this.editors.values()) {
			if (v.editor.hasTextFocus()) {
				return v;
			}
		}
		return undefined;
	}

	/** A `devhubVim.*` engine command (from a keybinding, the command palette, an ex command): for the focused Vim editor. */
	execute(command: string, args: unknown): void {
		this.focused()?.execute(command, args);
	}

	prefetchClipboard(): void {
		void this.clipboardService.readText().then(t => this.clipboardCache = t, () => { });
	}

	/** 'hlsearch' is global, as in Vim: every editor shows the last pattern until :nohlsearch. */
	setSearchHighlight(query: VimSearchQuery | undefined): void {
		this.searchHighlight = query;
		for (const v of this.editors.values()) {
			v.scheduleHighlight();
		}
	}

	/** :nohlsearch in any editor closes the find widget in every one. */
	closeFindWidgets(): void {
		for (const v of this.editors.values()) {
			v.closeFindWidget();
		}
	}

	/** Replace mode is the editor's overtype input mode while a Vim editor in replace mode has the focus. */
	private syncOvertype(want: boolean): void {
		if (want && InputMode.getInputMode() !== 'overtype') {
			InputMode.setInputMode('overtype');
			this.overtypeOwned = true;
		} else if (!want && this.overtypeOwned) {
			this.overtypeOwned = false;
			if (InputMode.getInputMode() === 'overtype') {
				InputMode.setInputMode('insert');
			}
		}
	}

	/**
	 * The prompt line follows the engines: the prompt the focused engine
	 * opened is shown (once: VimEngine.cmdlineState.id), and a prompt whose
	 * engine closed it (Esc fed by a macro, the editor's model changed, the
	 * editor went away) is hidden. Returns whether the line was just shown
	 * (the focus moved into it).
	 */
	private syncCmdline(v: VimEditor | undefined): boolean {
		const line = this.cmdline;
		if (line?.openId !== undefined) {
			const origin = line.originEditor && this.editors.get(line.originEditor);
			if (!origin || origin.engine.cmdlineState?.id !== line.openId) {
				line.close();
			}
		}
		const state = v?.engine.cmdlineState;
		if (!v || !state || state.id === (this.cmdline?.lastShown ?? 0)) {
			return false;
		}
		if (!this.cmdline) {
			this.cmdline = this.instantiationService.createInstance(VimCmdline);
		}
		this.cmdline.open(v.cmdlineOrigin(), state.kind, state.text, state.id);
		return true;
	}

	/** Recompute context keys, cursor styles, modal input and the status bar after anything moved. */
	update(): void {
		if (!this.enabled) {
			return;
		}
		for (const e of this.editors.values()) {
			try {
				e.syncCursorStyle();
			} catch (err) {
				onUnexpectedError(err);
			}
		}
		try {
			if (this.syncCmdline(this.focused())) {
				// the focus is in the prompt line now: the state below is the line's
				this.update();
				return;
			}
		} catch (err) {
			onUnexpectedError(err);
		}
		const prompt = this.cmdline?.hasFocus && this.cmdline.originEditor ? this.editors.get(this.cmdline.originEditor) : undefined;
		const v = this.focused();
		const ctx = v?.context();
		this.syncOvertype(v?.engine.mode === 'replace');
		const active = getActiveElement();
		const mode = this.nav.active ? 'nav'
			: ctx ? ctx.mode
				: prompt ? 'cmdline'
					: active && isEditableElement(active) ? 'insert' : '';
		this.modeKey.set(mode);
		for (const k of this.activeKeys) {
			k.set(!!v);
		}
		const keys = this.engineKeys;
		keys.acceptsMotion?.set(!this.nav.active && !!ctx?.acceptsMotion);
		keys.hasCount?.set(!!ctx?.hasCount);
		keys.pending?.set(!!ctx?.pending);
		keys.pendingOperator?.set(ctx?.pendingOperator ?? '');
		keys.textObjectPending?.set(ctx?.textObjectPending ?? '');
		keys.awaitingChar?.set(!!ctx?.awaitingChar);
		keys.recording?.set(!!ctx?.recording);
		keys.visual?.set(!!ctx?.visual);
		keys.insert?.set(!!ctx?.insert);
		const text = this.nav.active ? '-- NAV --  ^W' : v ? v.engine.status() : prompt ? prompt.engine.status() : mode === 'insert' ? '-- INSERT --' : '';
		this.statusEntry?.update(this.statusProps(text));
	}

	private statusProps(text: string) {
		return {
			name: localize('devhubVim.status', "Vim Mode"),
			text: text || 'VIM',
			ariaLabel: text || localize('devhubVim.idle', "Vim"),
		};
	}

	cancelNav(): void {
		if (this.nav.active) {
			this.nav.cancel();
			this.update();
		}
	}

	private navFocus(v: VimEditor | undefined): VimNavFocus {
		if (v) {
			return v.engine.mode === 'insert' || v.engine.mode === 'replace' ? 'insert' : v.engine.pending ? 'pending' : 'normal';
		}
		if (this.contextKeyService.getContextKeyValue<boolean>('terminalFocus')) {
			return 'terminal';
		}
		const active = getActiveElement();
		return active && isEditableElement(active) ? 'input' : 'other';
	}

	/** `<C-w>`: wait for one nav key. */
	enterNav(): void {
		const v = this.focused();
		const focus = this.navFocus(v);
		if (!this.nav.enter(focus) && focus === 'pending') {
			// As in Vim, `<C-w>` is not a motion: it aborts the operator / count.
			v?.execute('devhubVim.escape', undefined);
		}
		this.update();
	}

	/** A nav command: the prefix is over, then the commands (if any) run in order. */
	runNav(commands: readonly string[]): void {
		this.cancelNav();
		void (async () => {
			for (const c of commands) {
				await this.commandService.executeCommand(c);
			}
		})().catch(onUnexpectedError);
	}

	/**
	 * While `<C-w>` waits, its key goes to the keybinding service before the
	 * focused widget (a list's type-to-find, an input's typing) sees it. A key
	 * that resolves to a command (a `devhubVim.nav.*` one, a user's
	 * `devhubVim.mode == 'nav'` binding, any binding that applies here) runs it
	 * once, as the dispatcher would; any other key ends the prefix
	 * (VimNavPrefix.key decides whether it is eaten or let through). The prefix
	 * is over before the command runs. The editor's Backspace / Tab / Delete do
	 * not apply in nav mode (EditorContextKeys.devhubVimAllowsTyping), so
	 * Ctrl-W Backspace edits nothing without any filter here.
	 */
	private onWindowKeyDown(e: KeyboardEvent): void {
		if (!this.nav.active) {
			return;
		}
		const event = new StandardKeyboardEvent(e);
		const found = this.navBinding(event, e.target as HTMLElement);
		const action = this.nav.key(e, found?.commandId ?? undefined);
		if (action === 'wait') {
			return;
		}
		this.update();
		if (action === 'pass') {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		if (action === 'run' && found?.commandId) {
			this.commandService.executeCommand(found.commandId, ...(found.commandArgs === undefined ? [] : [found.commandArgs])).catch(onUnexpectedError);
		}
	}

	/** The command the key resolves to while nav waits, if any. */
	private navBinding(event: StandardKeyboardEvent, target: HTMLElement): { commandId: string; commandArgs: unknown } | undefined {
		const result = this.keybindingService.softDispatch(event, target);
		return result.kind === ResultKind.KbFound && result.commandId ? { commandId: result.commandId, commandArgs: result.commandArgs } : undefined;
	}
}

// BlockStartup: created before the workbench renders its parts, so it exists
// before the first editor (the restored ones included) and attaches to each
// editor synchronously, at the end of its constructor (onCodeEditorAdd). With
// no editor yet its constructor only binds context keys and reads three
// settings. (At AfterRestored it was created when the workbench was idle after
// the editors were restored, and the editor took text until then.)
registerWorkbenchContribution2(DevhubVim.ID, DevhubVim, WorkbenchPhase.BlockStartup);

// ---- the engine's commands and the default Vim keymap ------------------------

const COMMAND_DESCRIPTIONS: Record<string, string> = {
	'devhubVim.motion': localize('devhubVim.cmd.motion', "Vim: motion { motion, char? } (moves, extends the visual selection, or completes a pending operator)"),
	'devhubVim.operator': localize('devhubVim.cmd.operator', "Vim: operator { operator: delete | change | yank | indent | outdent | reindent | lowercase | uppercase | toggleCase | rot13 | format | formatKeep | comment | fold | surround | surroundLines }"),
	'devhubVim.textObjectPrefix': localize('devhubVim.cmd.textObjectPrefix', "Vim: start a text object { kind: inner | around } (i / a)"),
	'devhubVim.textObject': localize('devhubVim.cmd.textObject', "Vim: text object { object, kind? }"),
	'devhubVim.forceMotion': localize('devhubVim.cmd.forceMotion', "Vim: force the next motion { type: char | line | block } (o_v, o_V, o_CTRL-V)"),
	'devhubVim.count': localize('devhubVim.cmd.count', "Vim: count digit { digit }"),
	'devhubVim.register': localize('devhubVim.cmd.register', "Vim: use register { name }"),
	'devhubVim.awaitChar': localize('devhubVim.cmd.awaitChar', "Vim: wait for a character, then run { then: { command, args } } with args.char set"),
	'devhubVim.mode': localize('devhubVim.cmd.mode', "Vim: mode { to: normal | insert | replace | visual | visualLine | visualBlock, at? }"),
	'devhubVim.action': localize('devhubVim.cmd.action', "Vim: action { action, char? }"),
	'devhubVim.mark': localize('devhubVim.cmd.mark', "Vim: set a mark { char }"),
	'devhubVim.scroll': localize('devhubVim.cmd.scroll', "Vim: scroll { by: line | halfPage | page, direction: up | down } or { to: top | center | bottom, firstNonBlank? }"),
	'devhubVim.insert': localize('devhubVim.cmd.insert', "Vim: an insert-mode command { action, char? }"),
	'devhubVim.run': localize('devhubVim.cmd.run', "Vim: run a command as a Vim action { command, args?, visual?: exit | keep } or { commands: [...] }; args may use ${count} ${rawCount} ${register} ${char}"),
	'devhubVim.repeat': localize('devhubVim.cmd.repeat', "Vim: run { command, args? } count times { count: number | \"${count}\" }; args may use ${it} (1, 2, ...) and ${index} (0, 1, ...)"),
	'devhubVim.cmdline': localize('devhubVim.cmd.cmdline', "Vim: open the prompt { kind: ':' | '/' | '?' }"),
	'devhubVim.search': localize('devhubVim.cmd.search', "Vim: search { pattern, backwards? }"),
	'devhubVim.ex': localize('devhubVim.cmd.ex', "Vim: run an ex command line { command }"),
	'devhubVim.insertText': localize('devhubVim.cmd.insertText', "Vim: insert text in insert mode { text } (macro replay)"),
	'devhubVim.escape': localize('devhubVim.cmd.escape', "Vim: Esc (cancel one thing; always ends in normal mode)"),
	'devhubVim.substituteConfirm': localize('devhubVim.cmd.substituteConfirm', "Vim: answer the :s///c question { char: y | n | a | q | l }"),
	'devhubVim.surround': localize('devhubVim.cmd.surround', "Vim: vim-surround { action: delete | change | wrap, char?, lines? } (ds cs cS, and the character ys yS yss ySS and visual S gS wait for)"),
};

for (const id of VIM_ENGINE_COMMANDS) {
	CommandsRegistry.registerCommand({
		id,
		handler: (_accessor, args: unknown) => DevhubVim.instance?.execute(id, args),
		metadata: { description: COMMAND_DESCRIPTIONS[id] ?? id, args: [{ name: 'args', isOptional: true, schema: { type: 'object' } }] },
	});
}

const WEIGHTS = VIM_WEIGHTS;
if (VIM_WEIGHTS.default !== KeybindingWeight.EditorContrib || VIM_WEIGHTS.override !== KeybindingWeight.WorkbenchContrib + 50 || VIM_WEIGHTS.escape !== KeybindingWeight.EditorCore + 50 || VIM_WEIGHTS.insertEscape !== KeybindingWeight.WorkbenchContrib + 60 || VIM_WEIGHTS.cmdline !== KeybindingWeight.WorkbenchContrib + 55) {
	onUnexpectedError(new Error('devhubVim: VIM_WEIGHTS (vimKeymap.ts) no longer match KeybindingWeight'));
}

// Parsed as keybindings.json is (KeybindingParser), so the JIS keys in
// scan-code notation (`shift+[Quote]`) are default keybindings like any other:
// shown, overridable and removable in the Keyboard Shortcuts editor. The
// prompt line's keys (common/vimCmdline.ts) are registered the same way.
for (const b of [...DEFAULT_KEYBINDINGS, ...CMDLINE_KEYBINDINGS]) {
	const keybinding = KeybindingParser.parseKeybinding(b.key);
	const when = ContextKeyExpr.deserialize(b.when);
	if (!keybinding || !when) {
		onUnexpectedError(new Error(`devhubVim: cannot register the default keybinding ${b.key} -> ${b.command}`));
		continue;
	}
	KeybindingsRegistry.registerKeybinding({
		id: b.command,
		args: b.args,
		keybinding,
		when: ContextKeyExpr.and(ENABLED, when),
		weight: WEIGHTS[b.weight ?? 'default'],
	});
}

// ---- <C-w> window commands (all overridable) ---------------------------------

const NAV = ContextKeyExpr.and(ENABLED, VIM_MODE.isEqualTo('nav'));

interface Keys {
	primary: number;
	secondary?: number[];
	mac?: { primary: number; secondary?: number[] };
}

/** Ctrl+key on every platform (KeyMod.WinCtrl is Ctrl on macOS, where CtrlCmd is Cmd). */
function ctrl(key: KeyCode): number[] {
	return [KeyMod.CtrlCmd | key, KeyMod.WinCtrl | key];
}

function rule(id: string, keys: Keys, when: ContextKeyExpression | undefined, weight: number, run: (vim: DevhubVim) => void): void {
	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id, ...keys, when, weight,
		handler: () => {
			const vim = DevhubVim.instance;
			if (vim) {
				run(vim);
			}
		},
	});
}

// The prefix, Ctrl-W. Not in a Vim editor's insert mode (Ctrl-W deletes a word
// there, vimKeymap.ts), not in the terminal (the shell's Ctrl-W), not in quick
// input. While Vim is on it outranks Ctrl-W's defaults: Switch Window on macOS
// (Cmd-W, close editor, is another key and untouched), close editor elsewhere.
const [ctrlW, macCtrlW] = ctrl(KeyCode.KeyW);
rule('devhubVim.nav.enter', { primary: ctrlW, mac: { primary: macCtrlW } },
	ContextKeyExpr.and(ENABLED, VIM_MODE.notEqualsTo('nav'), VIM_CMDLINE_FOCUS.negate(),
		ContextKeyExpr.or(VIM_ACTIVE.negate(), VIM_INSERT.negate()),
		ContextKeyExpr.has('terminalFocus').negate(), ContextKeyExpr.has('inQuickInput').negate()),
	KeybindingWeight.WorkbenchContrib + 50, vim => vim.enterNav());
rule('devhubVim.nav.escape', { primary: KeyCode.Escape }, NAV, KeybindingWeight.EditorCore + 50, vim => vim.runNav([]));

/** `<C-w>{key}`: [command id suffix, key (by character, US notation, as the keymap; registered on the JIS keys), also with Ctrl held, commands it runs]. */
const NAV_COMMANDS: readonly [string, string, boolean, readonly string[]][] = [
	['left', 'h', true, ['workbench.action.navigateLeft']],
	['down', 'j', true, ['workbench.action.navigateDown']],
	['up', 'k', true, ['workbench.action.navigateUp']],
	['right', 'l', true, ['workbench.action.navigateRight']],
	['leftArrow', 'left', false, ['workbench.action.navigateLeft']],
	['downArrow', 'down', false, ['workbench.action.navigateDown']],
	['upArrow', 'up', false, ['workbench.action.navigateUp']],
	['rightArrow', 'right', false, ['workbench.action.navigateRight']],
	['next', 'w', true, ['workbench.action.focusNextGroup']],
	['previous', 'shift+w', false, ['workbench.action.focusPreviousGroup']],
	['lastAccessed', 'p', true, ['workbench.action.focusPreviousGroup']],
	['top', 't', true, ['workbench.action.focusFirstEditorGroup']],
	['bottom', 'b', true, ['workbench.action.focusLastEditorGroup']],
	['split', 's', true, ['workbench.action.splitEditorUp']],
	['splitShift', 'shift+s', false, ['workbench.action.splitEditorUp']],
	['vsplit', 'v', true, ['workbench.action.splitEditorLeft']],
	['new', 'n', true, ['workbench.action.splitEditorUp', 'workbench.action.files.newUntitledFile']],
	['close', 'c', false, ['workbench.action.closeGroup']],
	['quit', 'q', true, ['workbench.action.closeActiveEditor']],
	['only', 'o', true, ['workbench.action.closeEditorsInOtherGroups']],
	['equalize', '=', false, ['workbench.action.evenEditorWidths']],
	['maximizeHeight', 'shift+-', false, ['workbench.action.toggleMaximizeEditorGroup']],
	['maximizeWidth', 'shift+\\', false, ['workbench.action.toggleMaximizeEditorGroup']],
	['increaseHeight', 'shift+=', false, ['workbench.action.increaseViewHeight']],
	['decreaseHeight', '-', false, ['workbench.action.decreaseViewHeight']],
	['decreaseWidth', 'shift+,', false, ['workbench.action.decreaseViewWidth']],
	['increaseWidth', 'shift+.', false, ['workbench.action.increaseViewWidth']],
	['moveFarLeft', 'shift+h', false, ['workbench.action.moveActiveEditorGroupLeft']],
	['moveFarDown', 'shift+j', false, ['workbench.action.moveActiveEditorGroupDown']],
	['moveFarUp', 'shift+k', false, ['workbench.action.moveActiveEditorGroupUp']],
	['moveFarRight', 'shift+l', false, ['workbench.action.moveActiveEditorGroupRight']],
	// Neovim: <C-w>d / <C-w><C-d> show the diagnostic at the cursor (CTRL-W_d-default)
	['diagnostic', 'd', true, ['editor.action.showHover']],
	// 'tagfunc' is the language server's: <C-w>] splits to the definition, <C-w>} previews it
	['definitionSplit', ']', true, ['editor.action.revealDefinitionAside']],
	['definitionPreview', 'shift+]', false, ['editor.action.peekDefinition']],
];
for (const [name, key, withCtrl, commands] of NAV_COMMANDS) {
	const id = `devhubVim.nav.${name}`;
	CommandsRegistry.registerCommand(id, () => DevhubVim.instance?.runNav(commands));
	for (const k of [...jisKeys(key), ...(withCtrl ? jisKeys(`ctrl+${key}`) : [])]) {
		const keybinding = KeybindingParser.parseKeybinding(k);
		if (keybinding) {
			KeybindingsRegistry.registerKeybinding({ id, keybinding, when: NAV, weight: KeybindingWeight.WorkbenchContrib + 50 });
		} else {
			onUnexpectedError(new Error(`devhubVim: cannot register ${k} -> ${id}`));
		}
	}
}
