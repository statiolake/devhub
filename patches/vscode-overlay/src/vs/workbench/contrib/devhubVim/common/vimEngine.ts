/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the editor-independent state machine.
//
// The engine does not read keys. It is driven by commands with arguments
// (`devhubVim.motion { motion: 'wordForward' }`, `devhubVim.operator
// { operator: 'delete' }`, ...), which the workbench binds to keys as
// ordinary keybindings (common/vimKeymap.ts holds the defaults, Neovim's).
// What makes it Vim is the grammar state it keeps between commands - count,
// register, pending operator, pending text object (`i`/`a`), a forced motion
// type (`dv`), a command waiting for a character (f t r " q @ m ' `), the
// visual range, marks, the last change and macros - and
// publishes as context keys (`context()`), so that a keybinding's `when` can
// tell, e.g., `0` the count digit from `0` the motion. Composition happens
// here: `d` only marks an operator as pending, and whatever motion or text
// object command comes next completes it, whichever key ran it. `.` and
// macros replay the recorded commands (with the characters they captured and
// the text typed in insert mode), never keys, so remapping keys cannot break
// them.
//
// The behaviour follows Neovim's defaults (`:help vim-differences`):
// 'nostartofline', 'hlsearch', 'incsearch', 'nojoinspaces', 'nrformats'
// "bin,hex", 'whichwrap' "b,s", `Y` is `y$`, `Q` replays the last recorded
// register, `&` is `:&&`, `gc` comments.
//
// This file imports only the other `common` modules (none of which import
// anything): it is the whole of Vim's grammar against a small `IVimHost`
// that reads lines and applies edits. The browser half
// (../browser/devhubVim.contribution.ts) implements the host on top of a
// CodeEditorWidget and ITextModel; the tests implement it on a string array.
// Nothing here copies the document: motions read the lines they walk over,
// one `lineText()` at a time, so a command in a large file costs what it
// touches, not the file size.
//
// Patterns (`/ ? * # n`, `:s`, `:g`, `:sort /pat/`, `gn`) are JavaScript
// regular expressions, matched by VS Code's find (the host's findMatches /
// findNextMatch: TextModel's, with "Use Regular Expression" on, multiline
// as VS Code's find is), and `:s` replacement strings are the find widget's
// ($1 $& \n \t \u \U \l \L). Vim's regex dialect is not translated.
//
// Positions are 0-based { line, col } (UTF-16 columns); `col ===
// lineText(line).length` is the position of the line break. Edit ranges are
// end-exclusive.

import type { IVimCmdlineCompletionSources, IVimCmdlineTarget, VimCmdlineKind, VimExCommandInfo, VimOptionInfo } from './vimCmdline.js';
import { VimCmdlineController, VimStringLine } from './vimCmdline.js';
import type { ExAddressContext, ExStep, ParsedExCommand } from './vimEx.js';
import { ExRegistry, exInvocation, expandExSpec, parseExCommand, parseExCommands, parseGlobal, parseSubstitute, resolveExAddress, resolveExRange } from './vimEx.js';
import { DEFAULT_KEYBINDINGS, evaluateWhen, keybindingForVimKey, keysOf } from './vimKeymap.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { addToNumber, charClassAt, charWidth, colOfVcol, formatLines, isBlank, isKeywordClass, rot13, toggleCase, vcolOf } from './vimText.js';

export interface VimPos {
	readonly line: number;
	readonly col: number;
}

export interface VimEdit {
	readonly start: VimPos;
	readonly end: VimPos;
	readonly text: string;
}

export interface VimRange {
	readonly start: VimPos;
	readonly end: VimPos;
}

export type VimMode = 'normal' | 'insert' | 'replace' | 'visual' | 'visualLine' | 'visualBlock';

/** `devhubVim.mode` as the engine sees it (the workbench adds `nav` and `''`). */
export type VimContextMode = VimMode | 'operatorPending' | 'cmdline';

/** The engine's context keys (`devhubVim.<name>`), recomputed after every command. */
export interface VimContext {
	readonly mode: VimContextMode;
	/** A motion, operator, count or action may come next (normal, visual or operator-pending; nothing captures the next key). */
	readonly acceptsMotion: boolean;
	readonly hasCount: boolean;
	/** A count, register, operator, text object prefix or character argument is pending. */
	readonly pending: boolean;
	/** The pending operator's name (`delete`, ...) or ''. */
	readonly pendingOperator: string;
	/** `inner` or `around` after `i` / `a`, or ''. */
	readonly textObjectPending: string;
	/** The next key or IME commit is a character argument (f t r " q @ ...). */
	readonly awaitingChar: boolean;
	/** A macro is being recorded. */
	readonly recording: boolean;
	/** Any visual mode (visual, visualLine, visualBlock). */
	readonly visual: boolean;
	/** Insert or replace mode (the keys type text). */
	readonly insert: boolean;
}

export interface IVimHost {
	lineCount(): number;
	lineText(line: number): string;
	getCursor(): VimPos;
	/**
	 * `jump`: a Vim jump (G, /, n, %, a mark, :s ...), which VS Code's history
	 * records as one (TextEditorSelectionSource.JUMP) and which is revealed as
	 * the find widget reveals a match (in the center if outside the viewport).
	 */
	setCursor(pos: VimPos, jump?: boolean): void;
	/** The editor's selection (after a command that changed it). */
	getSelection(): { anchor: VimPos; active: VimPos };
	/** Show a selection; `end` is exclusive. `cursorAtStart` puts the caret at `start`. */
	setSelection(start: VimPos, end: VimPos, cursorAtStart: boolean, jump?: boolean): void;
	/** Several selections (visual block: one per line); the caret is in `ranges[primary]`, at its start when `cursorAtStart`. */
	setSelections(ranges: readonly VimRange[], primary: number, cursorAtStart: boolean, jump?: boolean): void;
	/** Apply non-overlapping edits (in pre-edit coordinates) synchronously. */
	applyEdits(edits: readonly VimEdit[]): void;
	/**
	 * Brackets one Vim change: the undo step is closed at both ends, so `u`
	 * (VS Code's undo) never undoes part of a normal-mode change together with
	 * what came before or after it. Typing in an insert keeps VS Code's own
	 * undo stops in between.
	 */
	beginChange(): void;
	endChange(): void;
	/** VS Code's undo / redo, one step (`:undo`, `devhubVim.action undo`; the `u` key is the `undo` command itself). */
	undo(): void;
	redo(): void;
	indentUnit(): string;
	tabSize(): number;
	/**
	 * The buffer's 'tabstop' 'shiftwidth' 'expandtab': the model's tab size,
	 * indent size (`'tabSize'` when it follows the tab size, 'shiftwidth' 0)
	 * and insert spaces, which VS Code's display and indentation follow.
	 */
	indentOptions(): VimIndentOptions;
	/** `:set ts= sw= et`: the model's options (ITextModel.updateOptions). */
	setIndentOptions(options: Partial<VimIndentOptions>): void;
	/** `:set ts&`: what the settings say for this file (editor.tabSize, editor.indentSize, editor.insertSpaces). */
	defaultIndentOptions(): VimIndentOptions;
	/** The first and last line on screen (0-based). */
	visibleLines(): { top: number; bottom: number };
	/**
	 * Scroll so that `line` is at the top, center or bottom of the window
	 * (animated when the editor scrolls smoothly). `moveCursor` runs first and
	 * the cursor or selection it sets is not revealed: it is in the window the
	 * scroll goes to, and one command is one scroll.
	 */
	scrollToLine(line: number, at: 'top' | 'center' | 'bottom', moveCursor?: () => void): void;
	/** Whether the line is inside a closed fold (hidden). */
	isLineHidden(line: number): boolean;
	/** `count` screen lines down (negative: up) from `from` (gj / gk); undefined when there is none. */
	displayLineMove(from: VimPos, count: number): VimPos | undefined;
	setClipboard(text: string): void;
	/** Last known system clipboard text; `prefetchClipboard` refreshes it. */
	getClipboard(): string;
	prefetchClipboard(): void;
	/**
	 * VS Code's find over `within` (TextModel.findMatches, with "Use Regular
	 * Expression" on): at most `limit` matches, in order, with their groups.
	 */
	findMatches(query: VimSearchQuery, within: VimRange, limit: number): VimMatch[];
	/** VS Code's Find Next / Find Previous from `from` (TextModel.findNextMatch / findPreviousMatch: they wrap around the file). */
	findNextMatch(query: VimSearchQuery, from: VimPos, backwards: boolean): VimMatch | undefined;
	/** The find widget's replace string for a match (`$1` `$&` `\n` `\t` `\u` `\U` `\l` `\L`: parseReplaceString). */
	replaceString(replacement: string, match: VimMatch): string;
	/** 'hlsearch': highlight every match of `query` (undefined: none). */
	highlightSearch(query: VimSearchQuery | undefined): void;
	/**
	 * 'incsearch': show this match while the pattern is typed, revealed as
	 * VS Code's find widget reveals one (in the center if outside the
	 * viewport). Undefined: no match; the view goes back to where it was,
	 * unless `keepView` (Enter: the search's jump lands where the preview
	 * showed, with the same reveal rule, so the view does not move again).
	 */
	showIncSearch(range: VimRange | undefined, keepView?: boolean): void;
	/**
	 * 'inccommand': show what the `:s` being typed would do. The host runs
	 * `compute` (soon, debounced) and draws what it returns: each match struck
	 * through with its replacement after it, or only highlighted (`text`
	 * undefined) while just the pattern is typed. Undefined clears it.
	 */
	previewSubstitute(compute: (() => readonly VimSubstitution[] | undefined) | undefined): void;
	/** The language's line comment token (`//`), for `gc` text objects and gq. */
	lineComment(): string | undefined;
	/** Whether a formatter can format a range (`gq` uses it, as Neovim's LSP 'formatexpr'). */
	hasRangeFormatter(): boolean;
	/** The file name, for the `%` register. */
	fileName(): string;
	/** Run a command that is not the engine's own (ex commands, `devhubVim.run`, `awaitChar` targets). */
	executeCommand(command: string, args: unknown): Promise<unknown>;
	/** Something finished asynchronously (an ex command): show the new state. */
	refresh(): void;
}

export interface VimIndentOptions {
	readonly tabSize: number;
	readonly indentSize: number | 'tabSize';
	readonly insertSpaces: boolean;
}

/** Vim's buffer options that are the model's indentation options, by name and short name. */
const BUFFER_OPTIONS: Readonly<Record<string, 'tabstop' | 'shiftwidth' | 'expandtab'>> = {
	tabstop: 'tabstop', ts: 'tabstop', shiftwidth: 'shiftwidth', sw: 'shiftwidth', expandtab: 'expandtab', et: 'expandtab',
};

export type VimRegisterType = 'char' | 'line' | 'block';

export interface VimRegister {
	readonly text: string;
	readonly type: VimRegisterType;
}

/** One executed engine command, as `.` and macros replay it. */
export interface VimStep {
	readonly command: string;
	readonly args: Readonly<Record<string, unknown>>;
}

/** A search as VS Code's find runs it. */
export interface VimSearchQuery {
	/** A JavaScript regular expression (VS Code's find with "Use Regular Expression" on). */
	readonly pattern: string;
	readonly matchCase: boolean;
	/** VS Code's "Match Whole Word" (`editor.wordSeparators`, and where the script changes). */
	readonly wholeWord: boolean;
}

export interface VimMatch {
	readonly range: VimRange;
	/** The match and its groups ($0, $1, ...), for the replace string. */
	readonly groups: readonly string[];
}

/** One replacement `:s` makes (or, `text` undefined, a match 'inccommand' only highlights). */
export interface VimSubstitution {
	readonly range: VimRange;
	readonly text: string | undefined;
}

/** Why a JavaScript regular expression does not compile (as VS Code's find compiles it), or undefined. */
export function regexError(pattern: string): string | undefined {
	try {
		new RegExp(pattern, 'gmu');
		return undefined;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

/**
 * Whether a pattern matches case ('ignorecase', 'smartcase'): with
 * 'smartcase' an uppercase letter in the pattern makes it match case; the
 * letters of escapes (`\W` `\S` `\D` `\B` `\p{Lu}` `\u00e9` ...) and group
 * names do not count.
 */
export function patternMatchCase(pattern: string, ignorecase: boolean, smartcase: boolean): boolean {
	if (!ignorecase) {
		return true;
	}
	if (!smartcase) {
		return false;
	}
	const bare = pattern.replace(/\\[pPk]\{[^}]*\}|\\k<[^>]*>|\(\?<[^>=!][^>]*>|\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|\\c[A-Za-z]|\\./g, '');
	return /\p{Lu}/u.test(bare);
}

/**
 * What `:s` replaces in lines `lines.start`..`lines.end`: VS Code's matches
 * of `query` there (the first that starts on each line, without `global`),
 * each with its replace string; at most `limit`.
 */
export function substitutions(host: Pick<IVimHost, 'findMatches' | 'replaceString' | 'lineText'>, query: VimSearchQuery, replacement: string | undefined, lines: { start: number; end: number }, global: boolean, limit = Number.MAX_SAFE_INTEGER): VimSubstitution[] {
	const within = { start: pos(lines.start, 0), end: pos(lines.end, host.lineText(lines.end).length) };
	const out: VimSubstitution[] = [];
	let lastLine = -1;
	for (const m of host.findMatches(query, within, global ? limit : Number.MAX_SAFE_INTEGER)) {
		if (!global && m.range.start.line === lastLine) {
			continue;
		}
		lastLine = m.range.start.line;
		out.push({ range: m.range, text: replacement === undefined ? undefined : host.replaceString(replacement, m) });
		if (out.length >= limit) {
			break;
		}
	}
	return out;
}

/** The options `:set` knows, with Neovim's defaults. */
export interface VimOptions {
	ignorecase: boolean;
	smartcase: boolean;
	hlsearch: boolean;
	incsearch: boolean;
	wrapscan: boolean;
	startofline: boolean;
	joinspaces: boolean;
	tildeop: boolean;
	gdefault: boolean;
	textwidth: number;
	nrformats: string;
	report: number;
}

export const DEFAULT_VIM_OPTIONS: Readonly<VimOptions> = {
	ignorecase: false, smartcase: false, hlsearch: true, incsearch: true, wrapscan: true, startofline: false,
	joinspaces: false, tildeop: false, gdefault: false, textwidth: 0, nrformats: 'bin,hex', report: 2,
};

export const OPTION_ALIASES: Readonly<Record<string, keyof VimOptions>> = {
	ic: 'ignorecase', scs: 'smartcase', hls: 'hlsearch', is: 'incsearch', ws: 'wrapscan', sol: 'startofline',
	js: 'joinspaces', top: 'tildeop', gd: 'gdefault', tw: 'textwidth', nf: 'nrformats',
};

/** State Vim keeps per window rather than per buffer: registers, macros, last search, last f/t, options, ex commands. */
export class VimSharedState {
	readonly registers = new Map<string, VimRegister>();
	readonly macros = new Map<string, readonly VimStep[]>();
	lastMacro: string | undefined;
	lastRecorded: string | undefined;
	/** `wholeWord` and `exactCase` (no 'smartcase'): what `*` / `#` / `gd` searched for. */
	lastSearch: { pattern: string; backwards: boolean; offset?: string; wholeWord?: boolean; exactCase?: boolean } | undefined;
	lastFind: { key: string; char: string } | undefined;
	lastSubstitute: { pattern: string; replacement: string; flags: string } | undefined;
	lastInserted = '';
	lastEx = '';
	readonly history: { ':': string[]; '/': string[] } = { ':': [], '/': [] };
	options: VimOptions = { ...DEFAULT_VIM_OPTIONS };
	/** `devhub.vim.inccommand`: 'nosplit' previews `:s` in the editor as it is typed, '' does not. */
	inccommand = 'nosplit';
	/** Every ex command: Vim's and `devhub.vim.exCommands` (common/vimEx.ts). */
	registry: ExRegistry = new ExRegistry();

	/** The `devhub.vim.exCommands` setting (the user's and machine's values only: the workbench never passes a workspace's). */
	setUserExCommands(raw: unknown): void {
		this.registry = new ExRegistry(raw);
	}

	/** The `devhub.vim.options` setting: Neovim's defaults, then these. */
	setOptions(raw: unknown): void {
		this.options = { ...DEFAULT_VIM_OPTIONS };
		if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
			for (const [k, v] of Object.entries(raw)) {
				const name = (OPTION_ALIASES[k] ?? k) as keyof VimOptions;
				if (name in DEFAULT_VIM_OPTIONS && typeof v === typeof DEFAULT_VIM_OPTIONS[name]) {
					(this.options as unknown as Record<string, unknown>)[name] = v;
				}
			}
		}
	}

	/** Every ex command name with what it runs, for the prompt's completion: Vim's (`:sp[lit]`) and `devhub.vim.exCommands`. */
	exCommandList(): VimExCommandInfo[] {
		return this.registry.list();
	}

	/** The options `:set` knows, with their short names and current values. */
	optionList(): VimOptionInfo[] {
		const aliases = new Map<string, string>(Object.entries(OPTION_ALIASES).map(([short, long]) => [long, short]));
		return (Object.keys(DEFAULT_VIM_OPTIONS) as (keyof VimOptions)[]).map(name => {
			const value = this.options[name];
			const alias = aliases.get(name);
			const boolean = typeof value === 'boolean';
			return { name, ...(alias ? { alias } : {}), boolean, detail: boolean ? (value ? 'on' : 'off') : `=${value}` };
		});
	}
}

/** Each prompt the engines open gets its own number, so the workbench shows each one once. */
let cmdlineSequence = 0;

/** Every command the engine executes; the workbench registers each one. */
export const VIM_ENGINE_COMMANDS = [
	'devhubVim.motion',
	'devhubVim.operator',
	'devhubVim.textObjectPrefix',
	'devhubVim.textObject',
	'devhubVim.forceMotion',
	'devhubVim.count',
	'devhubVim.register',
	'devhubVim.awaitChar',
	'devhubVim.mode',
	'devhubVim.action',
	'devhubVim.mark',
	'devhubVim.scroll',
	'devhubVim.insert',
	'devhubVim.run',
	'devhubVim.repeat',
	'devhubVim.cmdline',
	'devhubVim.search',
	'devhubVim.ex',
	'devhubVim.insertText',
	'devhubVim.escape',
	/** The answer to `:s///c` (y n a q l); the engine waits for it itself. */
	'devhubVim.substituteConfirm',
] as const;

export type VimEngineCommand = typeof VIM_ENGINE_COMMANDS[number];

/** A region an operator works on; `end` is exclusive. */
interface Range {
	start: VimPos;
	end: VimPos;
	linewise: boolean;
	/** Blockwise: screen columns [left, right] inclusive on lines start..end; `toEol` for `$`. */
	block?: { left: number; right: number; toEol: boolean };
	/** The delete goes to register 1 even within a line (% ( ) ` / ? n N { }). */
	bigMotion?: boolean;
}

interface MotionResult {
	pos: VimPos;
	linewise?: boolean;
	inclusive?: boolean;
	/** j/k-style motions keep the remembered column. */
	vertical?: boolean;
	/** Moves to the end of the line and keeps going there on j/k ($). */
	toEol?: boolean;
	/** A jump: the `'` mark remembers where it came from, and VS Code's history records it as a jump. */
	jump?: boolean;
	/** For registers: % ( ) ` / ? n N { } always write register 1. */
	bigMotion?: boolean;
}

interface VisualDims {
	mode: 'visual' | 'visualLine' | 'visualBlock';
	lines: number;
	/** visual: chars on a single line or the last line's column; block: screen columns. */
	cols: number;
	toEol: boolean;
}

interface LastChange {
	register: string | undefined;
	count: number | undefined;
	steps: VimStep[];
	insertText?: string;
	/** Characters deleted before the start of the insert (backspacing over it, CTRL-W). */
	insertBackspaced?: number;
	visual?: VisualDims;
}

interface InsertSession {
	start: VimPos;
	count: number;
	change: LastChange | undefined;
	backspaced: number;
	/** How a count repeats the text: on the same line, or as new lines (o / O). */
	repeat: 'inline' | 'lineBelow' | 'lineAbove';
	/** Visual-block I / A / c: what is typed on the first line goes on these lines too, at these screen columns. */
	block?: { lines: number[]; vcol: number; toEol: boolean; append: boolean };
	/** Replace mode: the original start line, so <BS> can put characters back. */
	original?: { line: number; text: string };
}

type Args = Readonly<Record<string, unknown>>;

/** Operator names (the command argument) and Vim's key for them (used for status and dot). */
const OPERATORS: Record<string, string> = {
	delete: 'd', change: 'c', yank: 'y', indent: '>', outdent: '<', lowercase: 'gu', uppercase: 'gU', toggleCase: 'g~',
	rot13: 'g?', reindent: '=', format: 'gq', formatKeep: 'gw', comment: 'gc', fold: 'zf',
};
const OPERATOR_NAMES: Record<string, string> = Object.fromEntries(Object.entries(OPERATORS).map(([k, v]) => [v, k]));

/** Text object names and the character Vim uses for them after `i` / `a`. */
const TEXT_OBJECTS: Record<string, string> = {
	word: 'w', WORD: 'W', sentence: 's', paragraph: 'p', doubleQuote: '"', singleQuote: '\'', backtick: '`',
	paren: '(', brace: '{', bracket: '[', angle: '<', tag: 't', comment: 'gc', searchMatch: 'gn', searchMatchBackward: 'gN',
	syntaxNode: 'n',
};

/** f/t motions by name, as Vim's key (`;` and `,` repeat by key). */
const FIND_MOTIONS: Record<string, string> = { findForward: 'f', tillForward: 't', findBackward: 'F', tillBackward: 'T' };

/** What `status()` shows while a command waits for its character. */
const AWAIT_LABELS: Record<string, string> = {
	findForward: 'f', tillForward: 't', findBackward: 'F', tillBackward: 'T', mark: '`', markLine: '\'',
	replaceChar: 'r', recordMacro: 'q', playMacro: '@', 'devhubVim.register': '"', 'devhubVim.mark': 'm', insertRegister: '^R',
	'devhubVim.substituteConfirm': '',
};

/** Commands still meaningful in insert mode (all others are ignored there). */
const INSERT_COMMANDS = new Set<string>(['devhubVim.escape', 'devhubVim.insertText', 'devhubVim.ex', 'devhubVim.mode', 'devhubVim.insert', 'devhubVim.awaitChar', 'devhubVim.run', 'devhubVim.repeat']);
/** Commands whose args get the Vim state placeholders (`${count}` ...) expanded when a key runs them (expandVimState). */
const EXPANDING_COMMANDS = new Set<string>(['devhubVim.run', 'devhubVim.repeat']);
/** 'inccommand' previews at most this many replacements, on the lines on screen and this many around them. */
const INCCOMMAND_LIMIT = 1000;
const INCCOMMAND_MARGIN = 50;
/** Ex commands whose argument is passed as typed (blanks at its end are keys, or part of a shell command). */
const RAW_ARG_COMMANDS: ReadonlySet<string> = new Set(['normal']);
/** The most iterations a `devhubVim.repeat` runs. */
const MAX_REPEAT = 1000;
/** Not recorded into a macro: what they lead to is (the command an awaited char completes, the ex line, the search). */
const NOT_IN_MACROS = new Set<string>(['devhubVim.awaitChar', 'devhubVim.cmdline']);
const MACRO_CONTROL = new Set<string>(['recordMacro', 'stopMacro']);
/** Not part of what `.` replays: the count and register are kept apart (a new count replaces the old one), the others lead to the command that is. */
const NOT_IN_CHANGES = new Set<string>(['devhubVim.count', 'devhubVim.register', 'devhubVim.awaitChar', 'devhubVim.cmdline']);
/** Motions after which `%`-style deletes always go to register 1 (`:help quote1`). */
const BIG_MOTIONS = new Set(['matchBracket', 'sentenceForward', 'sentenceBackward', 'mark', 'searchNext', 'searchPrevious', 'paragraphForward', 'paragraphBackward']);

const BRACKETS: Record<string, [string, string]> = {
	'(': ['(', ')'], ')': ['(', ')'], 'b': ['(', ')'],
	'{': ['{', '}'], '}': ['{', '}'], 'B': ['{', '}'],
	'[': ['[', ']'], ']': ['[', ']'],
	'<': ['<', '>'], '>': ['<', '>'],
};
const QUOTES = new Set(['"', '\'', '`']);
/** Marks the user may set with `m` (and `` ` `` `'` `[` `]` `<` `>` with :k / m too). */
const SETTABLE_MARK = /^[a-zA-Z'`[\]<>]$/;

function cmp(a: VimPos, b: VimPos): number {
	return a.line - b.line || a.col - b.col;
}

function pos(line: number, col: number): VimPos {
	return { line, col };
}

/**
 * Substitute `${name}` placeholders in an args tree: a string that is exactly
 * one placeholder becomes the value (a number stays a number, null stays
 * null); a placeholder inside a longer string becomes text (null: empty).
 * Unknown names are left as they are. With `loop` (a repeat's `${it}`), a
 * nested `devhubVim.repeat` keeps its own inner `args`: only the innermost
 * loop's `${it}` is visible there.
 */
export function substitutePlaceholders(value: unknown, vars: Readonly<Record<string, string | number | null>>, loop = false): unknown {
	if (typeof value === 'string') {
		const whole = /^\$\{(\w+)\}$/.exec(value);
		if (whole && Object.prototype.hasOwnProperty.call(vars, whole[1])) {
			return vars[whole[1]];
		}
		return value.replace(/\$\{(\w+)\}/g, (m, name: string) => Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? '') : m);
	}
	if (Array.isArray(value)) {
		return value.map(v => substitutePlaceholders(v, vars, loop));
	}
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = loop && k === 'args' && value.command === 'devhubVim.repeat' && isRecord(v) ? substituteRepeatSpec(v, vars) : substitutePlaceholders(v, vars, loop);
		}
		return out;
	}
	return value;
}

/** A `devhubVim.repeat`'s own args under an outer loop: its `count` (and command) take the outer `${it}`, its inner `args` do not. */
export function substituteRepeatSpec(spec: Readonly<Record<string, unknown>>, vars: Readonly<Record<string, string | number | null>>): Readonly<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(spec)) {
		out[k] = k === 'args' ? v : substitutePlaceholders(v, vars, true);
	}
	return out;
}

function isRecord(v: unknown): v is Args {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

/** A single character argument (the first code point of what was typed). */
function charArg(v: unknown): string | undefined {
	if (typeof v !== 'string' || !v) {
		return undefined;
	}
	return Array.from(v)[0];
}

class VimInvalid extends Error { }

export class VimEngine {

	private _mode: VimMode = 'normal';
	private desiredCol = 0;
	private visualAnchor: VimPos = pos(0, 0);
	private visualHead: VimPos = pos(0, 0);
	/** Visual block made with `$`: every line to its end. */
	private visualToEol = false;
	private lastVisual: { mode: 'visual' | 'visualLine' | 'visualBlock'; anchor: VimPos; head: VimPos; toEol: boolean } | undefined;
	/** The open prompt: its kind, its text (what it starts with; then what the line holds, for 'incsearch'), where the search starts. */
	private cmdline: { kind: VimCmdlineKind; text: string; origin: VimPos; id: number } | undefined;
	/** The prompt fed keys type into (`:normal :s/a/b<CR>`, `@a`); the workbench's line otherwise. */
	private fedPrompt: VimCmdlineController | undefined;
	private lastCursor: VimPos | undefined;
	private message = '';
	private changeOpen = false;
	/** Nested commands (:g, :normal, a macro run by :g) share one undo step. */
	private changeBatch = 0;
	private insert: InsertSession | undefined;
	/** CTRL-O: one normal-mode command, then back to insert mode here. */
	private insertOnce: { eol: boolean; armed: boolean } | undefined;
	private lastChange: LastChange | undefined;
	private replaying = false;
	/** > 0 while `devhubVim.run` / `devhubVim.repeat` run their own steps: those are neither expanded nor recorded again. */
	private nestedDepth = 0;
	private readonly marks = new Map<string, VimPos>();
	/** The next cursor or selection the engine puts is a jump (VS Code's history records it as Go to Definition's). */
	private jumping = false;
	private hlActive = false;

	// grammar: what the commands so far have built up
	private register: string | undefined;
	private count: number | undefined;
	private opCount: number | undefined;
	private operator: string | undefined;
	private textObjectKind: 'inner' | 'around' | undefined;
	private forced: 'char' | 'line' | 'block' | undefined;
	private awaiting: { command: string; args: Args } | undefined;
	/** The commands of the command being built, for `.`. */
	private steps: VimStep[] = [];

	private recordingMacro: { name: string; steps: VimStep[] } | undefined;
	private playingMacro = 0;

	constructor(private readonly host: IVimHost, private readonly shared: VimSharedState = new VimSharedState()) { }

	get mode(): VimMode {
		return this._mode;
	}

	/** In a visual mode, the character the cursor is on (the head: `o` swaps it with the other end); undefined otherwise. */
	visualCursor(): VimPos | undefined {
		return this.isVisual() ? this.visualHead : undefined;
	}

	/** True while a command is half built, or the `:`/`/` prompt is open. */
	get pending(): boolean {
		return this.grammarPending() || this.cmdline !== undefined;
	}

	/** The next key or IME commit is a character argument. */
	get awaitingChar(): boolean {
		return this.awaiting !== undefined;
	}

	get cmdlineOpen(): boolean {
		return this.cmdline !== undefined;
	}

	/** The open `:` `/` `?` prompt, for the workbench's prompt line: its kind, the text it starts with, its number. */
	get cmdlineState(): { readonly kind: VimCmdlineKind; readonly text: string; readonly id: number } | undefined {
		const c = this.cmdline;
		return c && { kind: c.kind, text: c.text, id: c.id };
	}

	/** What the prompt line talks to (VimCmdlineController). */
	cmdlineTarget(): IVimCmdlineTarget {
		return {
			history: kind => this.shared.history[kind === ':' ? ':' : '/'],
			changed: text => this.cmdlineChanged(text),
			submit: text => this.cmdlineSubmit(text),
			cancel: () => this.cmdlineCancel(),
			registerText: name => this.registerText(name),
			prepareRegisters: () => this.host.prefetchClipboard(),
		};
	}

	/** The candidates the engine knows for the prompt's completion (ex commands, options; no open editors). */
	cmdlineSources(): IVimCmdlineCompletionSources {
		return { exCommands: () => this.shared.exCommandList(), options: () => [...this.shared.optionList(), ...this.bufferOptionList()], buffers: () => [], registry: () => this.shared.registry };
	}

	/** The prompt's line changed: 'incsearch' shows where the pattern typed so far matches. */
	cmdlineChanged(text: string): void {
		if (!this.cmdline) {
			return;
		}
		this.cmdline.text = text;
		try {
			this.updateIncSearch();
		} catch (err) {
			this.recover(err);
		}
	}

	/** Enter in the prompt: the line runs as `devhubVim.ex` / `devhubVim.search`, with the operator, count and register that waited for it. */
	cmdlineSubmit(text: string): void {
		const cl = this.cmdline;
		if (!cl) {
			return;
		}
		this.closeCmdline(true);
		if (cl.kind === ':') {
			this.pushHistory(':', text.trim());
			this.execute('devhubVim.ex', { command: text.trim() });
		} else {
			this.execute('devhubVim.search', { pattern: text, backwards: cl.kind === '?' });
		}
	}

	/** Esc in the prompt (or <BS> on an empty line): abandoned, and the command waiting for it with it. */
	cmdlineCancel(): void {
		if (this.cmdline) {
			this.escape();
		}
	}

	/** A register's text, for CTRL-R in the prompt. */
	registerText(name: string): string | undefined {
		try {
			return this.readRegister(name)?.text;
		} catch {
			return undefined;
		}
	}

	get options(): VimOptions {
		return this.shared.options;
	}

	private grammarPending(): boolean {
		return this.register !== undefined || this.count !== undefined || this.opCount !== undefined || this.operator !== undefined
			|| this.textObjectKind !== undefined || this.awaiting !== undefined || this.forced !== undefined;
	}

	private isInsert(): boolean {
		return this._mode === 'insert' || this._mode === 'replace';
	}

	context(): VimContext {
		const visual = this.isVisual();
		const mode: VimContextMode = this.cmdline ? 'cmdline'
			: this.isInsert() ? this._mode
				: visual ? this._mode
					: this.operator ? 'operatorPending' : 'normal';
		return {
			mode,
			acceptsMotion: mode !== 'cmdline' && mode !== 'insert' && mode !== 'replace' && !this.awaiting && !this.textObjectKind,
			hasCount: this.count !== undefined,
			pending: this.grammarPending(),
			pendingOperator: this.operator ? OPERATOR_NAMES[this.operator] : '',
			textObjectPending: this.textObjectKind ?? '',
			awaitingChar: this.awaitingChar,
			recording: this.recordingMacro !== undefined,
			visual,
			insert: this.isInsert(),
		};
	}

	status(): string {
		if (this.cmdline) {
			// the prompt line shows the text; here only what waits for it (`d` of `d/foo`), as Vim's 'showcmd'
			return this.pendingText();
		}
		const name = this._mode === 'insert' ? '-- INSERT --'
			: this._mode === 'replace' ? '-- REPLACE --'
				: this._mode === 'visual' ? (this.insertOnce ? '-- (insert) VISUAL --' : '-- VISUAL --')
					: this._mode === 'visualLine' ? '-- VISUAL LINE --'
						: this._mode === 'visualBlock' ? '-- VISUAL BLOCK --'
							: this.insertOnce ? '-- (insert) --' : 'NORMAL';
		const parts = [name];
		const extra = this.message || this.pendingText();
		if (extra) {
			parts.push(extra);
		}
		if (this.recordingMacro) {
			parts.push(`recording @${this.recordingMacro.name}`);
		}
		return parts.join('  ');
	}

	/** The command built so far, the way Vim shows typed keys (`"a2d`, `di`, `f`). */
	private pendingText(): string {
		let s = '';
		if (this.register !== undefined) {
			s += '"' + this.register;
		}
		if (this.opCount !== undefined) {
			s += this.opCount;
		}
		if (this.operator) {
			s += this.operator;
		}
		if (this.forced) {
			s += this.forced === 'char' ? 'v' : this.forced === 'line' ? 'V' : '^V';
		}
		if (this.count !== undefined) {
			s += this.count;
		}
		if (this.textObjectKind) {
			s += this.textObjectKind === 'inner' ? 'i' : 'a';
		}
		if (this.awaiting) {
			const a = this.awaiting;
			s += AWAIT_LABELS[str(a.args.motion)] ?? AWAIT_LABELS[str(a.args.action)] ?? AWAIT_LABELS[a.command] ?? '…';
		}
		return s;
	}

	// ---- entry points -------------------------------------------------------

	/**
	 * Run one engine command. Returns false when `command` is not the engine's
	 * (the caller runs it as an ordinary command). Never throws: a failing
	 * command ends in plain normal mode (`recover`), an invalid one (an action
	 * where it means nothing, a motion that cannot complete an operator) just
	 * cancels the command being built, as an invalid key does in Vim.
	 */
	execute(command: string, args?: unknown): boolean {
		const handler = this.handlers[command as VimEngineCommand];
		if (!handler) {
			return false;
		}
		let a: Args = isRecord(args) ? args : {};
		if (this.isInsert() && !INSERT_COMMANDS.has(command)) {
			return true;
		}
		const nested = this.nestedDepth > 0;
		if (!nested && EXPANDING_COMMANDS.has(command)) {
			// the entry point: the Vim state goes into the args once, and what is recorded is the result
			a = this.expandVimState(a, typeof a.char === 'string' ? a.char : undefined);
		}
		try {
			this.message = '';
			this.steps.push({ command, args: a });
			handler(a);
			if (!nested && this.recordingMacro && !this.playingMacro && !this.replaying && !NOT_IN_MACROS.has(command) && !(command === 'devhubVim.action' && MACRO_CONTROL.has(str(a.action)))) {
				this.recordingMacro.steps.push({ command, args: a });
			}
		} catch (err) {
			if (err instanceof VimInvalid) {
				this.resetGrammar();
				if (err.message) {
					this.message = err.message;
				}
			} else {
				this.recover(err);
			}
		}
		// a jump that put no cursor (an error after it) does not make the next move one
		this.jumping = false;
		this.resumeInsertOnce();
		return true;
	}

	/** After CTRL-O's one command (complete, not a prompt or visual mode), back to insert mode. */
	private resumeInsertOnce(): void {
		const once = this.insertOnce;
		if (once && !once.armed) {
			// the CTRL-O itself: the command comes next
			once.armed = true;
			return;
		}
		if (!once || this._mode !== 'normal' || this.grammarPending() || this.cmdline) {
			if (once && this.isInsert()) {
				this.insertOnce = undefined;
			}
			return;
		}
		this.insertOnce = undefined;
		let c = this.host.getCursor();
		// Vim: back after the last character when the caret was there before CTRL-O
		// and still is on that line, or when the command wants a column further right (`$`, `80|`)
		const onLast = this.len(c.line) > 0 && c.col === this.len(c.line) - 1;
		const wantsRight = this.desiredCol > vcolOf(this.host.lineText(c.line), c.col, this.host.tabSize());
		if (onLast && ((once.eol && this.lastOnceCursor && c.line === this.lastOnceCursor.line) || wantsRight)) {
			c = pos(c.line, this.len(c.line));
		}
		this.openChange();
		this.enterInsert(c, 1, undefined, 'inline');
	}

	private lastOnceCursor: VimPos | undefined;

	/**
	 * A key typed while a command waits for its character (`awaitingChar`).
	 * Keys are single characters or `<Esc>`, `<CR>`, `<BS>`, `<Tab>`, `<C-x>`, `<Other>`:
	 * a character completes the command, anything else cancels it.
	 */
	awaitKey(key: string): void {
		if (!this.awaiting) {
			return;
		}
		if (Array.from(key).length === 1) {
			this.handleChar(key);
		} else if ((key === '<CR>' || key === '<C-m>') && this.awaiting.args.action === 'replaceChar') {
			// r<CR>: a line break
			this.handleChar('\r');
		} else if (this.confirm) {
			// :s///c: Esc and other keys quit
			this.awaiting = undefined;
			this.finishConfirm();
		} else if (key === '<Esc>' || key === '<C-[>' || key === '<C-c>') {
			if (this.isInsert()) {
				this.awaiting = undefined;
			} else {
				this.escape();
			}
		} else if (key === '<Tab>' && this.awaiting.command !== 'devhubVim.register') {
			this.handleChar('\t');
		} else {
			this.awaiting = undefined;
			if (!this.isInsert()) {
				this.resetGrammar();
			}
		}
		this.resumeInsertOnce();
	}

	/** The character a waiting command (`devhubVim.awaitChar`) gets. Returns whether one waited. */
	handleChar(ch: string): boolean {
		const then = this.awaiting;
		if (!then) {
			return false;
		}
		this.awaiting = undefined;
		const args = { ...then.args, char: ch };
		if (!this.execute(then.command, args)) {
			// a VS Code command: it gets the Vim state placeholders too (`${char}`, `${count}` ...)
			const expanded = this.expandVimState(args, ch);
			this.resetGrammar();
			this.runSteps([{ command: then.command, args: expanded }]);
		}
		return true;
	}

	/**
	 * The Vim state a key's command sees, put into its args: `${count}` (the
	 * count, or 1), `${rawCount}` (the count, or null), `${register}` (the
	 * register named with `"x`, or `"`), `${char}` (the character an
	 * `awaitChar` got, or empty). Done once, where a key (or a replay) runs
	 * `devhubVim.run` / `devhubVim.repeat`; the command then consumes the
	 * count and register. `${it}` / `${index}` are left for `devhubVim.repeat`.
	 */
	private expandVimState(a: Args, ch: string | undefined): Args {
		const count = this.effectiveCount();
		const vars = { count: count ?? 1, rawCount: count ?? null, register: this.register ?? '"', char: ch ?? '' };
		const out = substitutePlaceholders(a, vars);
		return isRecord(out) ? out : a;
	}

	/**
	 * Text an input method committed outside insert mode (it never reached the
	 * buffer). As in Vim, it is what a command waiting for a character gets:
	 * f t F T r take its first character (the `:` `/` `?` prompt is an editor
	 * of its own, where an IME commits as anywhere else). Otherwise it is
	 * dropped, never run as commands. Returns whether it was used.
	 */
	handleText(text: string): boolean {
		if (this.isInsert() || !text || this.cmdline) {
			return false;
		}
		if (!this.awaiting) {
			return false;
		}
		return this.handleChar(Array.from(text)[0]);
	}

	/** Forget the command being built (a key that means nothing here was typed). */
	cancelPending(): void {
		this.resetGrammar();
	}

	/**
	 * Whatever a command threw half way, the engine ends in plain normal mode:
	 * no pending command, no prompt, no open change, no visual selection on screen.
	 * The message says what went wrong.
	 */
	recover(err: unknown): void {
		this.reset();
		this.message = String(err instanceof Error ? err.message : err);
		try {
			this.setNormalCursor(this.host.getCursor());
		} catch {
			// the host itself is broken; the state above is still sane
		}
	}

	/**
	 * Esc: cancel one thing (insert, the prompt, the pending command, visual
	 * mode), as Vim does. In normal mode with nothing pending it does nothing,
	 * so Esc pressed any number of times always ends in plain normal mode and
	 * nowhere else; the workbench never takes it as a way out of the text.
	 */
	escape(): void {
		this.execute('devhubVim.escape');
	}

	private doEscape(interrupt: boolean): void {
		if (this.isInsert()) {
			this.awaiting = undefined;
			this.exitInsert(interrupt);
			this.resetGrammar();
			return;
		}
		if (this.cmdline) {
			this.closeCmdline();
			this.resetGrammar();
			return;
		}
		this.insertOnce = undefined;
		if (this.confirm) {
			this.finishConfirm();
			this.resetGrammar();
			return;
		}
		if (this.grammarPending()) {
			this.resetGrammar();
			return;
		}
		this.resetGrammar();
		if (this.isVisual()) {
			this.leaveVisual(this.visualHead);
			return;
		}
		this.message = '';
	}

	/** Called by the host when the user made a selection with the mouse. */
	selectionChanged(anchor: VimPos, active: VimPos): void {
		if (this.isInsert()) {
			return;
		}
		if (cmp(anchor, active) === 0) {
			if (this._mode !== 'normal') {
				this.leaveVisual(active);
			}
			return;
		}
		this.resetGrammar();
		this._mode = 'visual';
		this.visualAnchor = anchor;
		this.visualToEol = false;
		// The editor's selection end is exclusive; Vim's head is the last char.
		this.visualHead = cmp(active, anchor) > 0 ? this.prevChar(active) ?? active : active;
		this.renderVisual();
	}

	/** Put the engine back in normal mode without touching the document. */
	reset(): void {
		try {
			this.changeBatch = 0;
			this.closeChange();
		} catch {
			// closeChange marked the change closed before the host threw
		}
		if (this.isVisual()) {
			this.saveVisual();
		}
		this._mode = 'normal';
		this.cmdline = undefined;
		this.fedPrompt = undefined;
		this.insert = undefined;
		this.insertOnce = undefined;
		this.confirm = undefined;
		this.resetGrammar();
	}

	private resetGrammar(): void {
		this.register = undefined;
		this.count = undefined;
		this.opCount = undefined;
		this.operator = undefined;
		this.textObjectKind = undefined;
		this.forced = undefined;
		this.awaiting = undefined;
		this.steps = [];
	}

	/** The count that applies to the command being completed: `2d3w` is 6. */
	private effectiveCount(): number | undefined {
		return this.opCount === undefined && this.count === undefined ? undefined : (this.opCount ?? 1) * (this.count ?? 1);
	}

	/** The command built so far, as `.` will replay it. */
	private snapshot(): LastChange {
		return {
			register: this.register,
			count: this.effectiveCount(),
			steps: this.steps.filter(s => !NOT_IN_CHANGES.has(s.command)),
		};
	}

	/** The command is complete; `change` records it for `.`. */
	private complete(change: LastChange | undefined): void {
		if (change) {
			this.recordChange(change);
		}
		this.resetGrammar();
	}

	private invalid(message = ''): never {
		throw new VimInvalid(message);
	}

	private isVisual(): boolean {
		return this._mode === 'visual' || this._mode === 'visualLine' || this._mode === 'visualBlock';
	}

	// ---- buffer helpers -----------------------------------------------------

	private lastLine(): number {
		return this.host.lineCount() - 1;
	}

	private len(line: number): number {
		return this.host.lineText(line).length;
	}

	private charAt(p: VimPos): string {
		const text = this.host.lineText(p.line);
		return p.col < text.length ? text[p.col] : '\n';
	}

	/** The word class of the character at `p` (vimText.ts charClassAt; 0 past the end of the line). */
	private classAt(p: VimPos, big: boolean): number {
		return charClassAt(this.host.lineText(p.line), p.col, big);
	}

	private nextChar(p: VimPos): VimPos | undefined {
		if (p.col < this.len(p.line)) {
			return pos(p.line, p.col + 1);
		}
		return p.line < this.lastLine() ? pos(p.line + 1, 0) : undefined;
	}

	private prevChar(p: VimPos): VimPos | undefined {
		if (p.col > 0) {
			return pos(p.line, p.col - 1);
		}
		return p.line > 0 ? pos(p.line - 1, this.len(p.line - 1)) : undefined;
	}

	private firstNonBlank(line: number): number {
		const m = /\S/.exec(this.host.lineText(line));
		return m ? m.index : this.len(line);
	}

	private indentOf(line: number): string {
		return /^\s*/.exec(this.host.lineText(line))![0];
	}

	private clampNormal(p: VimPos): VimPos {
		const line = Math.max(0, Math.min(p.line, this.lastLine()));
		const max = Math.max(0, this.len(line) - 1);
		return pos(line, Math.max(0, Math.min(p.col, max)));
	}

	private clampLine(line: number): number {
		return Math.max(0, Math.min(line, this.lastLine()));
	}

	private getText(start: VimPos, end: VimPos): string {
		if (start.line === end.line) {
			return this.host.lineText(start.line).slice(start.col, end.col);
		}
		const parts = [this.host.lineText(start.line).slice(start.col)];
		for (let l = start.line + 1; l < end.line; l++) {
			parts.push(this.host.lineText(l));
		}
		parts.push(this.host.lineText(end.line).slice(0, end.col));
		return parts.join('\n');
	}

	private linesText(from: number, to: number): string {
		const parts: string[] = [];
		for (let l = from; l <= to; l++) {
			parts.push(this.host.lineText(l));
		}
		return parts.join('\n');
	}

	private cursor(): VimPos {
		if (this.isVisual()) {
			return this.visualHead;
		}
		const c = this.clampNormal(this.host.getCursor());
		if (!this.lastCursor || cmp(c, this.lastCursor) !== 0) {
			// Moved by something other than Vim (mouse, another command).
			this.desiredCol = vcolOf(this.host.lineText(c.line), c.col, this.host.tabSize());
			this.lastCursor = c;
		}
		return c;
	}

	/** Put the normal-mode caret at `p`; unless `keepDesired`, the column j/k come back to is its screen column. */
	private setNormalCursor(p: VimPos, keepDesired = false): void {
		const c = this.clampNormal(p);
		this.host.setCursor(c, this.takeJump());
		this.lastCursor = c;
		if (!keepDesired) {
			this.desiredCol = vcolOf(this.host.lineText(c.line), c.col, this.host.tabSize());
		}
	}

	/** The column on `line` closest to the remembered screen column (what j/k and 'nostartofline' keep). */
	private colForDesired(line: number): number {
		const text = this.host.lineText(line);
		if (this.desiredCol === Number.MAX_SAFE_INTEGER) {
			return Math.max(0, text.length - 1);
		}
		const { col } = colOfVcol(text, this.desiredCol, this.host.tabSize());
		return Math.min(col, Math.max(0, text.length - 1));
	}

	/** Where a linewise jump (G, gg, H, :{n}, CTRL-D) lands: 'startofline' or the remembered column. */
	private lineTarget(line: number): VimPos {
		return this.options.startofline ? pos(line, this.firstNonBlank(line)) : pos(line, this.colForDesired(line));
	}

	// ---- changes, undo grouping, marks -------------------------------------

	private openChange(): void {
		if (!this.changeOpen) {
			this.changeOpen = true;
			this.host.beginChange();
		}
	}

	private closeChange(): void {
		if (this.changeOpen && this.changeBatch === 0) {
			this.changeOpen = false;
			this.host.endChange();
		}
	}

	private edit(edits: VimEdit[]): void {
		if (edits.length) {
			this.openChange();
			this.host.applyEdits(edits);
			const first = edits.reduce((a, e) => cmp(e.start, a.start) < 0 ? e : a, edits[0]);
			this.setMark('.', first.start);
		}
	}

	private recordChange(change: LastChange): void {
		if (!this.replaying) {
			this.lastChange = change;
		}
	}

	/**
	 * The document changed (any edit: the engine's, typing, another command),
	 * in pre-edit coordinates. Marks and an insert in progress
	 * follow the text as Vim's do (a deleted line takes its marks with it).
	 */
	contentChanged(changes: readonly VimEdit[]): void {
		const sorted = changes.slice().sort((a, b) => cmp(b.start, a.start));
		for (const c of sorted) {
			const added = c.text.split('\n').length - 1;
			const removed = c.end.line - c.start.line;
			const delta = added - removed;
			const wholeLines = c.start.col === 0 && c.end.col === 0 && removed > 0 && (c.text === '' || c.text.endsWith('\n'));
			const lastAddedLen = c.text.length - (c.text.lastIndexOf('\n') + 1);
			const move = (p: VimPos): VimPos | undefined => {
				if (p.line < c.start.line || (p.line === c.start.line && p.col < c.start.col && !wholeLines)) {
					return p;
				}
				if (p.line > c.end.line) {
					return delta ? pos(p.line + delta, p.col) : p;
				}
				if (wholeLines) {
					return p.line < c.end.line ? undefined : pos(p.line + delta, p.col);
				}
				if (p.line === c.end.line && p.col >= c.end.col && cmp(p, c.start) > 0) {
					// after the change on its last line: keep the distance to the end
					const col = (added ? lastAddedLen : c.start.col + lastAddedLen) + (p.col - c.end.col);
					return pos(c.start.line + added, col);
				}
				return p.line === c.start.line ? p : pos(Math.min(p.line, c.start.line + added), p.col);
			};
			for (const [k, p] of [...this.marks]) {
				const m = move(p);
				if (m) {
					this.marks.set(k, m);
				} else {
					this.marks.delete(k);
				}
			}
			if (this.lastVisual) {
				this.lastVisual = { ...this.lastVisual, anchor: move(this.lastVisual.anchor) ?? c.start, head: move(this.lastVisual.head) ?? c.start };
			}
			const ins = this.insert;
			if (ins && this.isInsert()) {
				const s = ins.start;
				if (cmp(c.end, s) <= 0) {
					if (c.end.line === s.line && c.start.line === s.line && c.text === '' && c.end.col === s.col) {
						// backspacing over the start of the insert
						ins.backspaced += s.col - c.start.col;
						ins.start = c.start;
					} else {
						ins.start = move(s) ?? c.start;
					}
				} else if (cmp(c.start, s) < 0) {
					if (c.start.line === s.line && c.end.line === s.line) {
						ins.backspaced += s.col - c.start.col;
					}
					ins.start = c.start;
				}
			}
		}
	}

	private setMark(name: string, p: VimPos): void {
		this.marks.set(name, p);
	}

	private getMark(name: string): VimPos | undefined {
		if (name === '`') {
			name = '\'';
		}
		if (name === '<' || name === '>') {
			const v = this.lastVisual;
			if (!v) {
				return undefined;
			}
			const [a, b] = cmp(v.anchor, v.head) <= 0 ? [v.anchor, v.head] : [v.head, v.anchor];
			if (v.mode === 'visualLine') {
				return name === '<' ? pos(a.line, 0) : pos(b.line, Math.max(0, this.len(b.line) - 1));
			}
			if (v.mode === 'visualBlock') {
				const tab = this.host.tabSize();
				const va = vcolOf(this.host.lineText(v.anchor.line), v.anchor.col, tab);
				const vh = vcolOf(this.host.lineText(v.head.line), v.head.col, tab);
				const line = name === '<' ? a.line : b.line;
				return pos(line, colOfVcol(this.host.lineText(line), name === '<' ? Math.min(va, vh) : Math.max(va, vh), tab).col);
			}
			return name === '<' ? a : b;
		}
		const p = this.marks.get(name);
		if (!p) {
			return undefined;
		}
		const line = this.clampLine(p.line);
		return pos(line, Math.min(p.col, Math.max(0, this.len(line))));
	}

	/**
	 * A jump from `from` (G, gg, a search, `%`, a mark, :{n}, H M L ...): the
	 * `'` mark is set, and the cursor or selection the engine puts next tells
	 * the editor it is a jump (TextEditorSelectionSource.JUMP, as Go to
	 * Definition does), so VS Code's history (CTRL-O / CTRL-I, Go Back / Go
	 * Forward) records where it came from and where it went, even a few lines
	 * away. There is no jump list of the engine's own.
	 */
	private jumpFrom(from: VimPos): void {
		this.setMark('\'', from);
		this.jumping = true;
	}

	/** A jump from `from` to `to` in normal mode (none when it stays). */
	private jumpTo(to: VimPos, from: VimPos): void {
		if (cmp(this.clampNormal(to), from) !== 0) {
			this.jumpFrom(from);
		}
		this.setNormalCursor(to);
	}

	private takeJump(): boolean {
		const j = this.jumping;
		this.jumping = false;
		return j;
	}

	// ---- registers ----------------------------------------------------------

	/**
	 * Store yanked or deleted text as Vim does (`:help registers`): the named
	 * register (A-Z appends), "0 for a yank without a register, "1-"9 for a
	 * delete of a line or more (or with a `%`-style motion), "- for a smaller
	 * one without a register; the unnamed register points at what was written.
	 */
	private storeRegister(name: string | undefined, text: string, type: VimRegisterType, kind: 'yank' | 'delete', bigMotion = false): void {
		if (name === '_') {
			return;
		}
		if (name === '"') {
			name = undefined;
		}
		const value: VimRegister = { text, type };
		const regs = this.shared.registers;
		let unnamed = value;
		if (name === '+' || name === '*') {
			this.host.setClipboard(type === 'line' ? text + '\n' : text);
		} else if (name && /^[a-z0-9-]$/.test(name)) {
			regs.set(name, value);
			this.shared.macros.delete(name);
		} else if (name && /^[A-Z]$/.test(name)) {
			const lower = name.toLowerCase();
			const prev = regs.get(lower);
			unnamed = prev ? appendRegister(prev, value) : value;
			regs.set(lower, unnamed);
			this.shared.macros.delete(lower);
		}
		if (kind === 'yank') {
			if (!name) {
				regs.set('0', value);
			}
		} else {
			const multiline = type !== 'char' || text.includes('\n');
			if (multiline || bigMotion) {
				for (let n = 9; n > 1; n--) {
					const prev = regs.get(String(n - 1));
					if (prev) {
						regs.set(String(n), prev);
					}
				}
				regs.set('1', value);
			}
			if (!multiline && !name) {
				regs.set('-', value);
			}
		}
		regs.set('"', unnamed);
	}

	private readRegister(name: string | undefined): VimRegister | undefined {
		if (name === '+' || name === '*') {
			const text = this.host.getClipboard();
			return text.endsWith('\n') ? { text: text.slice(0, -1).replace(/\r$/, ''), type: 'line' } : { text, type: 'char' };
		}
		switch (name) {
			case '.': return { text: this.shared.lastInserted, type: 'char' };
			case ':': return { text: this.shared.lastEx, type: 'char' };
			case '/': return this.shared.lastSearch ? { text: this.shared.lastSearch.pattern, type: 'char' } : undefined;
			case '%': return { text: this.host.fileName(), type: 'char' };
			case '_': return undefined;
		}
		return this.shared.registers.get(name ? name.toLowerCase() : '"');
	}

	// ---- commands -----------------------------------------------------------

	private readonly handlers: Record<VimEngineCommand, (a: Args) => void> = {
		'devhubVim.motion': a => this.cmdMotion(str(a.motion), charArg(a.char)),
		'devhubVim.operator': a => this.cmdOperator(str(a.operator)),
		'devhubVim.textObjectPrefix': a => this.cmdTextObjectPrefix(str(a.kind)),
		'devhubVim.textObject': a => this.cmdTextObject(str(a.object), str(a.kind)),
		'devhubVim.forceMotion': a => this.cmdForceMotion(str(a.type)),
		'devhubVim.count': a => this.cmdCount(a.digit),
		'devhubVim.register': a => this.cmdRegister(charArg(a.name) ?? charArg(a.char)),
		'devhubVim.awaitChar': a => this.cmdAwaitChar(a.then),
		'devhubVim.mode': a => this.cmdMode(str(a.to), str(a.at)),
		'devhubVim.action': a => this.cmdAction(str(a.action), charArg(a.char)),
		'devhubVim.mark': a => this.cmdMark(charArg(a.char) ?? charArg(a.name)),
		'devhubVim.scroll': a => this.cmdScroll(a),
		'devhubVim.insert': a => this.cmdInsert(str(a.action), charArg(a.char)),
		'devhubVim.run': a => this.cmdRun(a),
		'devhubVim.repeat': a => this.cmdRepeat(a),
		'devhubVim.cmdline': a => this.cmdCmdline(str(a.kind)),
		'devhubVim.search': a => this.cmdSearch(str(a.pattern), a.backwards === true),
		'devhubVim.ex': a => {
			this.resetGrammar();
			this.runEx(str(a.command));
		},
		'devhubVim.insertText': a => this.cmdInsertText(str(a.text)),
		'devhubVim.escape': a => this.doEscape(a.interrupt === true),
		'devhubVim.substituteConfirm': a => this.cmdSubstituteConfirm(charArg(a.char)),
	};

	private cmdMotion(name: string, ch: string | undefined): void {
		if (this.textObjectKind) {
			this.invalid();
		}
		if (name === 'halfPageDown' || name === 'halfPageUp') {
			// the old names of CTRL-D / CTRL-U, which scroll
			this.steps.pop();
			this.cmdScroll({ by: 'halfPage', direction: name === 'halfPageDown' ? 'down' : 'up' });
			return;
		}
		const cur = this.cursor();
		const count = this.effectiveCount();
		const op = this.operator;
		if (op) {
			const change = op === 'y' ? undefined : this.snapshot();
			this.operateMotion(op, name, count, ch, cur, change);
			this.completeOperator(op, change);
			return;
		}
		const r = this.motion(name, count, false, cur, ch);
		if (r) {
			this.moveTo(r, cur);
		}
		this.complete(undefined);
	}

	/** The cursor (normal) or the visual head goes where a motion went. */
	private moveTo(r: MotionResult, from: VimPos): void {
		if (r.jump && cmp(r.pos, from) !== 0) {
			this.jumpFrom(from);
		}
		if (this.isVisual()) {
			const target = r.vertical ? pos(r.pos.line, this.colForDesired(r.pos.line)) : r.pos;
			this.visualHead = this.clampVisual(target);
			if (this._mode === 'visualBlock') {
				this.visualToEol = r.toEol === true || (r.vertical === true && this.visualToEol);
			}
			if (!r.vertical) {
				this.desiredCol = r.toEol ? Number.MAX_SAFE_INTEGER : vcolOf(this.host.lineText(this.visualHead.line), this.visualHead.col, this.host.tabSize());
			}
			this.renderVisual();
		} else if (r.vertical) {
			this.setNormalCursor(pos(r.pos.line, this.colForDesired(r.pos.line)), true);
		} else {
			this.setNormalCursor(r.pos, r.linewise === true && !this.options.startofline && r.pos.col === this.colForDesired(r.pos.line));
			if (r.toEol) {
				this.desiredCol = Number.MAX_SAFE_INTEGER;
			}
		}
	}

	/** In visual mode the head may sit on the line break of an empty line only. */
	private clampVisual(p: VimPos): VimPos {
		const line = this.clampLine(p.line);
		const max = Math.max(0, this.len(line) - 1);
		return pos(line, Math.max(0, Math.min(p.col, this._mode === 'visual' ? Math.max(max, p.col === this.len(line) ? this.len(line) : max) : max)));
	}

	/** An operator over a motion: `dw`, and the aliases `x` (`dl`), `D` (`d$`), ... */
	private operateMotion(op: string, name: string, count: number | undefined, ch: string | undefined, cur: VimPos, change: LastChange | undefined): void {
		let range: Range;
		// `cw` on a word behaves like `ce` (Vim's documented exception), and
		// on the last char of a word changes just that char.
		if (op === 'c' && !this.forced && (name === 'wordForward' || name === 'WORDForward') && this.classAt(cur, false) !== 0) {
			const e = this.wordEnd(cur, name === 'WORDForward', count ?? 1, true);
			range = { start: cur, end: pos(e.line, Math.min(e.col + 1, this.len(e.line))), linewise: false };
		} else {
			const m = this.motion(name, count, true, cur, ch);
			if (!m) {
				this.invalid(this.message);
			}
			range = this.motionRange(cur, m);
			if (BIG_MOTIONS.has(name)) {
				range.bigMotion = true;
			}
		}
		this.applyOperator(op, this.register, range, cur, change);
	}

	/** dd, cc, yy, >>, <<, ==, gUU, gcc ...: `count` lines from the cursor's. */
	private operateLines(op: string, count: number | undefined, cur: VimPos, change: LastChange | undefined): void {
		const n = count ?? 1;
		if (cur.line + n - 1 > this.lastLine() && op !== 'y' && op !== '>' && op !== '<' && n > 1 && cur.line === this.lastLine()) {
			this.invalid();
		}
		const endLine = Math.min(this.lastLine(), cur.line + n - 1);
		this.applyOperator(op, this.register, { start: pos(cur.line, 0), end: pos(endLine, this.len(endLine)), linewise: true }, cur, change);
	}

	/** After an operator: record it for `.` unless it is a yank or a change still typing. */
	private completeOperator(op: string, change: LastChange | undefined): void {
		this.complete(op === 'c' || op === 'y' ? undefined : change);
	}

	private cmdOperator(name: string): void {
		const op = OPERATORS[name];
		if (!op || this.textObjectKind) {
			this.invalid(op ? '' : `Unknown operator: ${name}`);
		}
		if (this.isVisual()) {
			const change = op === 'y' ? undefined : this.visualSnapshot();
			this.visualOperator(op, false, change);
			this.completeOperator(op, change);
			return;
		}
		if (this.operator === undefined) {
			this.operator = op;
			this.opCount = this.count;
			this.count = undefined;
			return;
		}
		if (this.operator !== op) {
			this.invalid();
		}
		const change = op === 'y' ? undefined : this.snapshot();
		this.operateLines(op, this.effectiveCount(), this.cursor(), change);
		this.completeOperator(op, change);
	}

	private cmdForceMotion(type: string): void {
		if (!this.operator || this.textObjectKind || (type !== 'char' && type !== 'line' && type !== 'block')) {
			this.invalid();
		}
		this.forced = type;
	}

	private cmdTextObjectPrefix(kind: string): void {
		if ((kind !== 'inner' && kind !== 'around') || this.textObjectKind || !(this.operator || this.isVisual())) {
			this.invalid();
		}
		this.textObjectKind = kind;
	}

	private cmdTextObject(object: string, kindArg: string): void {
		const kind = kindArg === 'inner' || kindArg === 'around' ? kindArg : this.textObjectKind;
		const ch = TEXT_OBJECTS[object];
		if (!ch) {
			this.invalid(`Unknown text object: ${object}`);
		}
		if (!kind) {
			this.invalid();
		}
		const around = kind === 'around';
		const n = this.effectiveCount() ?? 1;
		if (ch === 'n') {
			// v_an / v_in: the language's syntax tree, as VS Code's smart select
			if (!this.isVisual()) {
				this.invalid();
			}
			this.textObjectKind = undefined;
			this.cmdRun({ command: around ? 'editor.action.smartSelect.expand' : 'editor.action.smartSelect.shrink', visual: 'keep', count: 'repeat' });
			return;
		}
		if (this.isVisual()) {
			this.visualTextObject(ch, around, n);
			this.complete(undefined);
			return;
		}
		const op = this.operator;
		const cur = this.cursor();
		if (!op) {
			if (ch !== 'gn' && ch !== 'gN') {
				this.invalid();
			}
			// gn in normal mode: select the match
			const r = this.textObject(ch, around, n, cur);
			if (!r) {
				this.invalid(this.message);
			}
			this._mode = 'visual';
			this.visualAnchor = r.start;
			this.visualHead = this.prevChar(r.end) ?? r.end;
			this.visualToEol = false;
			if (ch === 'gN') {
				[this.visualAnchor, this.visualHead] = [this.visualHead, this.visualAnchor];
			}
			this.renderVisual();
			this.complete(undefined);
			return;
		}
		const range = this.textObject(ch, around, n, cur);
		if (!range) {
			this.invalid(this.message);
		}
		if (this.forced === 'line') {
			range.linewise = true;
			range.start = pos(range.start.line, 0);
			range.end = pos(range.end.line, this.len(range.end.line));
		} else if (this.forced === 'char' && range.linewise) {
			range.linewise = false;
		}
		const change = op === 'y' ? undefined : this.snapshot();
		this.applyOperator(op, this.register, range, cur, change);
		this.completeOperator(op, change);
	}

	private visualTextObject(ch: string, around: boolean, n: number): void {
		const [a, b] = this.orderedVisual();
		const single = cmp(this.visualAnchor, this.visualHead) === 0;
		let r: Range | undefined;
		if ((ch === 'w' || ch === 'W') && !single && cmp(this.visualHead, this.visualAnchor) > 0) {
			// a selection that is more than a character: extend by words from the head
			const next = this.nextChar(this.visualHead);
			const ext = next && this.wordObject(around, ch === 'W', n, next);
			if (!ext) {
				this.invalid();
			}
			this.visualHead = this.prevChar(ext.end) ?? ext.end;
			this.renderVisual();
			return;
		}
		if (ch === 'p' && !single) {
			const next = b.line + 1 <= this.lastLine() ? pos(b.line + 1, 0) : undefined;
			const ext = next && this.paragraphObject(around, n, next);
			if (!ext) {
				this.invalid();
			}
			this._mode = 'visualLine';
			this.visualHead = pos(ext.end.line, 0);
			this.renderVisual();
			return;
		}
		r = this.textObject(ch, around, n, this.visualHead);
		if (r && !single && cmp(r.start, a) >= 0 && cmp(this.prevChar(r.end) ?? r.end, b) <= 0 && BRACKETS[ch]) {
			// `vi(` again: the next level out
			r = this.textObject(ch, around, n + 1, this.visualHead);
		}
		if (!r) {
			this.invalid();
		}
		if (r.linewise) {
			this._mode = 'visualLine';
		} else if (this._mode === 'visualLine') {
			this._mode = 'visual';
		}
		this.visualAnchor = r.start;
		this.visualHead = r.linewise ? pos(r.end.line, 0) : (cmp(r.start, r.end) === 0 ? r.end : (this.prevChar(r.end) ?? r.end));
		if (ch === 'gN') {
			[this.visualAnchor, this.visualHead] = [this.visualHead, this.visualAnchor];
		}
		this.renderVisual();
	}

	private cmdCount(digit: unknown): void {
		const d = typeof digit === 'number' ? digit : Number(digit);
		if (!Number.isInteger(d) || d < 0 || d > 9 || this.textObjectKind) {
			this.invalid();
		}
		if (d === 0 && this.count === undefined) {
			// `0` with no count before it is the motion (the default keymap never sends this)
			this.steps.pop();
			this.steps.push({ command: 'devhubVim.motion', args: { motion: 'lineStart' } });
			this.cmdMotion('lineStart', undefined);
			return;
		}
		this.count = Math.min(99999999, (this.count ?? 0) * 10 + d);
	}

	private cmdRegister(name: string | undefined): void {
		if (!name || this.operator || this.textObjectKind || !/^[a-zA-Z0-9"\-_+*.:/%#=]$/.test(name)) {
			this.invalid();
		}
		this.register = name;
		if (name === '+' || name === '*') {
			this.host.prefetchClipboard();
		}
	}

	private cmdAwaitChar(then: unknown): void {
		if (!isRecord(then) || typeof then.command !== 'string' || !then.command || (then.args !== undefined && !isRecord(then.args))) {
			this.invalid('devhubVim.awaitChar needs { "then": { "command": ..., "args"?: { ... } } }');
		}
		this.awaiting = { command: then.command, args: isRecord(then.args) ? then.args : {} };
		if (then.command === 'devhubVim.register' || (then.command === 'devhubVim.insert' && isRecord(then.args) && then.args.action === 'insertRegister')) {
			this.host.prefetchClipboard();
		}
	}

	private cmdMark(ch: string | undefined): void {
		if (!ch || !SETTABLE_MARK.test(ch) || this.operator || this.textObjectKind) {
			this.invalid();
		}
		const cur = this.cursor();
		if (ch === '<' || ch === '>') {
			const other = this.getMark(ch === '<' ? '>' : '<') ?? cur;
			this.lastVisual = { mode: this.lastVisual?.mode ?? 'visual', anchor: ch === '<' ? cur : other, head: ch === '<' ? other : cur, toEol: false };
		} else {
			this.setMark(ch === '`' ? '\'' : ch, cur);
		}
		this.complete(undefined);
	}

	private cmdMode(to: string, at: string): void {
		if (to === 'normal') {
			if (this.isInsert()) {
				this.exitInsert(false);
			} else if (this.isVisual()) {
				this.leaveVisual(this.visualHead);
			}
			this.closeCmdline();
			this.resetGrammar();
			return;
		}
		if (this.isInsert() || this.operator || this.textObjectKind) {
			this.invalid();
		}
		if (to === 'visual' || to === 'visualLine' || to === 'visualBlock') {
			if (this.isVisual()) {
				if (this._mode === to) {
					this.leaveVisual(this.visualHead);
				} else {
					this._mode = to;
					this.renderVisual();
				}
			} else {
				const cur = this.cursor();
				const n = this.effectiveCount();
				this._mode = to;
				this.visualAnchor = cur;
				this.visualHead = cur;
				this.visualToEol = false;
				if (n !== undefined && n > 1) {
					// {count}v: that many characters / lines
					this.visualHead = to === 'visualLine' ? pos(this.clampLine(cur.line + n - 1), cur.col) : this.clampNormal(pos(cur.line, cur.col + n - 1));
				}
				this.renderVisual();
			}
			this.complete(undefined);
			return;
		}
		if (this.isVisual()) {
			this.invalid();
		}
		if (to === 'replace') {
			const cur = this.cursor();
			const change = this.snapshot();
			this.openChange();
			this.enterInsert(cur, this.effectiveCount() ?? 1, change, 'inline');
			this._mode = 'replace';
			this.insert!.original = { line: cur.line, text: this.host.lineText(cur.line) };
			this.resetGrammar();
			return;
		}
		if (to !== 'insert') {
			this.invalid(`Unknown mode: ${to}`);
		}
		const cur = this.cursor();
		const n = this.effectiveCount() ?? 1;
		const change = this.snapshot();
		switch (at || 'before') {
			case 'before': case 'after': case 'lineEnd': case 'firstNonBlank': case 'lineStart': {
				const where = at === 'after' ? pos(cur.line, Math.min(cur.col + 1, this.len(cur.line)))
					: at === 'lineEnd' ? pos(cur.line, this.len(cur.line))
						: at === 'firstNonBlank' ? pos(cur.line, this.firstNonBlank(cur.line))
							: at === 'lineStart' ? pos(cur.line, 0)
								: cur;
				this.openChange();
				this.enterInsert(where, n, change, 'inline');
				break;
			}
			case 'lastInsert': {
				const m = this.marks.get('^');
				const where = m ? pos(this.clampLine(m.line), Math.min(m.col, this.len(this.clampLine(m.line)))) : cur;
				this.openChange();
				this.enterInsert(where, n, change, 'inline');
				break;
			}
			case 'lineBelow': case 'lineAbove': {
				const indent = this.indentOf(cur.line);
				this.openChange();
				if (at === 'lineBelow') {
					this.edit([{ start: pos(cur.line, this.len(cur.line)), end: pos(cur.line, this.len(cur.line)), text: '\n' + indent }]);
					this.enterInsert(pos(cur.line + 1, indent.length), n, change, 'lineBelow');
				} else {
					this.edit([{ start: pos(cur.line, 0), end: pos(cur.line, 0), text: indent + '\n' }]);
					this.enterInsert(pos(cur.line, indent.length), n, change, 'lineAbove');
				}
				break;
			}
			default:
				this.invalid(`Unknown insert position: ${at}`);
		}
		this.resetGrammar();
	}

	private cmdAction(action: string, ch: string | undefined): void {
		if (this.operator || this.textObjectKind) {
			this.invalid();
		}
		if (this.isVisual()) {
			const change = this.visualSnapshot();
			const repeatable = this.visualAction(action, ch);
			this.complete(repeatable ? change : undefined);
			return;
		}
		const cur = this.cursor();
		const count = this.effectiveCount();
		const n = count ?? 1;
		const change = this.snapshot();
		switch (action) {
			case 'deleteChar':
				if (this.len(cur.line) !== 0) {
					this.operateMotion('d', 'right', count, undefined, cur, change);
					this.recordChange(change);
				}
				break;
			case 'deleteCharBefore':
				if (cur.col > 0) {
					this.operateMotion('d', 'left', count, undefined, cur, change);
					this.recordChange(change);
				}
				break;
			case 'deleteToLineEnd':
				this.operateMotion('d', 'lineEnd', count, undefined, cur, change);
				this.recordChange(change);
				break;
			case 'changeToLineEnd':
				this.operateMotion('c', 'lineEnd', count, undefined, cur, change);
				break;
			case 'substituteChar':
				this.operateMotion('c', 'right', count, undefined, cur, change);
				break;
			case 'substituteLine':
				this.operateLines('c', count, cur, change);
				break;
			case 'yankLine':
				this.operateLines('y', count, cur, undefined);
				break;
			case 'yankToLineEnd':
				this.operateMotion('y', 'lineEnd', count, undefined, cur, undefined);
				break;
			case 'put': case 'putBefore': case 'putAfterCursorEnd': case 'putBeforeCursorEnd': case 'putIndented': case 'putIndentedBefore':
				this.put(this.register, n, action === 'putBefore' || action === 'putBeforeCursorEnd' || action === 'putIndentedBefore', cur,
					action === 'putAfterCursorEnd' || action === 'putBeforeCursorEnd', action === 'putIndented' || action === 'putIndentedBefore');
				this.recordChange(change);
				break;
			case 'replaceChar': {
				if (!ch || Array.from(ch).length !== 1 || cur.col + n > this.len(cur.line)) {
					this.invalid();
				}
				if (ch === '\r' || ch === '\n') {
					// r<CR>: the characters become a line break
					this.edit([{ start: cur, end: pos(cur.line, cur.col + n), text: '\n' }]);
					this.closeChange();
					this.setNormalCursor(pos(cur.line + 1, 0));
				} else {
					this.edit([{ start: cur, end: pos(cur.line, cur.col + n), text: ch.repeat(n) }]);
					this.closeChange();
					this.setNormalCursor(pos(cur.line, cur.col + n - 1));
				}
				this.recordChange(change);
				break;
			}
			case 'toggleCase': {
				if (this.options.tildeop) {
					this.steps.pop();
					this.steps.push({ command: 'devhubVim.operator', args: { operator: 'toggleCase' } });
					this.cmdOperator('toggleCase');
					return;
				}
				const text = this.host.lineText(cur.line);
				const end = Math.min(text.length, cur.col + n);
				if (end > cur.col) {
					this.edit([{ start: cur, end: pos(cur.line, end), text: toggleCase(text.slice(cur.col, end)) }]);
					this.closeChange();
					this.setNormalCursor(pos(cur.line, end));
					this.recordChange(change);
				}
				break;
			}
			case 'joinLines': case 'joinLinesRaw':
				if (cur.line >= this.lastLine()) {
					this.invalid();
				}
				this.join(cur.line, Math.max(2, n), action === 'joinLines');
				this.recordChange(change);
				break;
			case 'increment': case 'decrement': {
				const edit = addToNumber(this.host.lineText(cur.line), cur.col, action === 'increment' ? n : -n, this.options.nrformats.split(','));
				if (!edit) {
					this.invalid();
				}
				this.edit([{ start: pos(cur.line, edit.start), end: pos(cur.line, edit.end), text: edit.text }]);
				this.closeChange();
				this.setNormalCursor(pos(cur.line, edit.cursor));
				this.recordChange(change);
				break;
			}
			case 'blankLineBelow': case 'blankLineAbove': {
				const lines = '\n'.repeat(n);
				if (action === 'blankLineBelow') {
					this.edit([{ start: pos(cur.line, this.len(cur.line)), end: pos(cur.line, this.len(cur.line)), text: lines }]);
					this.closeChange();
					this.setNormalCursor(cur, true);
				} else {
					this.edit([{ start: pos(cur.line, 0), end: pos(cur.line, 0), text: lines }]);
					this.closeChange();
					this.setNormalCursor(pos(cur.line + n, cur.col), true);
				}
				this.recordChange(change);
				break;
			}
			case 'undo':
				for (let c = 0; c < n; c++) {
					this.host.undo();
				}
				break;
			case 'redo':
				for (let c = 0; c < n; c++) {
					this.host.redo();
				}
				break;
			case 'repeat':
				this.repeatLastChange(count);
				break;
			case 'recordMacro': {
				if (!ch || !/^[a-zA-Z0-9"]$/.test(ch) || this.recordingMacro) {
					this.invalid();
				}
				const name = ch === '"' ? '"' : ch.toLowerCase();
				// `qA` appends to register a, as in Vim
				this.recordingMacro = { name, steps: ch !== name ? [...(this.shared.macros.get(name) ?? [])] : [] };
				break;
			}
			case 'stopMacro': {
				const rec = this.recordingMacro;
				if (!rec) {
					this.invalid();
				}
				this.recordingMacro = undefined;
				this.shared.macros.set(rec.name, rec.steps);
				this.shared.registers.delete(rec.name);
				this.shared.lastRecorded = rec.name;
				break;
			}
			case 'playMacro': {
				this.resetGrammar();
				if (ch === ':' || (ch === '@' && this.shared.lastMacro === ':')) {
					if (!this.shared.lastEx) {
						this.invalid('E30: No previous command line');
					}
					const line = this.shared.lastEx;
					this.sequence(Array.from({ length: n }, () => () => this.runEx(line)));
					this.shared.lastMacro = ':';
					break;
				}
				this.playMacro(ch === '@' ? this.shared.lastMacro : ch?.toLowerCase(), n);
				break;
			}
			case 'playLastRecorded':
				this.resetGrammar();
				this.playMacro(this.shared.lastRecorded, n);
				break;
			case 'repeatSubstitute': case 'repeatSubstituteAll':
				this.resetGrammar();
				this.runEx(action === 'repeatSubstitute' ? '&&' : '%~&');
				break;
			case 'reselect': {
				const v = this.lastVisual;
				if (!v) {
					this.invalid();
				}
				const cur2 = this.cursor();
				const was = this.isVisual() ? { mode: this._mode, anchor: this.visualAnchor, head: this.visualHead, toEol: this.visualToEol } : undefined;
				this._mode = v.mode;
				this.visualAnchor = this.clampNormal(v.anchor);
				this.visualHead = this.clampNormal(v.head);
				this.visualToEol = v.toEol;
				if (was && was.mode !== 'normal') {
					this.lastVisual = was as typeof v;
				}
				void cur2;
				this.renderVisual();
				break;
			}
			case 'noHighlight':
				this.hlActive = false;
				this.host.highlightSearch(undefined);
				break;
			case 'swapVisualEnds': case 'swapVisualCorner':
				this.invalid();
			case 'ignore':
				break;
			default:
				this.invalid(`Unknown action: ${action}`);
		}
		this.resetGrammar();
	}

	// ---- visual mode --------------------------------------------------------

	private orderedVisual(): [VimPos, VimPos] {
		return cmp(this.visualAnchor, this.visualHead) <= 0 ? [this.visualAnchor, this.visualHead] : [this.visualHead, this.visualAnchor];
	}

	/** The block's screen columns [left, right]. */
	private blockCols(): { left: number; right: number; top: number; bottom: number } {
		const tab = this.host.tabSize();
		const a = this.visualAnchor;
		const h = this.visualHead;
		const ta = this.host.lineText(a.line);
		const th = this.host.lineText(h.line);
		const va = vcolOf(ta, a.col, tab);
		const vh = vcolOf(th, h.col, tab);
		const left = Math.min(va, vh);
		const right = Math.max(va + charWidth(ta, a.col, tab) - 1, vh + charWidth(th, h.col, tab) - 1);
		return { left, right, top: Math.min(a.line, h.line), bottom: Math.max(a.line, h.line) };
	}

	private visualRange(): Range {
		const [a, b] = this.orderedVisual();
		if (this._mode === 'visualLine') {
			return { start: pos(a.line, 0), end: pos(b.line, this.len(b.line)), linewise: true };
		}
		if (this._mode === 'visualBlock') {
			const { left, right, top, bottom } = this.blockCols();
			return { start: pos(top, 0), end: pos(bottom, 0), linewise: false, block: { left, right, toEol: this.visualToEol } };
		}
		const end = b.col < this.len(b.line) ? pos(b.line, b.col + 1) : (this.nextChar(b) ?? b);
		return { start: a, end, linewise: false };
	}

	/** The columns [start, end) of `line` inside a block. */
	private blockSpan(line: number, block: { left: number; right: number; toEol: boolean }): { start: number; end: number; padLeft: number } {
		const text = this.host.lineText(line);
		const tab = this.host.tabSize();
		const s = colOfVcol(text, block.left, tab);
		if (block.toEol) {
			return { start: s.col, end: text.length, padLeft: s.past };
		}
		const e = colOfVcol(text, block.right, tab);
		return { start: s.col, end: e.col >= text.length ? text.length : e.col + 1, padLeft: s.past };
	}

	private renderVisual(): void {
		if (this._mode === 'visualBlock') {
			const r = this.visualRange();
			const ranges: VimRange[] = [];
			let primary = 0;
			for (let l = r.start.line; l <= r.end.line; l++) {
				const span = this.blockSpan(l, r.block!);
				if (l === this.visualHead.line) {
					primary = ranges.length;
				}
				ranges.push({ start: pos(l, span.start), end: pos(l, span.end) });
			}
			const tab = this.host.tabSize();
			const headLeft = vcolOf(this.host.lineText(this.visualHead.line), this.visualHead.col, tab) <= r.block!.left && !this.visualToEol;
			this.host.setSelections(ranges, primary, headLeft, this.takeJump());
			return;
		}
		const r = this.visualRange();
		const backwards = cmp(this.visualHead, this.visualAnchor) < 0;
		this.host.setSelection(r.start, r.end, backwards, this.takeJump());
	}

	private saveVisual(): void {
		if (this.isVisual()) {
			this.lastVisual = { mode: this._mode as 'visual' | 'visualLine' | 'visualBlock', anchor: this.visualAnchor, head: this.visualHead, toEol: this.visualToEol };
		}
	}

	/** Leave visual mode (remembering it for gv and '< '>) with the caret at `cursor`. */
	private leaveVisual(cursor: VimPos): void {
		this.saveVisual();
		this._mode = 'normal';
		this.setNormalCursor(cursor);
	}

	/** What `.` needs to redo a visual-mode change: the size of the area. */
	private visualDims(): VisualDims {
		const [a, b] = this.orderedVisual();
		const mode = this._mode as VisualDims['mode'];
		if (mode === 'visualBlock') {
			const { left, right } = this.blockCols();
			return { mode, lines: b.line - a.line + 1, cols: right - left + 1, toEol: this.visualToEol };
		}
		return { mode, lines: b.line - a.line + 1, cols: a.line === b.line ? b.col - a.col + 1 : b.col, toEol: false };
	}

	private visualSnapshot(): LastChange {
		return { ...this.snapshot(), visual: this.visualDims() };
	}

	/** For `.` after a visual change: the same amount of text from the cursor. */
	private reselectFor(dims: VisualDims, cur: VimPos): void {
		this._mode = dims.mode;
		this.visualAnchor = cur;
		const last = this.clampLine(cur.line + dims.lines - 1);
		if (dims.mode === 'visualBlock') {
			const tab = this.host.tabSize();
			const v = vcolOf(this.host.lineText(cur.line), cur.col, tab) + dims.cols - 1;
			this.visualHead = pos(last, colOfVcol(this.host.lineText(last), v, tab).col);
			this.visualToEol = dims.toEol;
		} else if (dims.mode === 'visual') {
			this.visualHead = dims.lines === 1 ? this.clampNormal(pos(cur.line, cur.col + dims.cols - 1)) : this.clampNormal(pos(last, dims.cols));
		} else {
			this.visualHead = pos(last, 0);
		}
	}

	/** An operator on the visual area; `change` is what `.` repeats once a `c` insert ends. */
	private visualOperator(op: string, forceLinewise: boolean, change: LastChange | undefined = this.pendingVisualChange): void {
		const range = this.visualRange();
		this.saveVisual();
		if (range.block && !forceLinewise) {
			this._mode = 'normal';
			this.applyOperator(op, this.register, range, range.start, op === 'c' ? change : undefined);
			return;
		}
		const linewise = range.linewise || forceLinewise;
		const r: Range = linewise ? { start: pos(range.start.line, 0), end: pos(range.end.line, this.len(range.end.line)), linewise: true } : range;
		const cur = this.visualHead;
		this._mode = 'normal';
		if (op === '>' || op === '<') {
			const n = this.effectiveCount() ?? 1;
			this.shift(r.start.line, r.end.line, op === '>', n);
			this.closeChange();
			return;
		}
		this.applyOperator(op, this.register, r, cur, op === 'c' ? change : undefined);
		if (op === 'y') {
			this.setNormalCursor(r.start);
		}
	}

	/** The change a visual action records (a visual `c` records it when its insert ends). */
	private pendingVisualChange: LastChange | undefined;

	/** Returns whether the action is a change `.` repeats. */
	private visualAction(action: string, ch: string | undefined): boolean {
		const range = this.visualRange();
		const leave = (cursor: VimPos) => this.leaveVisual(cursor);
		const block = this._mode === 'visualBlock';
		this.pendingVisualChange = this.visualSnapshot();
		switch (action) {
			case 'deleteChar':
				this.visualOperator('d', false);
				return true;
			case 'deleteCharBefore': case 'deleteToLineEnd':
				if (block && action === 'deleteToLineEnd') {
					this.visualToEol = true;
					this.visualOperator('d', false);
					return true;
				}
				this.visualOperator('d', true);
				return true;
			case 'yankLine': case 'yankToLineEnd':
				if (block && action === 'yankToLineEnd') {
					this.visualToEol = true;
					this.visualOperator('y', false);
					return false;
				}
				this.visualOperator('y', true);
				return false;
			case 'substituteChar':
				this.visualOperator('c', false);
				return false;
			case 'substituteLine': case 'changeToLineEnd':
				if (block && action === 'changeToLineEnd') {
					this.visualToEol = true;
					this.visualOperator('c', false);
					return false;
				}
				this.visualOperator('c', true);
				return false;
			case 'swapVisualEnds':
				[this.visualAnchor, this.visualHead] = [this.visualHead, this.visualAnchor];
				this.renderVisual();
				return false;
			case 'swapVisualCorner': {
				if (!block) {
					[this.visualAnchor, this.visualHead] = [this.visualHead, this.visualAnchor];
				} else {
					const tab = this.host.tabSize();
					const va = vcolOf(this.host.lineText(this.visualAnchor.line), this.visualAnchor.col, tab);
					const vh = vcolOf(this.host.lineText(this.visualHead.line), this.visualHead.col, tab);
					this.visualAnchor = pos(this.visualAnchor.line, colOfVcol(this.host.lineText(this.visualAnchor.line), vh, tab).col);
					this.visualHead = pos(this.visualHead.line, colOfVcol(this.host.lineText(this.visualHead.line), va, tab).col);
				}
				this.renderVisual();
				return false;
			}
			case 'joinLines': case 'joinLinesRaw':
				this.saveVisual();
				this._mode = 'normal';
				this.join(range.start.line, Math.max(2, range.end.line - range.start.line + 1), action === 'joinLines');
				return true;
			case 'toggleCase': case 'lowercase': case 'uppercase': {
				const op = action === 'toggleCase' ? 'g~' : action === 'lowercase' ? 'gu' : 'gU';
				this.visualOperator(op, false);
				return true;
			}
			case 'replaceChar': {
				if (!ch) {
					this.invalid();
				}
				const edits: VimEdit[] = [];
				this.forEachVisualSpan(range, (line, s, e) => {
					const t = this.host.lineText(line).slice(s, e);
					if (t) {
						edits.push({ start: pos(line, s), end: pos(line, e), text: Array.from(t).map(c => c === '\t' && !block ? ch : ch).join('') });
					}
				});
				this.edit(edits);
				this.closeChange();
				leave(range.block ? pos(range.start.line, this.blockSpan(range.start.line, range.block).start) : range.start);
				return true;
			}
			case 'put': case 'putBefore': {
				const reg = this.readRegister(this.register);
				if (!reg) {
					this.invalid(`E353: Nothing in register ${this.register ?? '"'}`);
				}
				this.saveVisual();
				const replaced = range.block ? this.blockText(range) : this.getText(range.linewise ? pos(range.start.line, 0) : range.start, range.end);
				const replacedType: VimRegisterType = range.block ? 'block' : range.linewise ? 'line' : 'char';
				this._mode = 'normal';
				const n = this.effectiveCount() ?? 1;
				if (range.block) {
					this.deleteBlock(range);
					this.setNormalCursor(pos(range.start.line, this.blockSpan(range.start.line, range.block).start));
					this.put(this.register, n, true, this.host.getCursor(), false, false, reg);
				} else if (range.linewise) {
					const text = reg.type === 'line' ? new Array(n).fill(reg.text).join('\n') : reg.text.repeat(n);
					this.edit([{ start: pos(range.start.line, 0), end: pos(range.end.line, this.len(range.end.line)), text }]);
					this.closeChange();
					this.setNormalCursor(pos(range.start.line, this.firstNonBlank(range.start.line)));
				} else {
					let text = reg.type === 'line' ? new Array(n).fill(reg.text).join('\n') : reg.text.repeat(n);
					if (reg.type === 'line') {
						text = '\n' + text + '\n';
					}
					this.edit([{ start: range.start, end: range.end, text }]);
					this.closeChange();
					if (reg.type === 'line') {
						this.setNormalCursor(pos(range.start.line + 1, this.firstNonBlank(range.start.line + 1)));
					} else {
						const end = endOfText(range.start, text);
						this.setNormalCursor(text.includes('\n') ? range.start : pos(end.line, end.col - 1));
					}
				}
				if (action === 'put') {
					// v_p: the replaced text goes to the unnamed register (v_P keeps it)
					this.storeRegister(this.register === '_' ? '_' : undefined, replaced, replacedType, 'delete');
				}
				return action === 'putBefore';
			}
			case 'increment': case 'decrement': case 'incrementProgressive': case 'decrementProgressive': {
				const n = this.effectiveCount() ?? 1;
				const sign = action.startsWith('increment') ? 1 : -1;
				const progressive = action.endsWith('Progressive');
				const edits: VimEdit[] = [];
				let k = 0;
				this.forEachVisualSpan(range, (line, s, e) => {
					const text = this.host.lineText(line);
					const edit = addToNumber(text.slice(0, e), s, sign * n * (progressive ? k + 1 : 1), this.options.nrformats.split(','), true);
					if (edit) {
						k++;
						edits.push({ start: pos(line, edit.start), end: pos(line, edit.end), text: edit.text });
					}
				});
				this.saveVisual();
				this.edit(edits);
				this.closeChange();
				leave(range.block ? pos(range.start.line, this.blockSpan(range.start.line, range.block).start) : range.linewise ? pos(range.start.line, 0) : range.start);
				return true;
			}
			case 'visualInsert': case 'visualAppend': {
				const append = action === 'visualAppend';
				this.saveVisual();
				const change = this.pendingVisualChange;
				if (range.block) {
					const lines: number[] = [];
					for (let l = range.start.line; l <= range.end.line; l++) {
						lines.push(l);
					}
					const vcol = append ? range.block.right + 1 : range.block.left;
					this._mode = 'normal';
					const first = range.start.line;
					const at = append ? this.blockAppendPos(first, vcol, range.block.toEol) : pos(first, this.blockSpan(first, range.block).start);
					this.openChange();
					if (append && !range.block.toEol) {
						this.padTo(first, vcol);
					}
					this.enterInsert(at.col <= this.len(first) ? at : pos(first, this.len(first)), 1, change, 'inline');
					this.insert!.block = { lines: lines.slice(1), vcol, toEol: range.block.toEol, append };
					return false;
				}
				// in characterwise and linewise visual mode I and A work on the lines (`:help v_b_I` is only for blocks):
				// I at the start of the first line, A at the end of the last
				this._mode = 'normal';
				this.openChange();
				const lastLine = range.linewise || range.end.col > 0 || range.end.line === range.start.line ? range.end.line : range.end.line - 1;
				const at = append ? pos(lastLine, this.len(lastLine)) : pos(range.start.line, 0);
				this.enterInsert(at, 1, change, 'inline');
				return false;
			}
			case 'visualSearchForward': case 'visualSearchBackward': {
				const text = range.block ? this.blockText(range) : this.getText(range.start, range.end);
				leave(range.start);
				this.cmdSearch(literalPattern(text, action === 'visualSearchForward' ? '/' : '?'), action === 'visualSearchBackward', 1);
				return false;
			}
			case 'visualPlayMacro': {
				if (!ch) {
					this.invalid();
				}
				const name = ch === '@' ? this.shared.lastMacro : ch.toLowerCase();
				this.saveVisual();
				this._mode = 'normal';
				this.forLines(range.start.line, range.end.line, () => this.playMacro(name, 1));
				return false;
			}
			case 'reselect': {
				const v = this.lastVisual;
				if (!v) {
					return false;
				}
				const now = { mode: this._mode as 'visual' | 'visualLine' | 'visualBlock', anchor: this.visualAnchor, head: this.visualHead, toEol: this.visualToEol };
				this._mode = v.mode;
				this.visualAnchor = v.anchor;
				this.visualHead = v.head;
				this.visualToEol = v.toEol;
				this.lastVisual = now;
				this.renderVisual();
				return false;
			}
			case 'noHighlight':
				this.hlActive = false;
				this.host.highlightSearch(undefined);
				return false;
			case 'ignore':
				return false;
		}
		this.invalid(action ? '' : 'devhubVim.action needs { "action": ... }');
	}

	/** For each line of a visual area: the columns [s, e) it covers on that line. */
	private forEachVisualSpan(range: Range, fn: (line: number, s: number, e: number) => void): void {
		for (let l = range.start.line; l <= range.end.line; l++) {
			if (range.block) {
				const span = this.blockSpan(l, range.block);
				fn(l, span.start, span.end);
			} else if (range.linewise) {
				fn(l, 0, this.len(l));
			} else {
				fn(l, l === range.start.line ? range.start.col : 0, l === range.end.line ? range.end.col : this.len(l));
			}
		}
	}

	/**
	 * Run `fn` with the cursor on each line from..to (lines added or removed on
	 * the way are followed), each after what the one before started (sequence);
	 * one undo step.
	 */
	private forLines(from: number, to: number, fn: () => void): void {
		const startCount = this.host.lineCount();
		const items: (() => boolean | void)[] = [];
		for (let l = from; l <= to; l++) {
			items.push(() => {
				const line = l + this.host.lineCount() - startCount;
				if (line > this.lastLine() || line < 0) {
					return false;
				}
				this.setNormalCursor(pos(line, 0));
				fn();
				return true;
			}, () => {
				if (this.isInsert()) {
					this.exitInsert(false);
				}
				if (this.isVisual()) {
					this.leaveVisual(this.visualHead);
				}
				this.resetGrammar();
			});
		}
		this.sequence(items, undefined, true);
	}

	/** Each step after what the one before started (a VS Code command a key ran, an ex line): see `sequence`. */
	private playMacro(name: string | undefined, times: number): void {
		const steps = name ? this.shared.macros.get(name) : undefined;
		if (!name || (!steps && !this.shared.registers.get(name))) {
			this.invalid(name ? `Register ${name} is empty` : 'E748: No previously used register');
		}
		if (this.playingMacro > 100) {
			this.invalid('Macro recursion too deep');
		}
		this.shared.lastMacro = name;
		const items: (() => void)[] = [];
		for (let t = 0; t < times; t++) {
			if (steps) {
				for (const s of steps) {
					items.push(() => this.execute(s.command, s.args));
				}
			} else {
				// text in the register (yanked, or written by `:let`): run it as keys
				const text = this.shared.registers.get(name)!.text;
				items.push(() => this.feedKeys(text));
			}
		}
		this.playingMacro++;
		this.sequence(items, () => this.playingMacro--);
	}

	// ---- insert mode ----------------------------------------------------------

	private cmdInsertText(text: string): void {
		if (!this.isInsert()) {
			this.invalid();
		}
		if (text) {
			this.typeText(text);
		}
	}

	/** Text as if typed at the caret (replace mode overwrites). */
	private typeText(text: string): void {
		const at = this.host.getCursor();
		if (this._mode === 'replace') {
			const lineLen = this.len(at.line);
			const first = text.split('\n')[0];
			const over = Math.min(lineLen - at.col, first.length);
			this.edit([{ start: at, end: pos(at.line, at.col + over), text }]);
		} else {
			this.edit([{ start: at, end: at, text }]);
		}
		this.host.setCursor(endOfText(at, text));
	}

	private cmdInsert(action: string, ch: string | undefined): void {
		if (!this.isInsert()) {
			this.invalid();
		}
		const cur = this.host.getCursor();
		const ins = this.insert;
		switch (action) {
			case 'deleteWordBefore': case 'deleteLineBefore': {
				// Neovim's default i_CTRL-W / i_CTRL-U: a new undo step first
				this.breakUndo();
				let start: VimPos;
				if (cur.col === 0) {
					if (cur.line === 0) {
						return;
					}
					start = pos(cur.line - 1, this.len(cur.line - 1));
				} else if (action === 'deleteLineBefore') {
					const sameLine = ins && ins.start.line === cur.line && ins.start.col < cur.col;
					const fnb = this.firstNonBlank(cur.line);
					start = pos(cur.line, sameLine ? ins!.start.col : (fnb < cur.col ? fnb : 0));
				} else {
					const text = this.host.lineText(cur.line);
					let c = cur.col;
					while (c > 0 && isBlank(text[c - 1])) {
						c--;
					}
					if (c > 0) {
						const cls = charClassAt(text, c - 1, false);
						while (c > 0 && charClassAt(text, c - 1, false) === cls) {
							c--;
						}
					}
					// stop once at the start of the insert, as Vim does
					if (ins && ins.start.line === cur.line && ins.start.col < cur.col && c < ins.start.col) {
						c = ins.start.col;
					}
					start = pos(cur.line, c);
				}
				this.edit([{ start, end: cur, text: '' }]);
				this.host.setCursor(start);
				return;
			}
			case 'backspace': {
				if (this._mode === 'replace' && ins?.original) {
					if (cur.col === 0 || cmp(cur, ins.start) <= 0) {
						this.host.setCursor(this.prevChar(cur) ?? cur);
						return;
					}
					const col = cur.col - 1;
					const orig = cur.line === ins.original.line ? ins.original.text : '';
					const restore = col < orig.length ? orig[col] : '';
					this.edit([{ start: pos(cur.line, col), end: cur, text: restore }]);
					this.host.setCursor(pos(cur.line, col));
					return;
				}
				const prev = this.prevChar(cur);
				if (prev) {
					this.edit([{ start: prev, end: cur, text: '' }]);
					this.host.setCursor(prev);
				}
				return;
			}
			case 'insertRegister': {
				if (!ch) {
					this.invalid();
				}
				const reg = this.readRegister(ch);
				if (reg) {
					this.typeText(reg.type === 'line' ? reg.text + '\n' : reg.text);
				}
				return;
			}
			case 'indent': case 'outdent': {
				const before = this.len(cur.line);
				this.shift(cur.line, cur.line, action === 'indent', 1, true);
				const after = this.len(cur.line);
				this.host.setCursor(pos(cur.line, Math.max(0, cur.col + after - before)));
				return;
			}
			case 'copyFromAbove': case 'copyFromBelow': {
				const line = cur.line + (action === 'copyFromAbove' ? -1 : 1);
				if (line < 0 || line > this.lastLine()) {
					return;
				}
				const tab = this.host.tabSize();
				const v = vcolOf(this.host.lineText(cur.line), cur.col, tab);
				const other = this.host.lineText(line);
				const { col, past } = colOfVcol(other, v, tab);
				if (past || col >= other.length) {
					return;
				}
				this.typeText(other[col]);
				return;
			}
			case 'insertLastInserted':
				this.typeText(this.shared.lastInserted);
				return;
			case 'oneCommand': {
				// CTRL-O: one normal-mode command, then back here
				const eol = cur.col >= this.len(cur.line) && cur.col > 0;
				this.exitInsert(false, true);
				this.insertOnce = { eol, armed: false };
				this.lastOnceCursor = this.host.getCursor();
				return;
			}
		}
		this.invalid(`Unknown insert action: ${action}`);
	}

	/** End the current undo step and start a new one (the insert goes on). */
	private breakUndo(): void {
		if (this.changeOpen && this.changeBatch === 0) {
			this.closeChange();
			this.openChange();
		}
	}

	private repeatLastChange(count: number | undefined): void {
		const last = this.lastChange;
		if (!last) {
			return;
		}
		this.replaying = true;
		try {
			this.resetGrammar();
			let register = last.register;
			if (register && /^[1-8]$/.test(register)) {
				// "1p... repeats with "2p, "3p, ...
				register = String(Number(register) + 1);
				this.lastChange = { ...last, register };
			}
			if (last.visual) {
				this.reselectFor(last.visual, this.cursor());
				if (count !== undefined && last.visual.mode !== 'visualBlock') {
					// a count with `.` after a visual change: that many lines / characters
					this.reselectFor({ ...last.visual, lines: last.visual.mode === 'visualLine' ? count : last.visual.lines, cols: last.visual.mode === 'visual' && last.visual.lines === 1 ? count : last.visual.cols }, this.visualAnchor);
				}
				this.register = register;
				this.count = undefined;
			} else {
				this.register = register;
				this.count = count ?? last.count;
			}
			for (const s of last.steps) {
				this.execute(s.command, s.args);
			}
			if (this.isInsert()) {
				if (last.insertBackspaced) {
					const at = this.host.getCursor();
					const from = pos(at.line, Math.max(0, at.col - last.insertBackspaced));
					this.edit([{ start: from, end: at, text: '' }]);
					this.host.setCursor(from);
				}
				if (last.insertText) {
					this.typeText(last.insertText);
				}
				this.exitInsert(false);
			}
		} finally {
			this.replaying = false;
		}
	}

	private enterInsert(at: VimPos, count: number, change: LastChange | undefined, repeat: InsertSession['repeat']): void {
		this._mode = 'insert';
		this.host.setCursor(at);
		this.insert = { start: at, count, change, backspaced: 0, repeat };
	}

	/**
	 * Back to normal mode: repeat the typed text for a count (or onto the other
	 * lines of a visual block), record the change for `.`, the caret one left.
	 * `interrupt` (CTRL-C) skips the count. `stay` (CTRL-O) keeps the caret.
	 */
	private exitInsert(interrupt: boolean, stay = false): void {
		const ins = this.insert;
		let cur = this.host.getCursor();
		let typed = '';
		if (ins) {
			if (cmp(cur, ins.start) > 0) {
				typed = this.getText(ins.start, cur);
			}
			if (!interrupt && typed) {
				if (ins.count > 1) {
					const more = ins.repeat === 'inline' ? typed.repeat(ins.count - 1)
						: new Array(ins.count - 1).fill(this.indentOf(ins.start.line).slice(0, ins.start.col) + typed).map(t => '\n' + t).join('');
					if (this._mode === 'replace') {
						this.typeText(more);
					} else if (ins.repeat === 'inline') {
						this.edit([{ start: cur, end: cur, text: more }]);
					} else {
						const eol = pos(cur.line, this.len(cur.line));
						this.edit([{ start: eol, end: eol, text: more }]);
					}
					cur = ins.repeat === 'inline' ? endOfText(cur, more) : pos(cur.line + ins.count - 1, this.len(cur.line + ins.count - 1));
				}
				if (ins.block && !typed.includes('\n')) {
					this.replicateBlock(ins.block, typed);
				}
			}
			this.shared.lastInserted = typed;
			if (ins.change) {
				this.recordChange({ ...ins.change, insertText: typed, insertBackspaced: ins.backspaced || undefined });
			}
			if (typed && this.recordingMacro && !this.playingMacro && !this.replaying) {
				this.recordingMacro.steps.push({ command: 'devhubVim.insertText', args: { text: typed } });
			}
		}
		this.closeChange();
		this.insert = undefined;
		this._mode = 'normal';
		this.setMark('^', cur);
		if (ins && cmp(cur, ins.start) >= 0 && typed) {
			this.setMark('[', ins.start);
			this.setMark(']', cur);
		}
		if (stay) {
			this.lastCursor = undefined;
			this.setNormalCursor(cur);
		} else {
			this.setNormalCursor(pos(cur.line, cur.col - 1));
		}
	}

	/** Visual-block I / A / c: what was typed on the first line, on every other line. */
	private replicateBlock(block: NonNullable<InsertSession['block']>, typed: string): void {
		const tab = this.host.tabSize();
		const edits: VimEdit[] = [];
		for (const l of block.lines) {
			const text = this.host.lineText(l);
			if (block.append) {
				if (block.toEol) {
					edits.push({ start: pos(l, text.length), end: pos(l, text.length), text: typed });
					continue;
				}
				const width = vcolOf(text, text.length, tab);
				const pad = width < block.vcol ? ' '.repeat(block.vcol - width) : '';
				const { col } = colOfVcol(text, block.vcol, tab);
				edits.push({ start: pos(l, Math.min(col, text.length)), end: pos(l, Math.min(col, text.length)), text: pad + typed });
			} else {
				const width = vcolOf(text, text.length, tab);
				if (width < block.vcol || (width === block.vcol && block.vcol > 0 && !text.length)) {
					continue; // short lines are not changed by I
				}
				const { col } = colOfVcol(text, block.vcol, tab);
				edits.push({ start: pos(l, col), end: pos(l, col), text: typed });
			}
		}
		this.edit(edits);
	}

	/** Where visual-block A inserts on `line`. */
	private blockAppendPos(line: number, vcol: number, toEol: boolean): VimPos {
		const text = this.host.lineText(line);
		if (toEol) {
			return pos(line, text.length);
		}
		const { col } = colOfVcol(text, vcol, this.host.tabSize());
		return pos(line, Math.min(col, text.length));
	}

	/** Pad `line` with spaces up to screen column `vcol`. */
	private padTo(line: number, vcol: number): void {
		const text = this.host.lineText(line);
		const width = vcolOf(text, text.length, this.host.tabSize());
		if (width < vcol) {
			this.edit([{ start: pos(line, text.length), end: pos(line, text.length), text: ' '.repeat(vcol - width) }]);
		}
	}

	// ---- operators ----------------------------------------------------------

	private motionRange(cur: VimPos, m: MotionResult): Range {
		const forced = this.forced;
		let linewise = m.linewise === true;
		let inclusive = m.inclusive === true;
		if (forced === 'line') {
			linewise = true;
		} else if (forced === 'char') {
			if (linewise) {
				linewise = false;
				inclusive = false;
			} else {
				inclusive = !inclusive;
			}
		}
		if (forced === 'block') {
			const tab = this.host.tabSize();
			const vc = vcolOf(this.host.lineText(cur.line), cur.col, tab);
			const vm = vcolOf(this.host.lineText(m.pos.line), m.pos.col, tab);
			return {
				start: pos(Math.min(cur.line, m.pos.line), 0), end: pos(Math.max(cur.line, m.pos.line), 0), linewise: false,
				block: { left: Math.min(vc, vm), right: Math.max(vc, vm), toEol: m.toEol === true },
			};
		}
		if (linewise) {
			const s = Math.min(cur.line, m.pos.line);
			const e = Math.max(cur.line, m.pos.line);
			return { start: pos(s, 0), end: pos(e, this.len(e)), linewise: true };
		}
		let [a, b] = cmp(cur, m.pos) <= 0 ? [cur, m.pos] : [m.pos, cur];
		if (inclusive) {
			// never past the line break: `D` on an empty line deletes nothing
			b = pos(b.line, Math.min(this.len(b.line), b.col + 1));
		} else if (!forced && b.col === 0 && b.line > a.line && cmp(m.pos, cur) > 0) {
			// `:help exclusive-linewise`: an exclusive motion ending in column 1
			// ends at the previous line's end, and if it started at or before
			// the first non-blank, it is linewise.
			b = pos(b.line - 1, this.len(b.line - 1));
			if (a.col <= this.firstNonBlank(a.line)) {
				return { start: pos(a.line, 0), end: b, linewise: true };
			}
		}
		return { start: a, end: b, linewise: false };
	}

	private applyOperator(op: string, register: string | undefined, range: Range, cur: VimPos, change: LastChange | undefined): void {
		const { start, end, linewise } = range;
		this.setMark('[', start);
		this.setMark(']', linewise ? pos(end.line, Math.max(0, this.len(end.line) - 1)) : (this.prevChar(end) ?? end));
		if (range.block) {
			this.applyBlockOperator(op, register, range, change);
			return;
		}
		switch (op) {
			case '>': case '<': {
				const n = 1;
				this.shift(start.line, linewise ? end.line : (end.col === 0 && end.line > start.line ? end.line - 1 : end.line), op === '>', n);
				this.closeChange();
				return;
			}
			case 'gu': case 'gU': case 'g~': case 'g?': {
				const fn = op === 'gu' ? (s: string) => s.toLowerCase() : op === 'gU' ? (s: string) => s.toUpperCase() : op === 'g~' ? toggleCase : rot13;
				const s = linewise ? pos(start.line, 0) : start;
				const e = linewise ? pos(end.line, this.len(end.line)) : end;
				const edits: VimEdit[] = [];
				for (let l = s.line; l <= e.line; l++) {
					const text = this.host.lineText(l);
					const a = l === s.line ? s.col : 0;
					const b = l === e.line ? e.col : text.length;
					const out = fn(text.slice(a, b));
					if (out !== text.slice(a, b)) {
						edits.push({ start: pos(l, a), end: pos(l, b), text: out });
					}
				}
				this.edit(edits);
				this.closeChange();
				this.setNormalCursor(linewise ? (cur.line === start.line ? cur : pos(start.line, this.colForDesired(start.line))) : start);
				return;
			}
			case 'gw': case 'gq': {
				const last = linewise || end.col > 0 ? end.line : Math.max(start.line, end.line - 1);
				if (op === 'gq' && this.host.hasRangeFormatter()) {
					// Neovim with a language server: 'formatexpr' is the LSP's range formatting
					this.runOnLines(start.line, last, [{ command: 'editor.action.formatSelection' }], () => {
						const l = this.clampLine(last);
						this.setNormalCursor(pos(l, this.firstNonBlank(l)));
					});
					return;
				}
				const lines: string[] = [];
				for (let l = start.line; l <= last; l++) {
					lines.push(this.host.lineText(l));
				}
				const out = formatLines(lines, this.options.textwidth || 79, this.host.lineComment(), this.host.tabSize());
				if (out.join('\n') !== lines.join('\n')) {
					this.edit([{ start: pos(start.line, 0), end: pos(last, this.len(last)), text: out.join('\n') }]);
				}
				this.closeChange();
				if (op === 'gw') {
					this.setNormalCursor(cur);
				} else {
					const l = start.line + out.length - 1;
					this.setNormalCursor(pos(l, this.firstNonBlank(l)));
				}
				return;
			}
			case '=': {
				const last = linewise || end.col > 0 ? end.line : Math.max(start.line, end.line - 1);
				this.runOnLines(start.line, last, [{ command: 'editor.action.reindentselectedlines' }], () => {
					this.setNormalCursor(pos(start.line, this.firstNonBlank(start.line)));
				});
				return;
			}
			case 'gc': {
				const last = linewise || end.col > 0 ? end.line : Math.max(start.line, end.line - 1);
				this.runOnLines(start.line, last, [{ command: 'editor.action.commentLine' }], () => {
					this.setNormalCursor(start.line === cur.line ? cur : pos(start.line, this.firstNonBlank(start.line)));
				});
				return;
			}
			case 'zf': {
				const last = linewise || end.col > 0 ? end.line : Math.max(start.line, end.line - 1);
				this.runOnLines(start.line, last, [{ command: 'editor.createFoldingRangeFromSelection' }], () => {
					this.setNormalCursor(pos(start.line, this.firstNonBlank(start.line)));
				});
				return;
			}
		}
		if (linewise) {
			const text = this.linesText(start.line, end.line);
			if (op === 'y') {
				this.storeRegister(register, text, 'line', 'yank');
				if (start.line < cur.line) {
					this.setNormalCursor(pos(start.line, Math.min(cur.col, Math.max(0, this.len(start.line) - 1))), true);
				}
				return;
			}
			this.storeRegister(register, text, 'line', 'delete');
			if (op === 'd') {
				let s: VimPos;
				let e: VimPos;
				if (end.line < this.lastLine()) {
					s = pos(start.line, 0);
					e = pos(end.line + 1, 0);
				} else if (start.line > 0) {
					s = pos(start.line - 1, this.len(start.line - 1));
					e = pos(end.line, this.len(end.line));
				} else {
					s = pos(0, 0);
					e = pos(end.line, this.len(end.line));
				}
				this.edit([{ start: s, end: e, text: '' }]);
				this.closeChange();
				const line = Math.min(start.line, this.lastLine());
				// 'nostartofline': a linewise delete keeps the column
				this.setNormalCursor(this.options.startofline ? pos(line, this.firstNonBlank(line)) : pos(line, this.colForDesired(line)), true);
				return;
			}
			// c: keep one line, with the first line's indent ('autoindent').
			const indent = this.indentOf(start.line);
			this.edit([{ start: pos(start.line, 0), end: pos(end.line, this.len(end.line)), text: indent }]);
			this.enterInsert(pos(start.line, indent.length), 1, change, 'inline');
			return;
		}
		if (cmp(start, end) >= 0) {
			if (op === 'c') {
				this.openChange();
				this.enterInsert(start, 1, change, 'inline');
			}
			return;
		}
		const text = this.getText(start, end);
		this.storeRegister(register, text, 'char', op === 'y' ? 'yank' : 'delete', range.bigMotion);
		if (op === 'y') {
			this.setNormalCursor(start);
			return;
		}
		this.edit([{ start, end, text: '' }]);
		if (op === 'd') {
			this.closeChange();
			this.setNormalCursor(start);
			return;
		}
		this.enterInsert(start, 1, change, 'inline');
	}

	/** Run VS Code commands with lines selected (gq with a formatter, =, gc, zf), then `after`. */
	private runOnLines(from: number, to: number, steps: ExStep[], after: () => void): void {
		this.closeChange();
		this.host.setSelection(pos(from, 0), pos(to, this.len(to)), false);
		this.runSteps(steps, () => {
			if (this._mode === 'normal') {
				after();
			}
		});
	}

	private blockText(range: Range): string {
		const parts: string[] = [];
		for (let l = range.start.line; l <= range.end.line; l++) {
			const span = this.blockSpan(l, range.block!);
			parts.push(this.host.lineText(l).slice(span.start, span.end));
		}
		return parts.join('\n');
	}

	private deleteBlock(range: Range): void {
		const edits: VimEdit[] = [];
		for (let l = range.start.line; l <= range.end.line; l++) {
			const span = this.blockSpan(l, range.block!);
			if (span.end > span.start) {
				edits.push({ start: pos(l, span.start), end: pos(l, span.end), text: '' });
			}
		}
		this.edit(edits);
	}

	private applyBlockOperator(op: string, register: string | undefined, range: Range, change: LastChange | undefined): void {
		const block = range.block!;
		const first = range.start.line;
		const startCol = this.blockSpan(first, block).start;
		switch (op) {
			case 'y':
				this.storeRegister(register, this.blockText(range), 'block', 'yank');
				this.setNormalCursor(pos(first, startCol));
				return;
			case 'd':
				this.storeRegister(register, this.blockText(range), 'block', 'delete');
				this.deleteBlock(range);
				this.closeChange();
				this.setNormalCursor(pos(first, startCol));
				return;
			case 'c': {
				this.storeRegister(register, this.blockText(range), 'block', 'delete');
				this.openChange();
				this.deleteBlock(range);
				const lines: number[] = [];
				for (let l = first + 1; l <= range.end.line; l++) {
					lines.push(l);
				}
				this.enterInsert(pos(first, Math.min(startCol, this.len(first))), 1, change, 'inline');
				this.insert!.block = { lines, vcol: block.left, toEol: false, append: false };
				return;
			}
			case '>': case '<': {
				const unit = this.host.indentUnit();
				const tab = this.host.tabSize();
				const edits: VimEdit[] = [];
				for (let l = first; l <= range.end.line; l++) {
					const text = this.host.lineText(l);
					const { col, past } = colOfVcol(text, block.left, tab);
					if (past || col >= text.length) {
						continue;
					}
					if (op === '>') {
						edits.push({ start: pos(l, col), end: pos(l, col), text: unit });
					} else {
						let e = col;
						let w = 0;
						const sw = unit === '\t' ? tab : unit.length;
						while (e < text.length && isBlank(text[e]) && w < sw) {
							w += text[e] === '\t' ? tab : 1;
							e++;
						}
						if (e > col) {
							edits.push({ start: pos(l, col), end: pos(l, e), text: '' });
						}
					}
				}
				this.edit(edits);
				this.closeChange();
				this.setNormalCursor(pos(first, startCol));
				return;
			}
			case 'gu': case 'gU': case 'g~': case 'g?': {
				const fn = op === 'gu' ? (s: string) => s.toLowerCase() : op === 'gU' ? (s: string) => s.toUpperCase() : op === 'g~' ? toggleCase : rot13;
				const edits: VimEdit[] = [];
				for (let l = first; l <= range.end.line; l++) {
					const span = this.blockSpan(l, block);
					const t = this.host.lineText(l).slice(span.start, span.end);
					if (t && fn(t) !== t) {
						edits.push({ start: pos(l, span.start), end: pos(l, span.end), text: fn(t) });
					}
				}
				this.edit(edits);
				this.closeChange();
				this.setNormalCursor(pos(first, startCol));
				return;
			}
		}
		// the rest work on the block's lines
		this.applyOperator(op, register, { start: pos(first, 0), end: pos(range.end.line, this.len(range.end.line)), linewise: true }, pos(first, startCol), change);
	}

	private shift(from: number, to: number, right: boolean, times = 1, emptyToo = false): void {
		const unit = this.host.indentUnit();
		const tab = this.host.tabSize();
		const sw = unit === '\t' ? tab : unit.length;
		const edits: VimEdit[] = [];
		for (let l = from; l <= to; l++) {
			const text = this.host.lineText(l);
			if (!text.length && !emptyToo) {
				continue;
			}
			const indent = /^\s*/.exec(text)![0];
			const width = vcolOf(indent, indent.length, tab);
			// 'shiftround' off: add / remove 'shiftwidth' columns
			const target = right ? width + sw * times : Math.max(0, width - sw * times);
			if (target === width) {
				continue;
			}
			const out = unit === '\t' ? '\t'.repeat(Math.floor(target / tab)) + ' '.repeat(target % tab) : ' '.repeat(target);
			edits.push({ start: pos(l, 0), end: pos(l, indent.length), text: out });
		}
		this.edit(edits);
		if (!this.isInsert()) {
			// 'nostartofline': >> and << keep the cursor's screen column (the text moves under it)
			this.setNormalCursor(this.options.startofline ? pos(from, this.firstNonBlank(from)) : pos(from, this.colForDesired(from)), !this.options.startofline);
		}
	}

	/** J (`spaces`) / gJ: join `count` lines from `line` (`:help J`). */
	private join(line: number, count: number, spaces: boolean): void {
		const last = Math.min(this.lastLine(), line + count - 1);
		if (last === line) {
			return;
		}
		const edits: VimEdit[] = [];
		let joined = this.host.lineText(line);
		let cursorCol = 0;
		for (let l = line; l < last; l++) {
			const cur = this.host.lineText(l);
			const next = this.host.lineText(l + 1);
			if (!spaces) {
				edits.push({ start: pos(l, cur.length), end: pos(l + 1, 0), text: '' });
				cursorCol = joined.length;
				joined += next;
				continue;
			}
			const fnb = this.firstNonBlank(l + 1);
			const rest = next.slice(fnb);
			const endCh = joined[joined.length - 1] ?? '';
			let sep = '';
			if (rest !== '' && !rest.startsWith(')') && joined.length > 0 && endCh !== '\t' && endCh !== ' ') {
				sep = this.options.joinspaces && /[.!?]$/.test(joined) ? '  ' : ' ';
			}
			edits.push({ start: pos(l, cur.length), end: pos(l + 1, fnb), text: sep });
			cursorCol = joined.length;
			joined += sep + rest;
			if (sep === '' && rest === '' && l + 1 === last) {
				cursorCol = Math.max(0, joined.length - 1);
			}
		}
		this.edit(edits);
		this.closeChange();
		this.setNormalCursor(pos(line, cursorCol));
	}

	/**
	 * p / P / gp / gP / ]p / [p (`indent`: the lines get the cursor line's
	 * indent). Linewise text goes on new lines (the cursor on the first
	 * non-blank of the first one), blockwise text as a block at the cursor's
	 * screen column, charwise text after / before the cursor (the cursor on
	 * its last character, or its first when it has several lines).
	 */
	private put(register: string | undefined, count: number, before: boolean, cur: VimPos, cursorAfter: boolean, indent: boolean, value?: VimRegister): void {
		const reg = value ?? this.readRegister(register);
		if (!reg) {
			this.invalid(`E353: Nothing in register ${register ?? '"'}`);
		}
		if (reg.type === 'line') {
			let lines = reg.text.split('\n');
			if (indent) {
				const tab = this.host.tabSize();
				const want = this.indentOf(cur.line);
				const have = /^\s*/.exec(lines[0])![0];
				const delta = vcolOf(want, want.length, tab) - vcolOf(have, have.length, tab);
				lines = lines.map(l => {
					if (!l.trim()) {
						return l;
					}
					const ind = /^\s*/.exec(l)![0];
					const w = Math.max(0, vcolOf(ind, ind.length, tab) + delta);
					const unit = this.host.indentUnit();
					const out = unit === '\t' ? '\t'.repeat(Math.floor(w / tab)) + ' '.repeat(w % tab) : ' '.repeat(w);
					return out + l.slice(ind.length);
				});
			}
			const block = new Array(count).fill(lines.join('\n')).join('\n');
			const n = block.split('\n').length;
			const first = before ? cur.line : cur.line + 1;
			if (before) {
				this.edit([{ start: pos(cur.line, 0), end: pos(cur.line, 0), text: block + '\n' }]);
			} else {
				const eol = pos(cur.line, this.len(cur.line));
				this.edit([{ start: eol, end: eol, text: '\n' + block }]);
			}
			this.closeChange();
			this.setMark('[', pos(first, 0));
			this.setMark(']', pos(first + n - 1, 0));
			if (cursorAfter) {
				const l = first + n;
				this.setNormalCursor(l <= this.lastLine() ? pos(l, 0) : pos(this.lastLine(), 0));
			} else {
				this.setNormalCursor(pos(first, this.firstNonBlank(first)));
			}
			return;
		}
		if (reg.type === 'block') {
			const rows = reg.text.split('\n');
			const tab = this.host.tabSize();
			const width = Math.max(...rows.map(r => vcolOf(r, r.length, tab)));
			const curText = this.host.lineText(cur.line);
			const startV = before || !curText.length ? vcolOf(curText, cur.col, tab) : vcolOf(curText, cur.col, tab) + charWidth(curText, cur.col, tab);
			// each line rewritten whole (lines past the end of the buffer are added to the last one's text)
			const edits: VimEdit[] = [];
			const missing: string[] = [];
			for (let i = 0; i < rows.length; i++) {
				const piece = new Array(count).fill(rows[i] + ' '.repeat(width - vcolOf(rows[i], rows[i].length, tab))).join('');
				const l = cur.line + i;
				if (l > this.lastLine()) {
					missing.push(' '.repeat(startV) + piece.replace(/\s+$/, ''));
					continue;
				}
				const text = this.host.lineText(l);
				const w = vcolOf(text, text.length, tab);
				let out: string;
				if (w < startV) {
					out = text + ' '.repeat(startV - w) + piece.replace(/\s+$/, '');
				} else {
					const { col } = colOfVcol(text, startV, tab);
					out = col >= text.length ? text + piece.replace(/\s+$/, '') : text.slice(0, col) + piece + text.slice(col);
				}
				edits.push({ start: pos(l, 0), end: pos(l, text.length), text: out });
			}
			if (missing.length) {
				const ll = this.lastLine();
				const lastEdit = edits.find(e => e.start.line === ll);
				if (lastEdit) {
					edits[edits.indexOf(lastEdit)] = { ...lastEdit, text: lastEdit.text + '\n' + missing.join('\n') };
				} else {
					edits.push({ start: pos(ll, this.len(ll)), end: pos(ll, this.len(ll)), text: '\n' + missing.join('\n') });
				}
			}
			this.edit(edits);
			this.closeChange();
			const col = colOfVcol(this.host.lineText(cur.line), startV, tab).col;
			if (cursorAfter) {
				const l = cur.line + rows.length - 1;
				this.setNormalCursor(pos(l, colOfVcol(this.host.lineText(l), startV + width * count, tab).col));
			} else {
				this.setNormalCursor(pos(cur.line, col));
			}
			return;
		}
		const text = reg.text.repeat(count);
		const at = before || this.len(cur.line) === 0 ? cur : pos(cur.line, cur.col + 1);
		this.edit([{ start: at, end: at, text }]);
		this.closeChange();
		const end = endOfText(at, text);
		this.setMark('[', at);
		this.setMark(']', pos(end.line, Math.max(0, end.col - 1)));
		if (cursorAfter) {
			this.lastCursor = undefined;
			const p = end.col >= this.len(end.line) && end.line < this.lastLine() ? pos(end.line + 1, 0) : end;
			this.host.setCursor(p.col >= this.len(p.line) ? pos(p.line, Math.max(0, this.len(p.line) - 1)) : p);
			this.lastCursor = this.host.getCursor();
		} else if (text.includes('\n')) {
			this.setNormalCursor(at);
		} else {
			this.setNormalCursor(pos(end.line, end.col - 1));
		}
	}

	// ---- scrolling ------------------------------------------------------------

	private cmdScroll(a: Args): void {
		if (this.operator || this.textObjectKind) {
			this.invalid();
		}
		const count = this.effectiveCount();
		const n = count ?? 1;
		const cur = this.cursor();
		const { top, bottom } = this.host.visibleLines();
		const height = Math.max(1, bottom - top + 1);
		const last = this.lastLine();
		const to = str(a.to);
		if (to) {
			// zt zz zb (z<CR> z. z- also go to the first non-blank); a count is the line
			const line = count !== undefined ? this.clampLine(count - 1) : cur.line;
			const at = to === 'top' ? 'top' : to === 'bottom' ? 'bottom' : 'center';
			const target = a.firstNonBlank === true ? pos(line, this.firstNonBlank(line)) : pos(line, line === cur.line ? cur.col : this.colForDesired(line));
			this.host.scrollToLine(line, at, () => this.moveCursorKeepVisual(target, a.firstNonBlank !== true));
			this.complete(undefined);
			return;
		}
		const down = str(a.direction) !== 'up';
		const by = str(a.by) || 'line';
		let newTop = top;
		let line = cur.line;
		if (by === 'line') {
			// CTRL-E / CTRL-Y: the text moves, the cursor stays unless it would leave the window
			newTop = Math.max(0, Math.min(last, top + (down ? n : -n)));
			const newBottom = newTop + height - 1;
			line = Math.max(newTop, Math.min(newBottom, cur.line));
		} else if (by === 'halfPage') {
			// CTRL-D / CTRL-U: scroll and move the cursor the same number of lines
			const amount = count ?? Math.max(1, Math.floor(height / 2));
			if (down) {
				if (cur.line >= last) {
					this.invalid();
				}
				// not past the point where the last line is at the bottom
				newTop = Math.min(top + amount, Math.max(top, last - height + 1));
				line = Math.min(last, cur.line + amount);
			} else {
				if (cur.line === 0) {
					this.invalid();
				}
				newTop = Math.max(0, top - amount);
				line = Math.max(0, cur.line - amount);
			}
		} else {
			// CTRL-F / CTRL-B: whole pages, two lines of overlap
			const page = Math.max(1, height - 2);
			if (down) {
				if (top >= last) {
					this.invalid();
				}
				newTop = Math.min(last, top + n * page);
				line = Math.max(cur.line, newTop);
			} else {
				if (top === 0) {
					this.invalid();
				}
				newTop = Math.max(0, top - n * page);
				line = Math.min(cur.line, newTop + height - 1);
			}
		}
		// the cursor first (not revealed), then the one scroll to the new top
		this.host.scrollToLine(newTop, 'top', line !== cur.line ? () => this.moveCursorKeepVisual(this.lineTarget(line), !this.options.startofline) : undefined);
		this.complete(undefined);
	}

	private moveCursorKeepVisual(p: VimPos, keepDesired: boolean): void {
		if (this.isVisual()) {
			this.visualHead = this.clampNormal(p);
			this.renderVisual();
		} else {
			this.setNormalCursor(p, keepDesired);
		}
	}

	// ---- devhubVim.run: a VS Code command as a Vim command ----------------------

	/** The steps one `devhubVim.run` runs: `{ command, args? }` or `{ commands: [...] }`. */
	private runStepsOf(a: Args): ExStep[] {
		const command = str(a.command);
		const list = Array.isArray(a.commands) ? (a.commands as unknown[]).filter((c): c is ExStep => isRecord(c) && typeof c.command === 'string' && !!c.command) : undefined;
		if ((!command && !list?.length) || this.operator || this.textObjectKind) {
			this.invalid(command || list?.length ? '' : 'devhubVim.run needs { "command": ... } or { "commands": [...] }');
		}
		return list ?? [a.args === undefined ? { command } : { command, args: a.args }];
	}

	/**
	 * `devhubVim.run`: a command (or several, in order) as a Vim action. Its
	 * args are what the key gave, with the Vim state already put in
	 * (expandVimState); it consumes the count and register and does not repeat
	 * (wrap it in `devhubVim.repeat` for that). In visual mode the commands run
	 * with the selection on screen, then visual mode ends (`"visual": "keep"`:
	 * the selection the commands made is the visual area).
	 */
	private cmdRun(a: Args): void {
		this.runAsAction(this.runStepsOf(a), a.visual === 'keep');
	}

	private runAsAction(steps: ExStep[], keep: boolean): void {
		this.resetGrammar();
		if (this.isVisual()) {
			this.saveVisual();
			this.runNested(steps, () => {
				if (keep) {
					// the command changed the selection (smart select): it is the visual area now
					const s = this.host.getSelection();
					if (cmp(s.anchor, s.active) !== 0) {
						this.visualAnchor = s.anchor;
						this.visualHead = cmp(s.active, s.anchor) > 0 ? this.prevChar(s.active) ?? s.active : s.active;
						if (this._mode === 'visualLine' || this._mode === 'visualBlock') {
							this._mode = 'visual';
						}
						this.renderVisual();
					}
				} else if (this.isVisual()) {
					const [first] = this.orderedVisual();
					this.leaveVisual(first);
				}
			});
			return;
		}
		this.runNested(steps);
	}

	/**
	 * `devhubVim.repeat { command, args?, count }`: `command` with `args`,
	 * `count` times, in order (each awaited). `count` is a number (or a
	 * numeric string, as `"${count}"` gives); 0 runs nothing. In each
	 * iteration `${it}` is 1, 2, ... and `${index}` 0, 1, ... in `args`; a
	 * nested repeat's `args` keep theirs (only the innermost loop is visible).
	 * Repeating `devhubVim.run` is one Vim action: visual mode ends once, after
	 * the last iteration.
	 */
	private cmdRepeat(a: Args): void {
		const command = str(a.command);
		const n = typeof a.count === 'number' ? a.count : a.count === undefined ? 1 : Number(a.count);
		if (!command || !Number.isInteger(n) || n < 0 || this.operator || this.textObjectKind) {
			this.invalid(command ? 'devhubVim.repeat: "count" must be a whole number' : 'devhubVim.repeat needs { "command": ..., "count": ... }');
		}
		const times = Math.min(MAX_REPEAT, n);
		const iteration = (i: number): unknown => {
			const vars = { it: i + 1, index: i };
			return a.args === undefined ? undefined : command === 'devhubVim.repeat' && isRecord(a.args) ? substituteRepeatSpec(a.args, vars) : substitutePlaceholders(a.args, vars, true);
		};
		if (command === 'devhubVim.run') {
			const steps: ExStep[] = [];
			let keep = false;
			for (let i = 0; i < times; i++) {
				const args = iteration(i);
				const inner = isRecord(args) ? args : {};
				keep = inner.visual === 'keep';
				steps.push(...this.runStepsOf(inner));
			}
			this.runAsAction(steps, keep);
			return;
		}
		const steps: ExStep[] = [];
		for (let i = 0; i < times; i++) {
			const args = iteration(i);
			steps.push(args === undefined ? { command } : { command, args });
		}
		this.resetGrammar();
		this.runNested(steps);
	}

	/** Steps of run / repeat: engine commands run in the engine, not expanded or recorded again; VS Code commands are awaited in turn. */
	private runNested(steps: readonly ExStep[], after?: () => void): void {
		this.wait((async () => {
			try {
				for (const s of steps) {
					let handled: boolean;
					this.nestedDepth++;
					try {
						handled = this.execute(s.command, s.args);
					} finally {
						this.nestedDepth--;
					}
					if (!handled) {
						await this.host.executeCommand(s.command, s.args);
					}
				}
			} catch (err) {
				this.message = String(err instanceof Error ? err.message : err);
			} finally {
				try {
					after?.();
				} catch {
					// the editor went away while the commands ran
				}
				this.host.refresh();
			}
		})());
	}

	// ---- motions ------------------------------------------------------------

	/** Where motion `name` goes from `cur`; undefined when it goes nowhere (no match). */
	private motion(name: string, count: number | undefined, forOperator: boolean, cur: VimPos, ch: string | undefined): MotionResult | undefined {
		const n = count ?? 1;
		const last = this.lastLine();
		const find = FIND_MOTIONS[name];
		if (find) {
			if (!ch) {
				this.invalid();
			}
			this.shared.lastFind = { key: find, char: ch };
			return this.findInLine(cur, find, ch, n, false);
		}
		switch (name) {
			case 'left':
				if (cur.col === 0 && !forOperator) {
					return undefined;
				}
				return { pos: pos(cur.line, Math.max(0, cur.col - n)) };
			case 'right': {
				const max = forOperator ? this.len(cur.line) : Math.max(0, this.len(cur.line) - 1);
				if (cur.col >= max && !forOperator) {
					return undefined;
				}
				return { pos: pos(cur.line, Math.min(max, cur.col + n)) };
			}
			case 'charBackward': case 'charForward': {
				// <BS> / <Space> with 'whichwrap' "b,s": over line ends
				let p = cur;
				for (let c = 0; c < n; c++) {
					if (name === 'charForward') {
						const nx = p.col + 1 < this.len(p.line) ? pos(p.line, p.col + 1) : (p.line < last ? pos(p.line + 1, 0) : (forOperator ? pos(p.line, this.len(p.line)) : undefined));
						if (!nx) {
							break;
						}
						p = nx;
					} else {
						const pv = p.col > 0 ? pos(p.line, p.col - 1) : (p.line > 0 ? pos(p.line - 1, Math.max(0, this.len(p.line - 1) - (forOperator ? 0 : 1))) : undefined);
						if (!pv) {
							break;
						}
						p = pv;
					}
				}
				return cmp(p, cur) === 0 ? undefined : { pos: p };
			}
			case 'down': case 'up': {
				let line = cur.line;
				for (let c = 0; c < n; c++) {
					let next = line + (name === 'down' ? 1 : -1);
					while (next >= 0 && next <= last && this.host.isLineHidden(next)) {
						next += name === 'down' ? 1 : -1;
					}
					if (next < 0 || next > last) {
						break;
					}
					line = next;
				}
				if (line === cur.line) {
					return undefined;
				}
				return { pos: pos(line, this.colForDesired(line)), linewise: true, vertical: true };
			}
			case 'displayDown': case 'displayUp': {
				const p = this.host.displayLineMove(cur, name === 'displayDown' ? n : -n);
				if (!p || cmp(p, cur) === 0) {
					return undefined;
				}
				return { pos: p };
			}
			case 'nextLineStart': case 'previousLineStart': case 'currentLineStart': {
				const delta = name === 'previousLineStart' ? -n : name === 'currentLineStart' ? n - 1 : n;
				const line = cur.line + delta;
				if (line < 0 || line > last) {
					return undefined;
				}
				return { pos: pos(line, this.firstNonBlank(line)), linewise: true };
			}
			case 'lineStart':
				return { pos: pos(cur.line, 0) };
			case 'firstNonBlank':
				return { pos: pos(cur.line, this.firstNonBlank(cur.line)) };
			case 'lineEnd': {
				const line = cur.line + n - 1;
				if (line > last) {
					return undefined;
				}
				return { pos: pos(line, Math.max(0, this.len(line) - 1)), inclusive: true, toEol: true };
			}
			case 'lastNonBlank': {
				const line = Math.min(last, cur.line + n - 1);
				const text = this.host.lineText(line);
				const m = /\S\s*$/.exec(text);
				return { pos: pos(line, m ? m.index : 0), inclusive: true };
			}
			case 'column': {
				const text = this.host.lineText(cur.line);
				const { col } = colOfVcol(text, n - 1, this.host.tabSize());
				return { pos: pos(cur.line, Math.min(col, Math.max(0, text.length - (forOperator ? 0 : 1)))) };
			}
			case 'middleOfLine': {
				const text = this.host.lineText(cur.line);
				const pct = count === undefined ? 50 : Math.min(100, n);
				return { pos: pos(cur.line, Math.min(Math.max(0, text.length - 1), Math.floor(text.length * pct / 100))) };
			}
			case 'fileEnd': case 'fileStart': {
				const line = count === undefined ? (name === 'fileEnd' ? last : 0) : Math.max(0, Math.min(last, count - 1));
				return { pos: this.lineTarget(line), linewise: true, jump: true };
			}
			case 'screenTop': case 'screenMiddle': case 'screenBottom': {
				const { top, bottom } = this.host.visibleLines();
				const b = Math.min(bottom, last);
				const line = name === 'screenTop' ? Math.min(b, top + n - 1)
					: name === 'screenBottom' ? Math.max(top, b - n + 1)
						: Math.floor((top + b) / 2);
				return { pos: this.lineTarget(line), linewise: true, jump: true };
			}
			case 'wordForward': case 'WORDForward': {
				let p = cur;
				const big = name === 'WORDForward';
				for (let c = 0; c < n; c++) {
					const start = p;
					p = this.wordForward(p, big);
					if (forOperator && c === n - 1 && p.line > start.line) {
						// `:help w`: with an operator, the last word moved over at the end of a line ends there
						p = start.col >= this.len(start.line) ? pos(start.line + 1, 0) : pos(start.line, this.len(start.line));
						if (start.col < this.len(start.line) && this.lastNonBlankCol(start.line) < start.col) {
							p = pos(start.line, this.len(start.line));
						}
					}
				}
				return { pos: p };
			}
			case 'wordBackward': case 'WORDBackward': {
				let p = cur;
				for (let c = 0; c < n; c++) {
					p = this.wordBackward(p, name === 'WORDBackward');
				}
				return cmp(p, cur) === 0 && !forOperator ? undefined : { pos: p };
			}
			case 'wordEnd': case 'WORDEnd':
				return { pos: this.wordEnd(cur, name === 'WORDEnd', n, false), inclusive: true };
			case 'wordEndBackward': case 'WORDEndBackward':
				return { pos: this.wordEndBackward(cur, name === 'WORDEndBackward', n), inclusive: true };
			case 'repeatFind': case 'repeatFindReverse': {
				const lf = this.shared.lastFind;
				if (!lf) {
					return undefined;
				}
				let k = lf.key;
				if (name === 'repeatFindReverse') {
					k = k === 'f' ? 'F' : k === 'F' ? 'f' : k === 't' ? 'T' : 't';
				}
				return this.findInLine(cur, k, lf.char, n, true);
			}
			case 'matchBracket': {
				if (count !== undefined) {
					// {count}%: that percentage of the file
					if (n > 100) {
						return undefined;
					}
					const line = Math.max(0, Math.floor((n * (last + 1) + 99) / 100) - 1);
					return { pos: this.lineTarget(line), linewise: true, jump: true };
				}
				const r = this.matchBracket(cur);
				return r && { ...r, jump: true };
			}
			case 'unmatchedParenBackward': case 'unmatchedBraceBackward': case 'unmatchedParenForward': case 'unmatchedBraceForward': {
				const [open, close] = name.includes('Paren') ? ['(', ')'] : ['{', '}'];
				const back = name.endsWith('Backward');
				let p: VimPos | undefined = cur;
				for (let c = 0; c < n && p; c++) {
					const from: VimPos | undefined = c === 0 ? p : (back ? this.prevChar(p) : this.nextChar(p));
					p = from && (back ? this.enclosingOpen(from, open, close, c === 0) : this.enclosingClose(from, open, close, c === 0));
				}
				// `:help [(`: exclusive, both ways
				return p ? { pos: p, jump: true } : undefined;
			}
			case 'searchNext': case 'searchPrevious': {
				const ls = this.shared.lastSearch;
				if (!ls) {
					this.message = 'E35: No previous regular expression';
					return undefined;
				}
				const back = name === 'searchPrevious' ? !ls.backwards : ls.backwards;
				const q = this.lastSearchQuery()!;
				const r = this.searchMotion(q, back, cur, n);
				if (r) {
					this.highlight(q);
				}
				return r && { pos: r.pos, bigMotion: true, jump: true };
			}
			case 'searchWordForward': case 'searchWordBackward': case 'searchWordForwardPartial': case 'searchWordBackwardPartial': {
				const word = this.wordUnderCursor(cur);
				if (!word) {
					this.message = 'E348: No string under cursor';
					return undefined;
				}
				const backwards = name === 'searchWordBackward' || name === 'searchWordBackwardPartial';
				// VS Code's Match Whole Word, as Vim's \< \> (which also end a word where the script changes)
				const wholeWord = !name.endsWith('Partial') && isKeywordClass(charClassAt(word.text, 0, false));
				const pattern = escapeRegExpCharacters(word.text);
				this.shared.lastSearch = { pattern, backwards, wholeWord, exactCase: true };
				this.pushHistory('/', literalPattern(word.text, backwards ? '?' : '/'));
				const q = this.lastSearchQuery()!;
				// * starts from the start of the word under the cursor, so the next match is the next occurrence
				const from = backwards ? pos(cur.line, word.start) : cur;
				const r = this.searchMotion(q, backwards, from, n);
				if (r) {
					this.highlight(q);
				}
				return r && { pos: r.pos, bigMotion: true, jump: true };
			}
			case 'sentenceForward': case 'sentenceBackward': {
				let p = cur;
				for (let c = 0; c < n; c++) {
					const q = name === 'sentenceForward' ? this.nextSentence(p) : this.prevSentence(p);
					if (!q) {
						break;
					}
					p = q;
				}
				return cmp(p, cur) === 0 ? undefined : { pos: p, jump: true };
			}
			case 'paragraphForward': case 'paragraphBackward': {
				let line = cur.line;
				const fwd = name === 'paragraphForward';
				let end: VimPos | undefined;
				for (let c = 0; c < n; c++) {
					// from an empty line: past the empty lines; then to the next empty line
					let l = line;
					if (this.len(l) === 0) {
						while (l >= 0 && l <= last && this.len(l) === 0) {
							l += fwd ? 1 : -1;
						}
					}
					while (l >= 0 && l <= last && this.len(l) !== 0) {
						l += fwd ? 1 : -1;
					}
					if (l > last) {
						end = pos(last, Math.max(0, this.len(last) - (forOperator ? 0 : 1)));
						if (forOperator) {
							end = pos(last, this.len(last));
						}
						line = last;
						break;
					}
					if (l < 0) {
						end = pos(0, 0);
						line = 0;
						break;
					}
					line = l;
				}
				const p = end ?? pos(line, 0);
				return cmp(p, cur) === 0 ? undefined : { pos: p, jump: true, inclusive: end !== undefined && fwd && forOperator ? false : undefined };
			}
			case 'sectionForward': case 'sectionBackward': case 'sectionEndForward': case 'sectionEndBackward': {
				const fwd = name === 'sectionForward' || name === 'sectionEndForward';
				const mark = name === 'sectionForward' || name === 'sectionBackward' ? '{' : '}';
				let line = cur.line;
				for (let c = 0; c < n; c++) {
					let l = line + (fwd ? 1 : -1);
					while (l >= 0 && l <= last) {
						const t = this.host.lineText(l);
						if (t[0] === mark || t[0] === '\f') {
							break;
						}
						l += fwd ? 1 : -1;
					}
					if (l > last || l < 0) {
						line = l > last ? last : 0;
						break;
					}
					line = l;
				}
				const p = line === last && fwd && this.host.lineText(last)[0] !== mark ? pos(last, Math.max(0, this.len(last) - 1)) : pos(line, 0);
				return { pos: p, jump: true };
			}
			case 'mark': case 'markLine': {
				if (!ch) {
					this.invalid();
				}
				const m = this.getMark(ch);
				if (!m) {
					this.invalid('E20: Mark not set');
				}
				if (name === 'markLine') {
					return { pos: pos(m.line, this.firstNonBlank(m.line)), linewise: true, jump: true };
				}
				return { pos: m, jump: true };
			}
			case 'localDeclaration': case 'globalDeclaration': {
				const word = this.wordUnderCursor(cur);
				if (!word || !isKeywordClass(charClassAt(word.text, 0, false))) {
					return undefined;
				}
				// gD: the first match in the file; gd: from the start of the current "function" ([[, or an empty line above it)
				let from = 0;
				if (name === 'localDeclaration') {
					let l = cur.line;
					while (l > 0 && this.host.lineText(l)[0] !== '{') {
						l--;
					}
					while (l > 0 && this.len(l - 1) !== 0) {
						l--;
					}
					from = l;
				}
				this.shared.lastSearch = { pattern: escapeRegExpCharacters(word.text), backwards: false, wholeWord: true, exactCase: true };
				const q = this.lastSearchQuery()!;
				const m = this.host.findMatches(q, { start: pos(from, 0), end: pos(cur.line, this.len(cur.line)) }, 1)[0];
				if (m) {
					this.highlight(q);
					return { pos: m.range.start, jump: true };
				}
				return undefined;
			}
		}
		this.invalid(`Unknown motion: ${name}`);
	}

	private lastNonBlankCol(line: number): number {
		const m = /\S\s*$/.exec(this.host.lineText(line));
		return m ? m.index : -1;
	}

	/** A typed pattern as VS Code's find runs it ('ignorecase' / 'smartcase' decide the case; an invalid one is an error). */
	private query(pattern: string, opts: { wholeWord?: boolean; exactCase?: boolean; caseFlag?: 'i' | 'I' } = {}): VimSearchQuery {
		const err = regexError(pattern);
		if (err !== undefined) {
			this.invalid(`E383: Invalid search string: ${pattern} (${err})`);
		}
		const matchCase = opts.caseFlag ? opts.caseFlag === 'I' : opts.exactCase ? !this.options.ignorecase : patternMatchCase(pattern, this.options.ignorecase, this.options.smartcase);
		return { pattern, matchCase, wholeWord: opts.wholeWord === true };
	}

	/** The last search as a query (with the case options as they are now), or undefined. */
	private lastSearchQuery(): VimSearchQuery | undefined {
		const ls = this.shared.lastSearch;
		return ls && this.query(ls.pattern, { wholeWord: ls.wholeWord, exactCase: ls.exactCase });
	}

	private highlight(q: VimSearchQuery | undefined): void {
		if (!this.options.hlsearch || !q) {
			return;
		}
		this.host.highlightSearch(q);
		this.hlActive = true;
	}

	/**
	 * The next match after `from` (before it, backwards; at it too with
	 * `acceptAt`), as VS Code's Find Next / Find Previous finds it, wrapping
	 * around the file with 'wrapscan' only.
	 */
	private findMatch(q: VimSearchQuery, from: VimPos, backwards: boolean, acceptAt = false): VimMatch | undefined {
		if (backwards) {
			const m = this.host.findNextMatch(q, from, true);
			if (!m) {
				return undefined;
			}
			const wrapped = cmp(m.range.start, from) >= 0;
			return wrapped && !this.options.wrapscan ? undefined : m;
		}
		// Vim's forward search starts after the cursor: at the next character, or the next line
		const after = acceptAt ? from : from.col < this.len(from.line) ? pos(from.line, from.col + 1) : from.line < this.lastLine() ? pos(from.line + 1, 0) : pos(0, 0);
		const m = this.host.findNextMatch(q, after, false);
		if (!m) {
			return undefined;
		}
		const c = cmp(m.range.start, from);
		const wrapped = acceptAt ? c < 0 : c <= 0;
		return wrapped && !this.options.wrapscan ? undefined : m;
	}

	/** The match under the cursor or the next one (the previous one, backwards): what `gn` / `gN` select. */
	private matchAtOrNext(q: VimSearchQuery, cur: VimPos, backwards: boolean): VimMatch | undefined {
		const here = this.host.findMatches(q, { start: pos(cur.line, 0), end: pos(cur.line, this.len(cur.line)) }, 1000)
			.find(m => cmp(m.range.start, cur) <= 0 && cmp(cur, m.range.end) < 0);
		return here ?? this.findMatch(q, cur, backwards, !backwards);
	}

	/** `n` times to the next match; the last match found. */
	private searchMotion(q: VimSearchQuery, backwards: boolean, cur: VimPos, n: number): { pos: VimPos; match: VimMatch } | undefined {
		let p = cur;
		let found: VimMatch | undefined;
		for (let c = 0; c < n; c++) {
			found = this.findMatch(q, p, backwards, false);
			if (!found) {
				this.message = `E486: Pattern not found: ${q.pattern}`;
				return undefined;
			}
			p = found.range.start;
		}
		return found && { pos: p, match: found };
	}

	private wordUnderCursor(cur: VimPos): { text: string; start: number } | undefined {
		const text = this.host.lineText(cur.line);
		let c = cur.col;
		// the keyword under or after the cursor (in one script: 漢字 of 漢字かな); else the non-blank run
		let k = c;
		while (k < text.length && !isKeywordClass(charClassAt(text, k, false))) {
			k++;
		}
		if (k < text.length) {
			c = k;
			const cls = charClassAt(text, c, false);
			let s = c;
			let e = c;
			while (s > 0 && charClassAt(text, s - 1, false) === cls) {
				s--;
			}
			while (e < text.length && charClassAt(text, e, false) === cls) {
				e++;
			}
			return { text: text.slice(s, e), start: s };
		}
		while (c < text.length && isBlank(text[c])) {
			c++;
		}
		if (c >= text.length) {
			return undefined;
		}
		let s = c;
		let e = c;
		while (s > 0 && !isBlank(text[s - 1])) {
			s--;
		}
		while (e < text.length && !isBlank(text[e])) {
			e++;
		}
		return { text: text.slice(s, e), start: s };
	}

	private isEmptyLine(p: VimPos): boolean {
		return p.col === 0 && this.len(p.line) === 0;
	}

	private wordForward(start: VimPos, big: boolean): VimPos {
		let p = start;
		const cls = this.classAt(p, big);
		if (cls !== 0) {
			for (; ;) {
				const nx = this.nextChar(p);
				if (!nx) {
					return pos(p.line, this.len(p.line));
				}
				p = nx;
				if (this.classAt(p, big) !== cls) {
					break;
				}
			}
		}
		let moved = cmp(p, start) !== 0;
		while (this.classAt(p, big) === 0) {
			if (moved && this.isEmptyLine(p)) {
				break;
			}
			const nx = this.nextChar(p);
			if (!nx) {
				return pos(p.line, this.len(p.line));
			}
			p = nx;
			moved = true;
		}
		return p;
	}

	private wordBackward(start: VimPos, big: boolean): VimPos {
		const first = this.prevChar(start);
		if (!first) {
			return start;
		}
		let p: VimPos = first;
		while (this.classAt(p, big) === 0 && !this.isEmptyLine(p)) {
			const pv = this.prevChar(p);
			if (!pv) {
				return p;
			}
			p = pv;
		}
		if (this.isEmptyLine(p)) {
			return p;
		}
		const cls = this.classAt(p, big);
		for (; ;) {
			if (p.col === 0) {
				return p;
			}
			const pv = this.prevChar(p)!;
			if (this.classAt(pv, big) !== cls) {
				return p;
			}
			p = pv;
		}
	}

	/** End of the n-th word; `stayIfAtEnd` is the `cw` rule (count the current word). */
	private wordEnd(start: VimPos, big: boolean, n: number, stayIfAtEnd: boolean): VimPos {
		let p = start;
		for (let c = 0; c < n; c++) {
			if (!(stayIfAtEnd && c === 0 && this.classAt(p, big) !== 0)) {
				const nx = this.nextChar(p);
				if (!nx) {
					return p;
				}
				p = nx;
				while (this.classAt(p, big) === 0) {
					const nn = this.nextChar(p);
					if (!nn) {
						return this.clampNormal(p);
					}
					p = nn;
				}
			}
			const cls = this.classAt(p, big);
			for (; ;) {
				const nx = this.nextChar(p);
				if (!nx || nx.line !== p.line || this.classAt(nx, big) !== cls) {
					break;
				}
				p = nx;
			}
		}
		return p;
	}

	private wordEndBackward(start: VimPos, big: boolean, n: number): VimPos {
		let p = start;
		for (let c = 0; c < n; c++) {
			const cls = this.classAt(p, big);
			// leave the current word
			while (this.classAt(p, big) === cls && cls !== 0) {
				const pv = this.prevChar(p);
				if (!pv) {
					return p;
				}
				p = pv;
			}
			while (this.classAt(p, big) === 0 && !this.isEmptyLine(p)) {
				const pv = this.prevChar(p);
				if (!pv) {
					return p;
				}
				p = pv;
			}
		}
		return p;
	}

	private findInLine(cur: VimPos, key: string, ch: string, n: number, repeat: boolean): MotionResult | undefined {
		const text = this.host.lineText(cur.line);
		const forward = key === 'f' || key === 't';
		const till = key === 't' || key === 'T';
		let idx = cur.col;
		for (let c = 0; c < n; c++) {
			let from = forward ? idx + 1 : idx - 1;
			// A repeated `t` must not stick in front of the char it already reached.
			if (c === 0 && till && repeat) {
				from = forward ? idx + 2 : idx - 2;
			}
			idx = forward ? text.indexOf(ch, from) : (from < 0 ? -1 : text.lastIndexOf(ch, from));
			if (idx < 0) {
				return undefined;
			}
		}
		const col = till ? (forward ? idx - 1 : idx + 1) : idx;
		return { pos: pos(cur.line, col), inclusive: forward };
	}

	// ---- brackets, with Vim's rule for quotes: brackets in a "string" on the
	// line do not count, unless the search starts inside one ----------------

	/** Columns of `line` inside double-quoted strings (only when the quotes on the line balance). */
	private quotedMask(line: number): boolean[] | undefined {
		const text = this.host.lineText(line);
		if (!text.includes('"')) {
			return undefined;
		}
		const mask: boolean[] = new Array(text.length).fill(false);
		let inq = false;
		let quotes = 0;
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (c === '\\' && inq) {
				mask[i] = true;
				if (i + 1 < text.length) {
					mask[i + 1] = true;
				}
				i++;
				continue;
			}
			if (c === '"') {
				quotes++;
				inq = !inq;
				mask[i] = true;
				continue;
			}
			mask[i] = inq;
		}
		return quotes % 2 === 0 ? mask : undefined;
	}

	/** Whether the bracket at `p` is a character literal like '{' (skipped, as Vim does). */
	private isCharLiteral(text: string, col: number): boolean {
		return (text[col - 1] === '\'' && text[col + 1] === '\'') || (text[col - 2] === '\'' && text[col - 1] === '\\' && text[col + 1] === '\'');
	}

	private matchBracket(cur: VimPos): MotionResult | undefined {
		const text = this.host.lineText(cur.line);
		let col = cur.col;
		while (col < text.length && !'()[]{}'.includes(text[col])) {
			col++;
		}
		if (col >= text.length) {
			return undefined;
		}
		const ch = text[col];
		const [open, close] = BRACKETS[ch];
		const found = this.scanBracket(pos(cur.line, col), open, close, ch === open);
		return found ? { pos: found, inclusive: true, bigMotion: true } : undefined;
	}

	/** From a bracket at `from`, find its partner, walking lines lazily. */
	private scanBracket(from: VimPos, open: string, close: string, forward: boolean): VimPos | undefined {
		let depth = 0;
		const last = this.lastLine();
		const startMask = this.quotedMask(from.line);
		const inQuote = !!startMask?.[from.col];
		for (let line = from.line; forward ? line <= last : line >= 0; line += forward ? 1 : -1) {
			const text = this.host.lineText(line);
			const mask = inQuote ? undefined : (line === from.line ? startMask : this.quotedMask(line));
			let col = line === from.line ? from.col : (forward ? 0 : text.length - 1);
			for (; forward ? col < text.length : col >= 0; col += forward ? 1 : -1) {
				const c = text[col];
				if ((c !== open && c !== close) || mask?.[col] || (this.isCharLiteral(text, col) && !(line === from.line && col === from.col))) {
					continue;
				}
				if (c === (forward ? open : close)) {
					depth++;
				} else {
					depth--;
					if (depth === 0) {
						return pos(line, col);
					}
				}
			}
		}
		return undefined;
	}

	/** Unmatched `open` before `cur` (or at it, when `atCursor`). */
	private enclosingOpen(cur: VimPos, open: string, close: string, atCursor = true): VimPos | undefined {
		if (atCursor && this.charAt(cur) === open) {
			return cur;
		}
		let depth = 0;
		const startMask = this.quotedMask(cur.line);
		const inQuote = !!startMask?.[cur.col];
		let line = cur.line;
		let text = this.host.lineText(line);
		let mask = inQuote ? undefined : startMask;
		let col = this.charAt(cur) === close && atCursor ? cur.col - 1 : cur.col - (atCursor ? 0 : 0);
		if (!atCursor) {
			col = cur.col;
		}
		for (; ;) {
			for (; col >= 0; col--) {
				const c = text[col];
				if ((c !== open && c !== close) || mask?.[col] || this.isCharLiteral(text, col)) {
					continue;
				}
				if (c === close) {
					depth++;
				} else if (depth === 0) {
					return pos(line, col);
				} else {
					depth--;
				}
			}
			if (--line < 0) {
				return undefined;
			}
			text = this.host.lineText(line);
			mask = inQuote ? undefined : this.quotedMask(line);
			col = text.length - 1;
		}
	}

	/** Unmatched `close` after `cur` (or at it, when `atCursor`). */
	private enclosingClose(cur: VimPos, open: string, close: string, atCursor = true): VimPos | undefined {
		if (atCursor && this.charAt(cur) === close) {
			return cur;
		}
		let depth = 0;
		const last = this.lastLine();
		const startMask = this.quotedMask(cur.line);
		const inQuote = !!startMask?.[cur.col];
		let line = cur.line;
		let text = this.host.lineText(line);
		let mask = inQuote ? undefined : startMask;
		let col = this.charAt(cur) === open && atCursor ? cur.col + 1 : cur.col;
		for (; ;) {
			for (; col < text.length; col++) {
				const c = text[col];
				if ((c !== open && c !== close) || mask?.[col] || this.isCharLiteral(text, col)) {
					continue;
				}
				if (c === open) {
					depth++;
				} else if (depth === 0) {
					return pos(line, col);
				} else {
					depth--;
				}
			}
			if (++line > last) {
				return undefined;
			}
			text = this.host.lineText(line);
			mask = inQuote ? undefined : this.quotedMask(line);
			col = 0;
		}
	}

	// ---- sentences ------------------------------------------------------------

	/** Whether a sentence starts at `p` (`:help sentence`). */
	private isSentenceStart(p: VimPos): boolean {
		const text = this.host.lineText(p.line);
		if (text.length === 0) {
			return p.line === 0 || this.len(p.line - 1) !== 0;
		}
		if (p.col >= text.length || isBlank(text[p.col])) {
			return false;
		}
		// walk back over white space (and line breaks)
		let q = this.prevChar(p);
		let white = false;
		while (q) {
			if (this.len(q.line) === 0) {
				return true; // after an empty line (a paragraph boundary)
			}
			const c = this.charAt(q);
			if (c !== '\n' && !isBlank(c)) {
				break;
			}
			white = true;
			q = this.prevChar(q);
		}
		if (!q) {
			return true; // start of the file
		}
		if (!white) {
			return false;
		}
		let t = q;
		while (')]"\''.includes(this.charAt(t))) {
			const pv = this.prevChar(t);
			if (!pv || pv.line !== t.line) {
				return false;
			}
			t = pv;
		}
		return '.!?'.includes(this.charAt(t));
	}

	private nextSentence(p: VimPos): VimPos | undefined {
		let q = this.nextChar(p);
		let guard = 0;
		while (q && guard++ < 100000) {
			if (q.col <= this.len(q.line) && (q.col < this.len(q.line) || this.len(q.line) === 0) && this.isSentenceStart(q)) {
				return q;
			}
			q = this.nextChar(q);
		}
		const last = this.lastLine();
		return pos(last, Math.max(0, this.len(last) - 1));
	}

	private prevSentence(p: VimPos): VimPos | undefined {
		let q = this.prevChar(p);
		let guard = 0;
		while (q && guard++ < 100000) {
			if ((q.col < this.len(q.line) || this.len(q.line) === 0) && this.isSentenceStart(q)) {
				return q;
			}
			q = this.prevChar(q);
		}
		return pos(0, 0);
	}

	// ---- text objects -------------------------------------------------------

	private textObject(ch: string, around: boolean, count: number, cur: VimPos): Range | undefined {
		switch (ch) {
			case 'w': case 'W':
				return this.wordObject(around, ch === 'W', count, cur);
			case 's':
				return this.sentenceObject(around, count, cur);
			case 'p':
				return this.paragraphObject(around, count, cur);
			case 't':
				return this.tagObject(around, count, cur);
			case 'gc':
				return this.commentObject(cur);
			case 'gn': case 'gN': {
				const ls = this.shared.lastSearch;
				if (!ls) {
					this.message = 'E35: No previous regular expression';
					return undefined;
				}
				const q = this.lastSearchQuery()!;
				// gn: the match under the cursor, or the next one
				const found = this.matchAtOrNext(q, cur, ch === 'gN');
				if (!found) {
					this.message = `E486: Pattern not found: ${ls.pattern}`;
					return undefined;
				}
				this.highlight(q);
				return { start: found.range.start, end: found.range.end, linewise: false };
			}
		}
		if (QUOTES.has(ch)) {
			return this.quoteObject(around, ch, cur);
		}
		const pair = BRACKETS[ch];
		if (pair) {
			let p: VimPos | undefined = cur;
			let openPos: VimPos | undefined;
			for (let c = 0; c < count && p; c++) {
				openPos = this.enclosingOpen(p, pair[0], pair[1], c === 0);
				p = openPos ? this.prevChar(openPos) : undefined;
				if (openPos && c + 1 < count) {
					p = openPos;
					const pv = this.prevChar(openPos);
					p = pv;
					if (!pv) {
						openPos = undefined;
					}
				}
			}
			if (!openPos) {
				return undefined;
			}
			const closePos = this.scanBracket(openPos, pair[0], pair[1], true);
			if (!closePos) {
				return undefined;
			}
			if (around) {
				return { start: openPos, end: pos(closePos.line, closePos.col + 1), linewise: false };
			}
			let start = pos(openPos.line, openPos.col + 1);
			const end = closePos;
			// `{` at line end and `}` alone on its line: the inner lines, linewise.
			if (start.col === this.len(start.line) && start.line < end.line && this.firstNonBlank(end.line) === end.col) {
				if (end.line - start.line < 2) {
					return { start: pos(start.line + 1, 0), end: pos(start.line + 1, 0), linewise: false };
				}
				return { start: pos(start.line + 1, 0), end: pos(end.line - 1, this.len(end.line - 1)), linewise: true };
			}
			if (start.col === this.len(start.line) && start.line < end.line) {
				start = pos(start.line + 1, 0);
			}
			if (cmp(start, end) > 0) {
				start = end;
			}
			return { start, end, linewise: false };
		}
		return undefined;
	}

	/** `iw` / `aw` with a count: `2iw` is a word and the blanks after it, `2aw` two words with their blanks (within the line). */
	private wordObject(around: boolean, big: boolean, count: number, cur: VimPos): Range | undefined {
		const text = this.host.lineText(cur.line);
		if (text.length === 0) {
			return undefined;
		}
		const col = Math.min(cur.col, text.length - 1);
		const cls = charClassAt(text, col, big);
		let s = col;
		let e = col + 1;
		while (s > 0 && charClassAt(text, s - 1, big) === cls) {
			s--;
		}
		while (e < text.length && charClassAt(text, e, big) === cls) {
			e++;
		}
		if (around) {
			if (cls === 0) {
				// on blanks: blanks plus the following word
				if (e < text.length) {
					const c2 = charClassAt(text, e, big);
					while (e < text.length && charClassAt(text, e, big) === c2) {
						e++;
					}
				}
			} else {
				const e0 = e;
				while (e < text.length && charClassAt(text, e, big) === 0) {
					e++;
				}
				if (e === e0) {
					// no white space after the word: take the white space before it (not the indent)
					let s2 = s;
					while (s2 > 0 && charClassAt(text, s2 - 1, big) === 0) {
						s2--;
					}
					if (s2 > 0) {
						s = s2;
					}
				}
			}
		}
		const run = (from: number): number => {
			const c = charClassAt(text, from, big);
			let to = from;
			while (to < text.length && charClassAt(text, to, big) === c) {
				to++;
			}
			return to;
		};
		for (let c = 1; c < count && e < text.length; c++) {
			e = run(e);
			if (around && e < text.length && charClassAt(text, e - 1, big) !== 0) {
				if (charClassAt(text, e, big) === 0) {
					e = run(e);
				}
			} else if (around && e < text.length) {
				e = run(e);
			}
		}
		return { start: pos(cur.line, s), end: pos(cur.line, e), linewise: false };
	}

	/** `is` / `as`. */
	private sentenceObject(around: boolean, count: number, cur: VimPos): Range | undefined {
		const isWhite = (p: VimPos) => {
			const c = this.charAt(p);
			return c === '\n' || isBlank(c);
		};
		let start: VimPos;
		let end: VimPos;
		if (isWhite(cur) && !this.isEmptyLine(cur)) {
			// on white space between sentences
			let s = cur;
			let pv = this.prevChar(s);
			while (pv && isWhite(pv) && !this.isEmptyLine(pv)) {
				s = pv;
				pv = this.prevChar(s);
			}
			let e = cur;
			while (isWhite(e) && !this.isEmptyLine(e)) {
				const nx = this.nextChar(e);
				if (!nx) {
					break;
				}
				e = nx;
			}
			start = s;
			end = e;
			if (around) {
				const next = this.nextSentence(e) ?? e;
				end = this.sentenceTextEnd(e, next);
			}
			return { start, end, linewise: false };
		}
		start = this.isSentenceStart(cur) ? cur : (this.prevSentence(cur) ?? pos(0, 0));
		let next = this.nextSentence(cur) ?? cur;
		for (let c = 1; c < count; c++) {
			next = this.nextSentence(next) ?? next;
		}
		end = this.sentenceTextEnd(start, next);
		if (around) {
			if (cmp(end, next) < 0 && isWhite(end)) {
				// the white space after it
				let e = end;
				while (cmp(e, next) < 0 && isWhite(e) && !this.isEmptyLine(e)) {
					const nx = this.nextChar(e);
					if (!nx) {
						break;
					}
					e = nx;
				}
				end = e;
			} else {
				// none after it: the white space before it
				let s = start;
				let pv = this.prevChar(s);
				while (pv && isWhite(pv) && !this.isEmptyLine(pv) && pv.col < this.len(pv.line)) {
					s = pv;
					pv = this.prevChar(s);
				}
				start = s;
			}
		}
		return { start, end, linewise: false };
	}

	/** The end (exclusive) of the sentence text that starts at `start` and is followed by `next`: before its trailing white space. */
	private sentenceTextEnd(start: VimPos, next: VimPos): VimPos {
		const lastL = this.lastLine();
		if (cmp(next, start) <= 0 || (next.line === lastL && next.col >= Math.max(0, this.len(lastL) - 1) && !this.isSentenceStart(next))) {
			return pos(lastL, this.len(lastL));
		}
		let e = next;
		let pv = this.prevChar(e);
		while (pv && cmp(pv, start) >= 0) {
			const c = this.charAt(pv);
			if (c !== '\n' && !isBlank(c) && !this.isEmptyLine(pv)) {
				break;
			}
			e = pv;
			pv = this.prevChar(e);
		}
		return e;
	}

	/** `ip` / `ap` (blank lines with white space count as empty, as for these objects). */
	private paragraphObject(around: boolean, count: number, cur: VimPos): Range | undefined {
		const last = this.lastLine();
		const blank = (l: number) => this.host.lineText(l).trim() === '';
		let s = cur.line;
		const kind = blank(s);
		while (s > 0 && blank(s - 1) === kind) {
			s--;
		}
		let e = cur.line;
		const runEnd = (from: number) => {
			const k = blank(from);
			let x = from;
			while (x < last && blank(x + 1) === k) {
				x++;
			}
			return x;
		};
		e = runEnd(cur.line);
		let runs = around ? 2 * count : count;
		runs--;
		let usedBlankAfter = kind;
		while (runs > 0 && e < last) {
			e = runEnd(e + 1);
			if (blank(e)) {
				usedBlankAfter = true;
			}
			runs--;
		}
		if (around && !usedBlankAfter && !kind) {
			// no blank lines after the paragraph: the ones before it
			while (s > 0 && blank(s - 1)) {
				s--;
			}
		}
		return { start: pos(s, 0), end: pos(e, this.len(e)), linewise: true };
	}

	/** `it` / `at`: the innermost tag pair around the cursor (within 1000 lines of it). */
	private tagObject(around: boolean, count: number, cur: VimPos): Range | undefined {
		const from = Math.max(0, cur.line - 1000);
		const to = Math.min(this.lastLine(), cur.line + 1000);
		const lineStarts: number[] = [];
		let text = '';
		for (let l = from; l <= to; l++) {
			lineStarts.push(text.length);
			text += this.host.lineText(l) + '\n';
		}
		const offset = lineStarts[cur.line - from] + cur.col;
		const toPos = (o: number): VimPos => {
			let lo = 0;
			let hi = lineStarts.length - 1;
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1;
				if (lineStarts[mid] <= o) {
					lo = mid;
				} else {
					hi = mid - 1;
				}
			}
			return pos(from + lo, o - lineStarts[lo]);
		};
		const re = /<(\/?)([A-Za-z][\w:.-]*)(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?(\/?)>/g;
		const stack: { name: string; start: number; end: number }[] = [];
		const pairs: { os: number; oe: number; cs: number; ce: number }[] = [];
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			if (m[3]) {
				continue; // <br/>
			}
			if (!m[1]) {
				stack.push({ name: m[2], start: m.index, end: m.index + m[0].length });
			} else {
				for (let k = stack.length - 1; k >= 0; k--) {
					if (stack[k].name === m[2]) {
						const o = stack[k];
						pairs.push({ os: o.start, oe: o.end, cs: m.index, ce: m.index + m[0].length });
						stack.length = k;
						break;
					}
				}
			}
		}
		const around2 = pairs.filter(p => p.os <= offset && offset < p.ce).sort((a, b) => (b.os - a.os));
		const pair = around2[count - 1];
		if (!pair) {
			return undefined;
		}
		if (around) {
			return { start: toPos(pair.os), end: toPos(pair.ce), linewise: false };
		}
		return { start: toPos(pair.oe), end: toPos(pair.cs), linewise: false };
	}

	/** `gc` after an operator: the block of commented lines around the cursor. */
	private commentObject(cur: VimPos): Range | undefined {
		const token = this.host.lineComment();
		if (!token) {
			return undefined;
		}
		const commented = (l: number) => this.host.lineText(l).trimStart().startsWith(token);
		if (!commented(cur.line)) {
			return undefined;
		}
		let s = cur.line;
		let e = cur.line;
		while (s > 0 && commented(s - 1)) {
			s--;
		}
		while (e < this.lastLine() && commented(e + 1)) {
			e++;
		}
		return { start: pos(s, 0), end: pos(e, this.len(e)), linewise: true };
	}

	private quoteObject(around: boolean, q: string, cur: VimPos): Range | undefined {
		const text = this.host.lineText(cur.line);
		const quotes: number[] = [];
		for (let c = 0; c < text.length; c++) {
			if (text[c] === '\\') {
				c++;
				continue;
			}
			if (text[c] === q) {
				quotes.push(c);
			}
		}
		let pair: [number, number] | undefined;
		for (let j = 0; j + 1 < quotes.length; j += 2) {
			if (quotes[j] <= cur.col && cur.col <= quotes[j + 1]) {
				pair = [quotes[j], quotes[j + 1]];
				break;
			}
		}
		if (!pair) {
			for (let j = 0; j + 1 < quotes.length; j += 2) {
				if (quotes[j] > cur.col) {
					pair = [quotes[j], quotes[j + 1]];
					break;
				}
			}
		}
		if (!pair) {
			return undefined;
		}
		if (!around) {
			return { start: pos(cur.line, pair[0] + 1), end: pos(cur.line, pair[1]), linewise: false };
		}
		let e = pair[1] + 1;
		let s = pair[0];
		if (e < text.length && /\s/.test(text[e])) {
			while (e < text.length && /\s/.test(text[e])) {
				e++;
			}
		} else {
			while (s > 0 && /\s/.test(text[s - 1])) {
				s--;
			}
			if (s > 0 && !text.slice(0, s).trim()) {
				s = pair[0];
			}
		}
		return { start: pos(cur.line, s), end: pos(cur.line, e), linewise: false };
	}

	// ---- the `:` / `/` prompt ----------------------------------------------

	private cmdCmdline(kind: string): void {
		if ((kind !== ':' && kind !== '/' && kind !== '?') || this.textObjectKind || this.cmdline) {
			this.invalid();
		}
		const origin = this.isVisual() ? this.visualHead : this.cursor();
		if (kind === ':') {
			let text = '';
			if (this.isVisual()) {
				// as in Vim, `:` from visual mode is for the selected lines
				this.leaveVisual(this.visualHead);
				text = '\'<,\'>';
			} else if (this.operator) {
				this.invalid();
			} else {
				const n = this.effectiveCount();
				if (n !== undefined) {
					text = n === 1 ? '.' : `.,.+${n - 1}`;
				}
			}
			this.resetGrammar();
			this.cmdline = { kind, text, origin, id: ++cmdlineSequence };
			return;
		}
		// The operator, count and register wait for the search (`d/foo<CR>`).
		this.cmdline = { kind, text: '', origin, id: ++cmdlineSequence };
	}

	/** The prompt is gone; `submitted`: its line runs next, so the view the 'incsearch' preview scrolled to stays. */
	private closeCmdline(submitted = false): void {
		if (this.cmdline && this.cmdline.kind !== ':') {
			this.host.showIncSearch(undefined, submitted);
		} else if (this.cmdline) {
			this.host.previewSubstitute(undefined);
		}
		this.cmdline = undefined;
		this.fedPrompt = undefined;
	}

	private pushHistory(kind: ':' | '/', text: string): void {
		if (!text) {
			return;
		}
		const h = this.shared.history[kind];
		const i = h.indexOf(text);
		if (i >= 0) {
			h.splice(i, 1);
		}
		h.push(text);
		if (h.length > 100) {
			h.shift();
		}
	}

	/** 'incsearch': show where the pattern typed so far matches; 'inccommand': what the `:s` typed so far would do. */
	private updateIncSearch(): void {
		const cl = this.cmdline;
		if (cl?.kind === ':') {
			if (this.shared.inccommand === 'nosplit') {
				this.host.previewSubstitute(() => this.cmdline === cl ? this.substitutePreview(cl.text) : undefined);
			}
			return;
		}
		if (!cl || !this.options.incsearch) {
			return;
		}
		if (!cl.text) {
			this.host.showIncSearch(undefined);
			return;
		}
		const { pattern } = splitSearchOffset(cl.text, cl.kind);
		if (regexError(pattern) !== undefined) {
			// half typed (`(foo`): nothing to show yet, and no error
			this.host.showIncSearch(undefined);
			return;
		}
		this.host.showIncSearch(this.findMatch(this.query(pattern), cl.origin, cl.kind === '?')?.range);
	}

	private cmdSearch(text: string, backwards: boolean, count?: number): void {
		const op = this.operator;
		const { pattern: typed, offset } = splitSearchOffset(text, backwards ? '?' : '/');
		const pattern = typed || this.shared.lastSearch?.pattern;
		if (!pattern) {
			if (op) {
				this.invalid('E35: No previous regular expression');
			}
			this.message = 'E35: No previous regular expression';
			this.complete(undefined);
			return;
		}
		this.pushHistory('/', text || pattern);
		// `//` searches for the last pattern as it was (a `*` one by whole word)
		this.shared.lastSearch = typed ? { pattern, backwards, offset } : { ...this.shared.lastSearch!, backwards, offset };
		const cur = this.cursor();
		const q = this.lastSearchQuery()!;
		const found = this.searchMotion(q, backwards, cur, count ?? this.effectiveCount() ?? 1);
		if (!found) {
			if (op) {
				this.invalid(this.message);
			}
			const msg = this.message;
			this.complete(undefined);
			this.message = msg;
			return;
		}
		const res: MotionResult = { pos: found.pos, bigMotion: true };
		this.highlight(q);
		if (offset) {
			const m = /^([esb]?)([+-]?\d*)$/.exec(offset);
			if (m) {
				const n = m[2] === '' || m[2] === '+' || m[2] === '-' ? (m[2] === '-' ? -1 : m[2] === '+' ? 1 : 0) : Number(m[2]);
				if (!m[1]) {
					const line = this.clampLine(res.pos.line + n);
					res.pos = pos(line, this.firstNonBlank(line));
					res.linewise = n !== 0 || offset !== '';
				} else if (m[1] === 'e') {
					const end = this.prevChar(found.match.range.end) ?? found.match.range.end;
					res.pos = this.clampNormal(pos(end.line, end.col + n));
					res.inclusive = true;
				} else {
					res.pos = this.clampNormal(pos(res.pos.line, res.pos.col + n));
				}
			}
		}
		if (op) {
			const change = op === 'y' ? undefined : this.snapshot();
			const range = this.motionRange(cur, res);
			range.bigMotion = true;
			this.applyOperator(op, this.register, range, cur, change);
			this.completeOperator(op, change);
			return;
		}
		this.moveTo({ ...res, jump: true }, cur);
		this.complete(undefined);
	}

	// ---- ex commands ------------------------------------------------------------

	/**
	 * Where the addresses of an ex line point, for resolveExRange: the cursor,
	 * the marks, the last visual area, and VS Code's find for `/pat/` (which
	 * becomes the last search only with `remember`: not while 'inccommand'
	 * previews the line).
	 */
	private exAddressContext(cur: VimPos, remember: boolean): ExAddressContext {
		return {
			cursorLine: cur.line,
			lastLine: this.lastLine(),
			visual: this.lastVisual ? { start: this.getMark('<')!.line, end: this.getMark('>')!.line } : undefined,
			mark: (name: string) => this.getMark(name)?.line,
			search: (pattern: string, backwards: boolean, fromLine: number) => {
				const last = this.shared.lastSearch;
				const pat = pattern || last?.pattern;
				if (!pat) {
					return undefined;
				}
				const ls = pattern ? { pattern: pat, backwards } : { ...last!, backwards };
				if (remember) {
					this.shared.lastSearch = ls;
				}
				const q = this.query(ls.pattern, { wholeWord: ls.wholeWord, exactCase: ls.exactCase });
				const found = this.findMatch(q, backwards ? pos(fromLine, 0) : pos(fromLine, this.len(fromLine)), backwards);
				return found?.range.start.line;
			},
		};
	}

	/** > 0 while an ex line runs another (:g, :@, a `|`): only the line typed is `@:`'s. */
	private exDepth = 0;

	/**
	 * An ex line (common/vimEx.ts parseExCommands): each command in turn, the
	 * ones after a `|` once the one before has finished (a VS Code command
	 * included, see `sequence`), and none after one that failed (Vim's
	 * E... message is shown). The engine's own changes on the line are one undo
	 * step.
	 */
	private runEx(line: string): void {
		if (!line.trim()) {
			return;
		}
		if (!this.exDepth && !this.replaying && !this.playingMacro && !/^\s*@:?\s*$/.test(line)) {
			this.shared.lastEx = line;
		}
		const cmds = parseExCommands(line, this.shared.registry);
		const state = { failed: false };
		this.sequence(cmds.map(p => () => {
			if (state.failed) {
				return false;
			}
			this.exDepth++;
			try {
				if (!this.runExCommand(p, state)) {
					state.failed = true;
				}
			} finally {
				this.exDepth--;
			}
			return !state.failed;
		}), undefined, true);
	}

	/**
	 * One command of an ex line. Vim's editing commands run here, on the
	 * buffer; the others run their steps (VS Code commands, each awaited). A
	 * bare range moves to its last line. With a typed range a command that
	 * takes one runs with its lines selected (so a command that works on the
	 * selection, such as sorting, gets them), then the caret goes back to the
	 * range's first line. Returns false when it failed (the message says why).
	 */
	private runExCommand(p: ParsedExCommand, state: { failed: boolean }): boolean {
		if (p.error) {
			this.message = p.error;
			return false;
		}
		const cur = this.cursor();
		let range: { start: number; end: number } | undefined;
		if (p.range) {
			range = resolveExRange(p, this.exAddressContext(cur, true));
			if (!range) {
				this.message = p.range.some(r => r.startsWith('\'')) ? 'E20: Mark not set' : 'E16: Invalid range';
				return false;
			}
		}
		if (!p.spec) {
			if (range) {
				// :{n} - with 'nostartofline' the column is kept
				const target = this.lineTarget(range.end);
				this.jumpFrom(cur);
				this.setNormalCursor(target, !this.options.startofline);
			}
			return true;
		}
		const spec = p.spec;
		if (spec.engine) {
			this.message = '';
			this.runEngineEx(spec.engine, range, p.bang, RAW_ARG_COMMANDS.has(spec.engine) ? p.args : p.args.trim(), cur);
			return !/^E\d+:/.test(this.message);
		}
		const inv = exInvocation(spec, p, range, cur.line, this.lastLine());
		const steps = expandExSpec(spec, inv);
		const select = range && inv.range ? { start: inv.range.start - 1, end: inv.range.end - 1 } : undefined;
		if (select) {
			this.host.setSelection(pos(select.start, 0), pos(select.end, this.len(select.end)), false);
		}
		this.runSteps(steps, select ? () => {
			if (this._mode === 'normal') {
				const l = Math.min(select.start, this.lastLine());
				this.setNormalCursor(pos(l, this.firstNonBlank(l)));
			}
		} : undefined, () => state.failed = true);
		return true;
	}

	/**
	 * Engine work that waits for something asynchronous (a VS Code command, a
	 * filter): what is sequenced after it (the rest of a macro, of a `:g`, of a
	 * `|` line, of `:normal`'s keys) waits for this. Undefined when nothing
	 * runs.
	 */
	private waiting: Promise<void> | undefined;

	/** `p` runs on its own; what `sequence` puts after it waits for it to settle. */
	private wait(p: Promise<unknown>): void {
		const w: Promise<void> = p.then(() => undefined, () => undefined).finally(() => {
			if (this.waiting === w) {
				this.waiting = undefined;
			}
		});
		this.waiting = w;
	}

	/**
	 * Run `items` in order: at once, one after another, as long as none starts
	 * something asynchronous (`wait`); after one that does, the rest run once
	 * it has settled (and the sequence itself is then what a sequence it is part
	 * of waits for). An item that returns false ends it. `finish` runs after
	 * the last. With `oneUndo`, the engine's changes in each run of items are
	 * one undo step (VS Code commands make their own).
	 */
	private sequence(items: readonly (() => boolean | void)[], finish?: () => void, oneUndo = false): void {
		let i = 0;
		let done: (() => void) | undefined;
		const segment = (): void => {
			let suspended = false;
			if (oneUndo) {
				this.changeBatch++;
			}
			try {
				while (i < items.length) {
					const before = this.waiting;
					let go: boolean | void;
					try {
						go = items[i++]();
					} catch (err) {
						this.recover(err);
						go = false;
					}
					if (go === false) {
						i = items.length;
						break;
					}
					const w = this.waiting;
					if (w && w !== before && i < items.length) {
						suspended = true;
						if (!done) {
							const all = new Promise<void>(r => done = r);
							void w.then(() => this.resume(segment));
							this.wait(all);
						} else {
							void w.then(() => this.resume(segment));
						}
						return;
					}
				}
			} finally {
				if (oneUndo) {
					this.changeBatch--;
					this.closeChange();
				}
				if (!suspended) {
					try {
						finish?.();
					} catch (err) {
						this.recover(err);
					}
					done?.();
				}
			}
		};
		segment();
	}

	/** The rest of a sequence, after what it waited for. */
	private resume(segment: () => void): void {
		try {
			segment();
		} catch (err) {
			this.recover(err);
		} finally {
			this.host.refresh();
		}
	}

	/** Vim's own ex commands. */
	private runEngineEx(name: string, range: { start: number; end: number } | undefined, bang: boolean, args: string, cur: VimPos): void {
		const r = range ?? { start: cur.line, end: cur.line };
		// a trailing count: `:d 3` is 3 lines from the range's last line
		const withCount = (rest: string): { start: number; end: number; rest: string } => {
			const m = /^(.*?)\s*(\d+)\s*$/.exec(rest);
			if (m && !/^\d/.test(rest.trim()) === false) {
				// only a number: it is the count
			}
			if (m) {
				const n = Number(m[2]);
				return { start: r.end, end: this.clampLine(r.end + n - 1), rest: m[1] };
			}
			return { ...r, rest };
		};
		switch (name) {
			case 'nohlsearch':
				this.hlActive = false;
				this.host.highlightSearch(undefined);
				return;
			case 'substitute': case '&': case '&&': case '~':
				this.exSubstitute(name, r, args);
				return;
			case 'global': case 'vglobal':
				this.exGlobal(name === 'vglobal' || bang, range ?? { start: 0, end: this.lastLine() }, args);
				return;
			case 'delete': case 'yank': {
				let reg: string | undefined;
				let rest = args;
				const m = /^([a-zA-Z0-9"_+*-])(?:\s+|$)/.exec(rest);
				if (m && !/^\d+$/.test(rest)) {
					reg = m[1];
					rest = rest.slice(m[0].length);
				}
				const w = withCount(rest);
				const text = this.linesText(w.start, w.end);
				if (name === 'yank') {
					this.storeRegister(reg, text, 'line', 'yank');
					return;
				}
				this.storeRegister(reg, text, 'line', 'delete');
				this.deleteLines(w.start, w.end);
				return;
			}
			case 'move': case 'copy': {
				const dest = this.exAddress(args, cur);
				if (dest === undefined) {
					this.message = 'E14: Invalid address';
					return;
				}
				const text = this.linesText(r.start, r.end);
				const n = r.end - r.start + 1;
				if (name === 'move') {
					if (dest >= r.start && dest < r.end) {
						this.message = 'E134: Cannot move a range of lines into itself';
						return;
					}
					if (dest === r.end || dest === r.start - 1) {
						return;
					}
					this.changeBatch++;
					try {
						this.insertLinesAfter(dest, text);
						const shift = dest < r.start ? n : 0;
						this.deleteLines(r.start + shift, r.end + shift);
					} finally {
						this.changeBatch--;
						this.closeChange();
					}
					const lastMoved = dest < r.start ? dest + n : dest;
					this.setNormalCursor(pos(lastMoved, this.firstNonBlank(lastMoved)));
					return;
				}
				this.insertLinesAfter(dest, text);
				this.closeChange();
				const lastCopied = dest + n;
				this.setNormalCursor(pos(lastCopied, this.firstNonBlank(lastCopied)));
				return;
			}
			case 'join': {
				const w = withCount(args.replace(/^\s*$/, ''));
				let start = w.start;
				let end = w.end;
				if (range && range.start === range.end && !/\d/.test(args)) {
					end = range.start + 1;
				} else if (!range && !/\d/.test(args)) {
					end = start + 1;
				} else if (range && /\d/.test(args)) {
					start = range.end;
				}
				if (end > this.lastLine()) {
					end = this.lastLine();
				}
				if (end <= start) {
					return;
				}
				this.join(start, end - start + 1, !bang);
				this.setNormalCursor(pos(start, this.firstNonBlank(start)));
				return;
			}
			case '<': case '>': {
				const extra = (/^[<>]*/.exec(args)?.[0].length ?? 0) + 1;
				const w = withCount(args.replace(/^[<>]*/, ''));
				this.shift(w.start, w.end, name === '>', extra);
				this.closeChange();
				const l = w.end;
				this.setNormalCursor(pos(l, this.firstNonBlank(l)));
				return;
			}
			case 'put': {
				const reg = args.trim()[0];
				const value = this.readRegister(reg);
				if (!value) {
					this.message = `E353: Nothing in register ${reg ?? '"'}`;
					return;
				}
				const line = range ? range.end : cur.line;
				const text = value.text;
				if (bang) {
					this.edit([{ start: pos(line, 0), end: pos(line, 0), text: text + '\n' }]);
				} else {
					this.insertLinesAfter(line, text);
				}
				this.closeChange();
				const lastPut = bang ? line + text.split('\n').length - 1 : line + text.split('\n').length;
				this.setNormalCursor(pos(lastPut, this.firstNonBlank(lastPut)));
				return;
			}
			case 'normal': {
				if (!args) {
					return;
				}
				// the keys go one after another, each after what the one before started (sequence)
				if (!range) {
					this.feedKeys(args, () => this.endFeed());
					return;
				}
				this.forLines(r.start, r.end, () => this.feedKeys(args, () => this.endFeed()));
				return;
			}
			case 'sort':
				this.exSort(range ?? { start: 0, end: this.lastLine() }, bang, args);
				return;
			case 'undo':
				this.host.undo();
				return;
			case 'redo':
				this.host.redo();
				return;
			case 'mark': {
				const m = args.trim();
				if (!SETTABLE_MARK.test(m)) {
					this.message = 'E191: Argument must be a letter or forward/backward quote';
					return;
				}
				const line = range ? range.end : cur.line;
				this.setMark(m === '`' ? '\'' : m, pos(line, 0));
				return;
			}
			case 'set':
				this.exSet(args);
				return;
			case 'registers': {
				const names = ['"', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-', ...'abcdefghijklmnopqrstuvwxyz'];
				const shown = names.filter(n => this.shared.registers.has(n) && (!args || args.includes(n)))
					.map(n => `"${n} ${this.shared.registers.get(n)!.text.replace(/\n/g, '^J').slice(0, 40)}`);
				this.message = shown.join('  ') || 'No registers';
				return;
			}
			case 'marks': {
				const shown = [...this.marks].filter(([k]) => /[a-zA-Z]/.test(k)).sort(([a], [b]) => a.localeCompare(b))
					.map(([k, v]) => `${k} ${v.line + 1}:${v.col}`);
				this.message = shown.join('  ') || 'No marks';
				return;
			}
			case 'retab': {
				const tab = this.host.tabSize();
				const useTabs = this.host.indentUnit() === '\t';
				const edits: VimEdit[] = [];
				for (let l = r.start; l <= (range ? r.end : this.lastLine()); l++) {
					const text = this.host.lineText(l);
					const indent = /^\s*/.exec(text)![0];
					const w = vcolOf(indent, indent.length, tab);
					const out = useTabs ? '\t'.repeat(Math.floor(w / tab)) + ' '.repeat(w % tab) : ' '.repeat(w);
					if (out !== indent) {
						edits.push({ start: pos(l, 0), end: pos(l, indent.length), text: out });
					}
				}
				this.edit(edits);
				this.closeChange();
				return;
			}
			case 'left': case 'right': case 'center': {
				const width = Number(args) || (name === 'left' ? 0 : (this.options.textwidth || 80));
				const edits: VimEdit[] = [];
				for (let l = r.start; l <= r.end; l++) {
					const text = this.host.lineText(l);
					const body = text.trim();
					const out = name === 'left' ? ' '.repeat(width) + body
						: name === 'right' ? ' '.repeat(Math.max(0, width - body.length)) + body
							: (body ? ' '.repeat(Math.max(0, Math.floor((width - body.length) / 2))) + body : '');
					if (out !== text) {
						edits.push({ start: pos(l, 0), end: pos(l, text.length), text: out });
					}
				}
				this.edit(edits);
				this.closeChange();
				return;
			}
			case '@': {
				const reg = args.trim()[0] ?? '@';
				if (reg === ':' || reg === '@' && this.shared.lastMacro === ':') {
					if (this.shared.lastEx) {
						this.runEx(this.shared.lastEx);
					}
					return;
				}
				const value = this.readRegister(reg);
				if (value) {
					this.sequence(value.text.split('\n').map(l => () => this.runEx(l)));
				}
				return;
			}
			case '=':
				this.message = String((range ? range.end : this.lastLine()) + 1);
				return;
		}
		this.message = `E492: Not an editor command: ${name}`;
	}

	/** An ex address argument (`:m 0`, `:t .`, `:co $`) to a line (0-based; -1 is "before the first line"). */
	private exAddress(text: string, cur: VimPos): number | undefined {
		const t = text.trim();
		if (t === '0') {
			return -1;
		}
		const line = resolveExAddress(t || '.', { cursorLine: cur.line, lastLine: this.lastLine(), visual: undefined, mark: n => this.getMark(n)?.line });
		return line;
	}

	private insertLinesAfter(line: number, text: string): void {
		if (line < 0) {
			this.edit([{ start: pos(0, 0), end: pos(0, 0), text: text + '\n' }]);
		} else {
			this.edit([{ start: pos(line, this.len(line)), end: pos(line, this.len(line)), text: '\n' + text }]);
		}
	}

	private deleteLines(start: number, end: number): void {
		let s: VimPos;
		let e: VimPos;
		if (end < this.lastLine()) {
			s = pos(start, 0);
			e = pos(end + 1, 0);
		} else if (start > 0) {
			s = pos(start - 1, this.len(start - 1));
			e = pos(end, this.len(end));
		} else {
			s = pos(0, 0);
			e = pos(end, this.len(end));
		}
		this.edit([{ start: s, end: e, text: '' }]);
		this.closeChange();
		const line = Math.min(start, this.lastLine());
		this.setNormalCursor(pos(line, this.firstNonBlank(line)));
	}

	/** The pattern, replacement and flags a `:s` / `:&` / `:&&` / `:~` line means, or the error (E35). */
	private substituteArgs(name: string, args: string): { pattern: string; replacement: string; flags: string; count: number | undefined; upTo?: 'pattern' | 'replacement' | 'flags' } | string {
		const last = this.shared.lastSubstitute;
		const ps = parseSubstitute(args);
		if (name === 'substitute') {
			if (ps.pattern === undefined) {
				if (!last) {
					return 'E35: No previous regular expression';
				}
				return { pattern: last.pattern, replacement: last.replacement, flags: ps.flags.startsWith('&') ? last.flags + ps.flags.slice(1) : ps.flags, count: ps.count };
			}
			const pattern = ps.pattern || this.shared.lastSearch?.pattern || '';
			if (!pattern) {
				return 'E35: No previous regular expression';
			}
			const flags = ps.flags.startsWith('&') && last ? last.flags + ps.flags.slice(1) : ps.flags.replace(/^&/, '');
			return { pattern, replacement: ps.replacement ?? '', flags, count: ps.count, upTo: ps.upTo };
		}
		if (!last) {
			return 'E35: No previous regular expression';
		}
		// :& keeps nothing unless given &; :&& keeps the flags; :~ uses the last search pattern
		const pattern = name === '~' ? (this.shared.lastSearch?.pattern ?? last.pattern) : last.pattern;
		const flags = (name === '&&' ? last.flags : '') + ps.flags.replace(/^&/, ps.flags.startsWith('&') ? last.flags : '');
		return { pattern, replacement: last.replacement, flags, count: ps.count };
	}

	/** The query `:s` searches with: 'ignorecase' / 'smartcase', or the `i` / `I` flag. */
	private substituteQuery(pattern: string, flags: string): VimSearchQuery {
		return this.query(pattern, { caseFlag: flags.includes('I') ? 'I' : flags.includes('i') ? 'i' : undefined });
	}

	private substituteGlobal(flags: string): boolean {
		return flags.includes('g') !== this.options.gdefault;
	}

	/**
	 * :s :& :&& :~ (`:help :s`). The pattern is a JavaScript regular
	 * expression matched by VS Code's find, the replacement the find widget's
	 * replace string; the range, the count and the flags (g c e i I n &) are
	 * Vim's. All of it is one undo step.
	 */
	private exSubstitute(name: string, r: { start: number; end: number }, args: string): void {
		const a = this.substituteArgs(name, args);
		if (typeof a === 'string') {
			this.message = a;
			return;
		}
		const { pattern, replacement, flags, count } = a;
		if (count !== undefined) {
			r = { start: r.end, end: this.clampLine(r.end + count - 1) };
		}
		const q = this.substituteQuery(pattern, flags);
		const origin = this.cursor();
		this.shared.lastSubstitute = { pattern, replacement, flags: flags.replace(/[cn]/g, '') };
		this.shared.lastSearch = { pattern, backwards: false };
		const global = this.substituteGlobal(flags);
		const countOnly = flags.includes('n');
		if (flags.includes('c') && !countOnly) {
			this.confirm = { query: q, replacement, global, from: pos(r.start, 0), endLine: r.end, subs: 0, lines: new Set(), lastLine: -1, pattern, origin: this.cursor() };
			this.openChange();
			this.confirmNext(false);
			return;
		}
		const subs = substitutions(this.host, q, countOnly ? undefined : replacement, r, global);
		const linesChanged = new Set(subs.map(x => x.range.start.line)).size;
		if (!subs.length) {
			if (!flags.includes('e')) {
				this.message = `E486: Pattern not found: ${pattern}`;
			}
			return;
		}
		if (countOnly) {
			this.message = `${subs.length} match${subs.length === 1 ? '' : 'es'} on ${linesChanged} line${linesChanged === 1 ? '' : 's'}`;
			return;
		}
		// where the last replacement ends once every edit is in (the edits are in pre-edit coordinates)
		let delta = 0;
		for (const x of subs) {
			delta += x.text!.split('\n').length - 1 - (x.range.end.line - x.range.start.line);
		}
		const lastSub = subs[subs.length - 1];
		this.edit(subs.map(x => ({ start: x.range.start, end: x.range.end, text: x.text! })));
		const finalLine = this.clampLine(lastSub.range.end.line + delta);
		this.closeChange();
		this.highlight(q);
		this.setMark('[', pos(r.start, 0));
		this.setMark(']', pos(finalLine, 0));
		// `:s` is a jump (`:help jump-motions`)
		this.jumpTo(pos(finalLine, this.firstNonBlank(finalLine)), origin);
		if (linesChanged > this.options.report) {
			this.message = `${subs.length} substitution${subs.length === 1 ? '' : 's'} on ${linesChanged} line${linesChanged === 1 ? '' : 's'}`;
		}
	}

	/**
	 * 'inccommand': while `:[range]s/pat/rep/flags` is typed, what it would
	 * replace on the lines on screen (and a little around them), at most
	 * INCCOMMAND_LIMIT; only the matches while just the pattern is typed.
	 * Undefined when the line is no `:s`, its pattern does not compile yet or
	 * its range is not there.
	 */
	substitutePreview(line: string): VimSubstitution[] | undefined {
		const p = parseExCommand(line, this.shared.registry);
		const name = p.spec?.engine;
		if (name !== 'substitute' || p.error || !/^[^A-Za-z0-9\s"|\\&]/.test(p.args)) {
			return undefined;
		}
		const a = this.substituteArgs(name, p.args);
		if (typeof a === 'string' || regexError(a.pattern) !== undefined || !a.pattern) {
			return undefined;
		}
		let r: { start: number; end: number } | undefined;
		try {
			r = p.range ? resolveExRange(p, this.exAddressContext(this.cursor(), false)) : { start: this.cursor().line, end: this.cursor().line };
		} catch {
			r = undefined;
		}
		if (!r) {
			return undefined;
		}
		if (a.count !== undefined) {
			r = { start: r.end, end: this.clampLine(r.end + a.count - 1) };
		}
		const view = this.host.visibleLines();
		const start = Math.max(r.start, view.top - INCCOMMAND_MARGIN);
		const end = Math.min(r.end, view.bottom + INCCOMMAND_MARGIN);
		if (start > end) {
			return [];
		}
		const q = this.substituteQuery(a.pattern, a.flags);
		return substitutions(this.host, q, a.upTo === 'pattern' ? undefined : a.replacement, { start, end }, this.substituteGlobal(a.flags), INCCOMMAND_LIMIT);
	}

	/** `:s///c` in progress: the next match waits for y / n / a / q / l. */
	private confirm: { query: VimSearchQuery; replacement: string; global: boolean; from: VimPos; endLine: number; subs: number; lines: Set<number>; lastLine: number; pattern: string; origin: VimPos } | undefined;

	/** The match `:s///c` asks about next: VS Code's next match from where it is, in the range. */
	private confirmMatch(): VimMatch | undefined {
		const c = this.confirm!;
		const last = Math.min(c.endLine, this.lastLine());
		if (c.from.line > last) {
			return undefined;
		}
		const m = this.host.findNextMatch(c.query, c.from, false);
		return m && cmp(m.range.start, c.from) >= 0 && m.range.start.line <= last ? m : undefined;
	}

	/** Find the next match to confirm (or, with `all`, replace every remaining one); finish when there is none. */
	private confirmNext(all: boolean): void {
		const c = this.confirm;
		if (!c) {
			return;
		}
		let m: VimMatch | undefined;
		while ((m = this.confirmMatch())) {
			if (!all) {
				this.host.showIncSearch(m.range);
				this.host.setCursor(m.range.start);
				this.lastCursor = undefined;
				this.awaiting = { command: 'devhubVim.substituteConfirm', args: {} };
				this.message = `replace with ${c.replacement} (y/n/a/q/l)?`;
				return;
			}
			this.confirmReplace(m);
		}
		this.finishConfirm();
	}

	/** Where `:s///c` goes on from after `at` (past an empty match by a character; the next line without `g`). */
	private confirmAdvance(at: VimPos, empty: boolean): void {
		const c = this.confirm!;
		if (!c.global) {
			c.from = pos(at.line + 1, 0);
		} else if (empty) {
			c.from = at.col < this.len(at.line) ? pos(at.line, at.col + 1) : pos(at.line + 1, 0);
		} else {
			c.from = at;
		}
	}

	/** Replace the match at the confirm position and move past it. */
	private confirmReplace(m: VimMatch): void {
		const c = this.confirm!;
		const out = this.host.replaceString(c.replacement, m);
		this.edit([{ start: m.range.start, end: m.range.end, text: out }]);
		c.subs++;
		c.lines.add(m.range.start.line);
		const endAt = endOfText(m.range.start, out);
		c.endLine += out.split('\n').length - 1 - (m.range.end.line - m.range.start.line);
		c.lastLine = endAt.line;
		this.confirmAdvance(endAt, cmp(m.range.start, m.range.end) === 0);
	}

	private cmdSubstituteConfirm(ch: string | undefined): void {
		const c = this.confirm;
		if (!c) {
			return;
		}
		const m = this.confirmMatch();
		if (!m || ch === 'q' || ch === undefined) {
			this.finishConfirm();
			return;
		}
		switch (ch) {
			case 'y':
				this.confirmReplace(m);
				this.confirmNext(false);
				return;
			case 'l':
				this.confirmReplace(m);
				this.finishConfirm();
				return;
			case 'n':
				this.confirmAdvance(m.range.end, cmp(m.range.start, m.range.end) === 0);
				this.confirmNext(false);
				return;
			case 'a':
				this.confirmNext(true);
				return;
		}
		// any other key asks again
		this.confirmNext(false);
	}

	private finishConfirm(): void {
		const c = this.confirm;
		if (!c) {
			return;
		}
		this.confirm = undefined;
		this.awaiting = undefined;
		this.host.showIncSearch(undefined);
		this.closeChange();
		this.highlight(c.query);
		if (c.lastLine >= 0) {
			const l = this.clampLine(c.lastLine);
			this.jumpTo(pos(l, this.firstNonBlank(l)), c.origin);
		} else {
			// nothing replaced: the cursor goes back
			this.setNormalCursor(c.origin);
		}
		this.message = c.subs > this.options.report || c.lines.size > this.options.report ? `${c.subs} substitution${c.subs === 1 ? '' : 's'} on ${c.lines.size} line${c.lines.size === 1 ? '' : 's'}` : '';
	}

	/** :g/pat/cmd and :v/pat/cmd: mark the lines, then run cmd on each that is still there. */
	private exGlobal(invert: boolean, r: { start: number; end: number }, args: string): void {
		const g = parseGlobal(args);
		if (!g) {
			this.message = 'E146: Regular expressions can\'t be delimited by letters';
			return;
		}
		const pattern = g.pattern || this.shared.lastSearch?.pattern || '';
		if (!pattern) {
			this.message = 'E35: No previous regular expression';
			return;
		}
		this.shared.lastSearch = g.pattern ? { pattern, backwards: false } : { ...this.shared.lastSearch!, backwards: false };
		const q = this.lastSearchQuery()!;
		// the lines a match starts on (VS Code's find over the range)
		const hit = new Set(this.host.findMatches(q, { start: pos(r.start, 0), end: pos(r.end, this.len(r.end)) }, Number.MAX_SAFE_INTEGER).map(m => m.range.start.line));
		const tag = `\u0000g${Date.now()}`;
		const marked: string[] = [];
		for (let l = r.start; l <= r.end; l++) {
			if (hit.has(l) !== invert) {
				const name = `${tag}:${l}`;
				this.marks.set(name, pos(l, 0));
				marked.push(name);
			}
		}
		if (!marked.length) {
			this.message = invert ? 'E538: Pattern found in every line' : `E486: Pattern not found: ${pattern}`;
			return;
		}
		const cmd = g.command;
		if (cmd === 'p' || cmd === 'print' || cmd === '#' || cmd === 'nu' || cmd === 'number') {
			this.message = marked.map(n => this.host.lineText(this.marks.get(n)!.line)).slice(0, 20).join(' | ');
			for (const n of marked) {
				this.marks.delete(n);
			}
			return;
		}
		// each line's command after the one before has finished (a VS Code command included); one undo step while nothing waits
		this.sequence(marked.flatMap(n => [
			() => {
				const p = this.marks.get(n);
				this.marks.delete(n);
				if (p) {
					// (no p: the line was deleted by an earlier command)
					this.setNormalCursor(pos(p.line, 0));
					this.runEx(cmd);
				}
			},
			() => {
				if (this.isInsert()) {
					this.exitInsert(false);
				}
			},
		]), () => {
			for (const n of marked) {
				this.marks.delete(n);
			}
			this.highlight(q);
		}, true);
	}

	/** :sort [!] [i] [n] [x] [u] [r] [/pat/] */
	private exSort(r: { start: number; end: number }, reverse: boolean, args: string): void {
		let pat: string | undefined;
		const pm = /\/((?:\\.|[^/])*)\//.exec(args);
		let flags = args;
		if (pm) {
			pat = pm[1] || this.shared.lastSearch?.pattern;
			flags = args.replace(pm[0], '');
		}
		const ic = flags.includes('i');
		const numeric = flags.includes('n');
		const hex = flags.includes('x');
		const unique = flags.includes('u');
		const byMatch = flags.includes('r');
		const q = pat ? this.query(pat) : undefined;
		const lines: string[] = [];
		for (let l = r.start; l <= r.end; l++) {
			lines.push(this.host.lineText(l));
		}
		const key = (line: string, l: number): string => {
			if (!q) {
				return line;
			}
			// the first match on the line, as VS Code's find finds it
			const m = this.host.findMatches(q, { start: pos(l, 0), end: pos(l, line.length) }, 1)[0];
			if (!m) {
				return byMatch ? '' : line;
			}
			return byMatch ? m.groups[0] ?? line.slice(m.range.start.col, m.range.end.col) : line.slice(m.range.end.col);
		};
		const numberOf = (s: string): number => {
			const m = hex ? /-?(?:0[xX])?[0-9a-fA-F]+/.exec(s) : /-?\d+/.exec(s);
			if (!m) {
				return -Infinity;
			}
			return hex ? parseInt(m[0].replace(/^(-?)0[xX]/, '$1'), 16) : Number(m[0]);
		};
		const items = lines.map((line, i) => ({ line, i, k: key(line, r.start + i) }));
		items.sort((a, b) => {
			let c: number;
			if (numeric || hex) {
				c = numberOf(a.k) - numberOf(b.k);
				if (Number.isNaN(c)) {
					c = 0;
				}
			} else {
				const x = ic ? a.k.toLowerCase() : a.k;
				const y = ic ? b.k.toLowerCase() : b.k;
				c = x < y ? -1 : x > y ? 1 : 0;
			}
			return c || a.i - b.i;
		});
		if (reverse) {
			items.reverse();
		}
		let out = items.map(x => x.line);
		if (unique) {
			out = out.filter((l, i) => i === 0 || (ic ? l.toLowerCase() !== out[i - 1].toLowerCase() : l !== out[i - 1]));
		}
		if (out.join('\n') !== lines.join('\n')) {
			this.edit([{ start: pos(r.start, 0), end: pos(r.end, this.len(r.end)), text: out.join('\n') }]);
		}
		this.closeChange();
		this.setNormalCursor(pos(r.start, 0));
	}

	/** :set — options the engine knows; `opt?`, `noopt`, `invopt`, `opt!`, `opt&`, `opt=val`, `opt+=val`, `opt-=val`. */
	private exSet(args: string): void {
		const o = this.shared.options as unknown as Record<string, boolean | number | string>;
		const shown: string[] = [];
		if (!args.trim()) {
			this.message = Object.entries(this.shared.options).filter(([k, v]) => v !== (DEFAULT_VIM_OPTIONS as unknown as Record<string, unknown>)[k])
				.map(([k, v]) => typeof v === 'boolean' ? (v ? k : 'no' + k) : `${k}=${v}`).join('  ') || '--- Options ---';
			return;
		}
		for (const item of args.trim().split(/\s+/)) {
			const m = /^(no|inv)?([a-z]+)(\?|!|&|[+-^]?=(.*))?$/.exec(item);
			if (!m) {
				this.message = `E518: Unknown option: ${item}`;
				return;
			}
			const prefix = m[1];
			let rawName = m[2];
			let neg = prefix === 'no';
			let inv = prefix === 'inv';
			if (!(rawName in OPTION_ALIASES) && !(rawName in DEFAULT_VIM_OPTIONS) && !(rawName in BUFFER_OPTIONS) && prefix) {
				// e.g. "nowrapscan" read as no + wrapscan, but "number" is not no+mber
				rawName = (prefix ?? '') + rawName;
				neg = false;
				inv = false;
			}
			if (rawName in BUFFER_OPTIONS) {
				const error = this.setBufferOption(BUFFER_OPTIONS[rawName], neg, inv, m[3], m[4], item, shown);
				if (error) {
					this.message = error;
					return;
				}
				continue;
			}
			const name = OPTION_ALIASES[rawName] ?? rawName;
			if (!(name in DEFAULT_VIM_OPTIONS)) {
				this.message = `E518: Unknown option: ${rawName}`;
				return;
			}
			const def = (DEFAULT_VIM_OPTIONS as unknown as Record<string, boolean | number | string>)[name];
			const op = m[3];
			if (op === '?') {
				shown.push(typeof o[name] === 'boolean' ? (o[name] ? name : 'no' + name) : `${name}=${o[name]}`);
				continue;
			}
			if (op === '&') {
				o[name] = def;
				continue;
			}
			if (typeof def === 'boolean') {
				if (op && op !== '!') {
					this.message = `E474: Invalid argument: ${item}`;
					return;
				}
				o[name] = op === '!' || inv ? !o[name] : !neg;
				continue;
			}
			if (!op) {
				shown.push(`${name}=${o[name]}`);
				continue;
			}
			const value = m[4] ?? '';
			if (typeof def === 'number') {
				const v = Number(value);
				if (!Number.isFinite(v)) {
					this.message = `E521: Number required after =: ${item}`;
					return;
				}
				o[name] = op.startsWith('+') ? (o[name] as number) + v : op.startsWith('-') ? (o[name] as number) - v : v;
			} else {
				const list = String(o[name]).split(',').filter(x => x);
				o[name] = op.startsWith('+') ? [...list, value].join(',') : op.startsWith('-') ? list.filter(x => x !== value).join(',') : value;
			}
		}
		if (!this.options.hlsearch) {
			this.host.highlightSearch(undefined);
		} else if (this.hlActive && this.shared.lastSearch) {
			this.highlight(this.lastSearchQuery());
		}
		if (shown.length) {
			this.message = shown.join('  ');
		}
	}

	/** 'tabstop' 'shiftwidth' 'expandtab' as Vim shows them (from the model's options). */
	private bufferOptions(): { tabstop: number; shiftwidth: number; expandtab: boolean } {
		const o = this.host.indentOptions();
		return { tabstop: o.tabSize, shiftwidth: o.indentSize === 'tabSize' ? 0 : o.indentSize, expandtab: o.insertSpaces };
	}

	/** The buffer options for the prompt's completion. */
	private bufferOptionList(): VimOptionInfo[] {
		let o: { tabstop: number; shiftwidth: number; expandtab: boolean };
		try {
			o = this.bufferOptions();
		} catch {
			return [];
		}
		return [
			{ name: 'expandtab', alias: 'et', boolean: true, detail: o.expandtab ? 'on' : 'off' },
			{ name: 'shiftwidth', alias: 'sw', boolean: false, detail: `=${o.shiftwidth}` },
			{ name: 'tabstop', alias: 'ts', boolean: false, detail: `=${o.tabstop}` },
		];
	}

	/**
	 * `:set ts=` `sw=` `et` / `noet` (and `?`, `&`, `+=`, `-=`, `!`, `inv`):
	 * not options of the engine's but the model's (tab size, indent size,
	 * insert spaces), so VS Code's rendering of tabs, its indentation and its
	 * status bar follow, and `>>` `:retab` read them back. `sw=0` is "the tab
	 * size" (Vim's: 'shiftwidth' follows 'tabstop'). `&` is what the settings
	 * say for the file.
	 */
	private setBufferOption(name: 'tabstop' | 'shiftwidth' | 'expandtab', neg: boolean, inv: boolean, op: string | undefined, value: string | undefined, item: string, shown: string[]): string | undefined {
		const cur = this.bufferOptions();
		if (op === '?' || (!op && name !== 'expandtab' && !neg && !inv)) {
			shown.push(name === 'expandtab' ? (cur.expandtab ? 'expandtab' : 'noexpandtab') : `${name}=${cur[name]}`);
			return undefined;
		}
		if (op === '&') {
			const d = this.host.defaultIndentOptions();
			this.host.setIndentOptions(name === 'tabstop' ? { tabSize: d.tabSize } : name === 'shiftwidth' ? { indentSize: d.indentSize } : { insertSpaces: d.insertSpaces });
			return undefined;
		}
		if (name === 'expandtab') {
			if (op && op !== '!') {
				return `E474: Invalid argument: ${item}`;
			}
			this.host.setIndentOptions({ insertSpaces: op === '!' || inv ? !cur.expandtab : !neg });
			return undefined;
		}
		if (neg || inv || op === '!') {
			return `E474: Invalid argument: ${item}`;
		}
		const v = Number(value);
		if (value === undefined || value === '' || !Number.isInteger(v)) {
			return `E521: Number required after =: ${item}`;
		}
		const n = op!.startsWith('+') ? cur[name] + v : op!.startsWith('-') ? cur[name] - v : op!.startsWith('^') ? cur[name] * v : v;
		if (name === 'tabstop') {
			if (n <= 0) {
				return `E487: Argument must be positive: ${item}`;
			}
			this.host.setIndentOptions({ tabSize: n });
		} else {
			if (n < 0) {
				return `E487: Argument must be positive: ${item}`;
			}
			this.host.setIndentOptions({ indentSize: n === 0 ? 'tabSize' : n });
		}
		return undefined;
	}

	// ---- keys (:normal, @ of a register holding text) ------------------------

	/**
	 * Keys in Vim notation run through the default keymap (as `:normal!`: user
	 * keybindings are not used). In insert mode characters are typed. Each key
	 * goes after what the one before started (a VS Code command it is bound
	 * to: see `sequence`); `then` runs after the last.
	 */
	feedKeys(keys: string, then?: () => void): void {
		let chord: string[] = [];
		this.sequence(keysOf(keys).map(k => () => {
			if (this.cmdline) {
				this.feedPrompt(k === '<lt>' ? '<' : k);
				return;
			}
			if (this.awaitingChar) {
				this.awaitKey(k === '<lt>' ? '<' : k);
				return;
			}
			const ch = k === '<lt>' ? '<' : k;
			const key = keyName(ch);
			if (this.isInsert() && !chord.length && Array.from(ch).length === 1) {
				this.typeText(ch === '\r' ? '\n' : ch);
				return;
			}
			if (this.isInsert() && (ch === '<CR>' || ch === '<Tab>')) {
				this.typeText(ch === '<CR>' ? '\n' + this.indentOf(this.host.getCursor().line) : '\t');
				return;
			}
			if (this.isInsert() && ch === '<BS>') {
				this.cmdInsert('backspace', undefined);
				return;
			}
			if (!key) {
				chord = [];
				return;
			}
			const full = [...chord, key].join(' ');
			const ctx = this.whenContext();
			let match: typeof DEFAULT_KEYBINDINGS[number] | undefined;
			for (const b of DEFAULT_KEYBINDINGS) {
				if (b.key === full && evaluateWhen(b.when, ctx)) {
					match = b;
				}
			}
			if (match) {
				chord = [];
				if (!this.execute(match.command, match.args)) {
					this.runSteps([{ command: match.command, args: match.args }]);
				}
				return;
			}
			if (DEFAULT_KEYBINDINGS.some(b => b.key.startsWith(full + ' ') && evaluateWhen(b.when, ctx))) {
				chord.push(key);
				return;
			}
			chord = [];
			if (this.pending) {
				this.cancelPending();
			}
		}), then);
	}

	/**
	 * A fed key while the prompt is open: typed into a line of the engine's
	 * own, through the prompt's keybindings (vimCmdline.ts), as if the prompt
	 * line had the focus. Whatever is left open when the keys end is the
	 * workbench's to show (`@a` of a register holding `/foo`).
	 */
	private feedPrompt(k: string): void {
		const cl = this.cmdline!;
		if (!this.fedPrompt) {
			this.fedPrompt = new VimCmdlineController(cl.kind, new VimStringLine(cl.text), this.cmdlineTarget(), this.cmdlineSources());
		}
		this.fedPrompt.feedKey(k);
		if (this.cmdline !== cl) {
			this.fedPrompt = undefined;
		}
	}

	/** :normal ends an incomplete command as if <Esc> was typed. */
	private endFeed(): void {
		if (this.cmdline) {
			this.closeCmdline();
		}
		if (this.isInsert()) {
			this.exitInsert(false);
		}
		this.awaiting = undefined;
		this.resetGrammar();
	}

	/** The context keys as the default keymap's `when` clauses read them. */
	private whenContext(): Record<string, unknown> {
		const c = this.context();
		return {
			'true': true, editorTextFocus: true, textInputFocus: true, 'devhubVim.active': true,
			'devhubVim.mode': c.mode, 'devhubVim.acceptsMotion': c.acceptsMotion, 'devhubVim.hasCount': c.hasCount,
			'devhubVim.pending': c.pending, 'devhubVim.pendingOperator': c.pendingOperator, 'devhubVim.textObjectPending': c.textObjectPending,
			'devhubVim.awaitingChar': c.awaitingChar, 'devhubVim.recording': c.recording, 'devhubVim.visual': c.visual, 'devhubVim.insert': c.insert,
		};
	}

	/** Run steps in order, each awaited; engine commands run in the engine (and are recorded). What is sequenced after them waits for them (`wait`). */
	private runSteps(steps: readonly ExStep[], after?: () => void, failed?: () => void): void {
		this.wait((async () => {
			try {
				for (const s of steps) {
					if (!this.execute(s.command, s.args)) {
						await this.host.executeCommand(s.command, s.args);
					}
				}
			} catch (err) {
				this.message = String(err instanceof Error ? err.message : err);
				failed?.();
			} finally {
				try {
					after?.();
				} catch {
					// the editor went away while the commands ran
				}
				this.host.refresh();
			}
		})());
	}
}

function endOfText(at: VimPos, text: string): VimPos {
	const lines = text.split('\n');
	return lines.length === 1 ? pos(at.line, at.col + text.length) : pos(at.line + lines.length - 1, lines[lines.length - 1].length);
}

/** "A-Z appends: linewise text, or text onto a linewise register, goes on its own line. */
function appendRegister(prev: VimRegister, value: VimRegister): VimRegister {
	if (prev.type === 'line' || value.type === 'line') {
		return { text: prev.text + '\n' + value.text, type: 'line' };
	}
	if (prev.type === 'block' || value.type === 'block') {
		return { text: prev.text + '\n' + value.text, type: 'block' };
	}
	return { text: prev.text + value.text, type: 'char' };
}

/** Text as a pattern that matches it literally, in a `/` (or `?`) search line. */
function literalPattern(text: string, delimiter: '/' | '?'): string {
	const esc = escapeRegExpCharacters(text);
	return delimiter === '/' ? esc.replace(/\//g, '\\/') : esc;
}

/** A search line `pat/e+1` split into the pattern and the offset (`:help search-offset`). */
function splitSearchOffset(text: string, delimiter: '/' | '?'): { pattern: string; offset: string | undefined } {
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\\') {
			i++;
			continue;
		}
		if (text[i] === delimiter) {
			return { pattern: text.slice(0, i), offset: text.slice(i + 1) };
		}
	}
	return { pattern: text, offset: undefined };
}

/** Vim key notation (`x`, `<CR>`, `<C-r>`) to the keymap's notation (`x`, `enter`, `ctrl+r`). */
function keyName(k: string): string | undefined {
	return keybindingForVimKey(k);
}
