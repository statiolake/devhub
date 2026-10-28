/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the `:` command line - one registry of commands, one
// parser, and what a command's steps run with. Imports nothing (the tests run
// it as they run the engine).
//
// Every ex command, Vim's and the user's, is an ExSpec in one registry
// (ExRegistry): what it runs and what it takes. Vim's built-in names
// (`:s` is `:substitute`, `:sp` is `:split`) are default entries:
// * those whose `engine` is set are Vim's editing commands (:s :g :d :m :t
//   :normal :sort :w :r :! :js ...), implemented by the engine on the buffer
//   (vimEngine.ts runEngineEx);
// * the others run VS Code commands, exactly as a keybinding runs a command:
//   steps `{ command, args? }`, in order, each awaited.
// `devhub.vim.exCommands` (ExCommandSpec, read from user and machine settings
// only) adds the user's own, whose names start with an uppercase letter (as
// Vim's `:command` requires), and may override any built-in name (by its full
// name or any abbreviation Vim accepts for it); an override keeps the
// built-in's attributes it does not set.
//
// The one parser (parseExCommand) reads a line as Vim does:
// `[range] name [!] args`, the args as the command's spec takes them, and,
// when the command takes `|` (`bar`), the next command after it. The engine
// runs what it returns; the prompt's completion (vimCmdline.ts) reads the line
// with it too, so both agree on where a name ends and an argument starts.
//
// A step's args may use placeholders, filled from the command line:
//   "${args}"     the argument string                       (string)
//   "${argList}"  the arguments: split on blanks for nargs * and +, the
//                 whole argument for 1 and ?                (string[])
//   "${bang}"     whether `!` was given                     (boolean)
//   "${range}"    { start, end }, 1-based lines, or null when no range was typed
//   "${line1}" / "${line2}"  first / last line (1-based) of the range, typed
//                 or the default one (`defaultRange`)
//   "${count}"    the count (range "count"), or null
//   "${register}" the register named first (register: true), or ""
// A string that is exactly a placeholder becomes the typed value; inside a
// longer string it is replaced by its text ("!" or "" for bang, "a,b" for range).

export interface ExStep {
	readonly command: string;
	readonly args?: unknown;
	/** Run only with `!` (true) or only without it (false). */
	readonly ifBang?: boolean;
}

/** How many arguments (Vim's `-nargs`): none (`0` too), exactly one, at most one, any, at least one. */
export type ExNargs = 'none' | '0' | '1' | '?' | '*' | '+';
/** What may stand before the name (Vim's `-range` / `-count`): nothing, one line, a range of lines, a count. */
export type ExRangeKind = 'none' | 'line' | 'range' | 'count';
/** Without a typed range: the cursor line, the whole file, or a count's default. */
export type ExDefaultRange = '.' | '%' | number;

/** One `devhub.vim.exCommands` entry as settings.json has it (a bare string is `{ "command": ... }`). */
export interface ExCommandSpec {
	readonly command?: string;
	readonly args?: unknown;
	/** Several steps, each awaited, instead of `command` / `args`. */
	readonly commands?: readonly (string | ExStep)[];
	readonly nargs?: ExNargs;
	readonly range?: ExRangeKind;
	readonly defaultRange?: ExDefaultRange;
	readonly bang?: boolean;
	readonly register?: boolean;
	/** What Tab completes in the argument: file, command, option, buffer, or `command:<id>` (a command that returns the candidates). */
	readonly complete?: string;
	/** `|` ends the command and starts the next one (otherwise it is part of the argument). */
	readonly bar?: boolean;
	readonly description?: string;
}

/** A command as the parser and the engine use it: a built-in, or a user's spec with every attribute filled in. */
export interface ExSpec {
	/** What it runs (VS Code commands or engine commands); none for an engine built-in. */
	readonly steps: readonly ExStep[];
	/** Vim's editing command the engine implements itself (its canonical name). */
	readonly engine?: string;
	readonly nargs: ExNargs;
	readonly range: ExRangeKind;
	readonly defaultRange: ExDefaultRange;
	readonly bang: boolean;
	readonly register: boolean;
	readonly complete?: string;
	readonly bar: boolean;
	/** An argument that starts with `!` is a shell command: it takes the rest of the line, `|` included (`:r !cmd`, `:w !cmd`). */
	readonly shell?: boolean;
	readonly description?: string;
	/** From `devhub.vim.exCommands`. */
	readonly user?: boolean;
}

// ---- names ------------------------------------------------------------------

/** Vim's built-in names: [full name, shortest accepted abbreviation, canonical name if an alias]. */
const EX_NAMES: readonly (readonly [string, string, string?])[] = [
	['write', 'w'], ['wall', 'wa'], ['update', 'up'], ['quit', 'q'], ['qall', 'qa'], ['quitall', 'quita', 'qall'],
	['wq', 'wq'], ['wqall', 'wqa', 'xall'], ['xit', 'x'], ['xall', 'xa'], ['exit', 'exi', 'xit'],
	['split', 'sp'], ['vsplit', 'vs'], ['new', 'new'], ['vnew', 'vne'], ['edit', 'e'], ['enew', 'ene'],
	['tabnew', 'tabnew'], ['tabedit', 'tabe'], ['tabnext', 'tabn'], ['tabprevious', 'tabp'], ['tabNext', 'tabN', 'tabprevious'],
	['tabclose', 'tabc'], ['tabonly', 'tabo'], ['tabfirst', 'tabfir'], ['tabrewind', 'tabr', 'tabfirst'], ['tablast', 'tabl'],
	['tabmove', 'tabm'], ['tabs', 'tabs'],
	['bnext', 'bn'], ['bprevious', 'bp'], ['bNext', 'bN', 'bprevious'], ['bdelete', 'bd'], ['bwipeout', 'bw', 'bdelete'],
	['bfirst', 'bf'], ['brewind', 'br', 'bfirst'], ['blast', 'bl'], ['buffers', 'buffers'], ['files', 'files', 'buffers'], ['ls', 'ls', 'buffers'],
	['buffer', 'b'], ['saveas', 'sav'], ['close', 'clo'], ['only', 'on'],
	['cnext', 'cn'], ['cprevious', 'cp'], ['cNext', 'cN', 'cprevious'], ['copen', 'cope'], ['cclose', 'ccl'],
	['terminal', 'ter'], ['grep', 'gr'], ['vimgrep', 'vim', 'grep'],
	['nohlsearch', 'noh'], ['substitute', 's'], ['global', 'g'], ['vglobal', 'v'], ['delete', 'd'], ['yank', 'y'],
	['move', 'm'], ['copy', 'co'], ['t', 't', 'copy'], ['join', 'j'], ['put', 'pu'], ['normal', 'norm'], ['sort', 'sor'],
	['undo', 'u'], ['redo', 'red'], ['mark', 'ma'], ['k', 'k', 'mark'], ['set', 'se'], ['setlocal', 'setl', 'set'],
	['registers', 'reg'], ['display', 'di', 'registers'],
	['marks', 'marks'], ['retab', 'ret'], ['left', 'le'], ['right', 'ri'], ['center', 'ce'], ['read', 'r'],
	['js', 'js'], ['jsdo', 'jsd'],
	['&', '&'], ['&&', '&&'], ['~', '~'], ['<', '<'], ['>', '>'], ['@', '@'], ['=', '='], ['!', '!'],
];

/** The canonical built-in name `typed` stands for (`s` -> `substitute`), or undefined. */
export function canonicalExName(typed: string): string | undefined {
	for (const [full, , alias] of EX_NAMES) {
		if (typed === full) {
			return alias ?? full;
		}
	}
	for (const [full, min, alias] of EX_NAMES) {
		if (typed.length >= min.length && full.startsWith(typed)) {
			return alias ?? full;
		}
	}
	return undefined;
}

/** Every name a built-in answers to (`w` `wr` ... `write`), for the settings' JSON schema. */
export function builtinExNameForms(): string[] {
	const out: string[] = [];
	for (const [full, min] of EX_NAMES) {
		if (/^[A-Za-z]/.test(full)) {
			for (let n = min.length; n <= full.length; n++) {
				out.push(full.slice(0, n));
			}
		}
	}
	return [...new Set(out)];
}

/** Vim's built-in names with letters, for the prompt's completion: the full name, the shortest abbreviation, the name it is an alias of. */
export function builtinExNameInfo(): { readonly name: string; readonly abbrev: string; readonly alias?: string }[] {
	return EX_NAMES.filter(([full]) => /^[A-Za-z]/.test(full)).map(([name, abbrev, alias]) => alias ? { name, abbrev, alias } : { name, abbrev });
}

// ---- the built-in commands ---------------------------------------------------------

const SAVE = 'workbench.action.files.save';
const SAVE_ALL = 'workbench.action.files.saveAll';
/**
 * `:x` `:up`: VS Code's Save in a file (browser/devhubVim.contribution.ts), its
 * own step so that a comment input can tell "write when modified" from `:w`
 * (browser/vimWindows.ts).
 */
const UPDATE = 'devhubVim.update';
const CLOSE = 'workbench.action.closeActiveEditor';
const REVERT_CLOSE = 'workbench.action.revertAndCloseActiveEditor';
const TAB = 'devhubVim.tabpage.';

/**
 * Vim's quit of the current window (`:q` `:wq` `:x` `ZZ` `CTRL-W q`): the
 * window (an editor group) closes, its buffers hidden; the last window of a
 * tab page closes the tab page, the last one of the last tab page closes the
 * Workspace. With `!` (`:q!` `ZQ`) its current editor drops its changes
 * first (browser/vimTabPages.ts quitWindow). Two commands rather than one with an
 * argument, so that a comment input tells them apart by the command alone
 * (browser/vimWindows.ts COMMENT_WINDOW_STEPS).
 */
export const QUIT_WINDOW_COMMAND = 'devhubVim.tabpage.quitWindow';
export const QUIT_WINDOW_DISCARD_COMMAND = 'devhubVim.tabpage.quitWindowDiscard';
/** `:clo[se]` / `CTRL-W c`: the window, never the last one (E444). */
export const CLOSE_WINDOW_COMMAND = 'devhubVim.tabpage.closeWindow';
/**
 * Vim quitting: DevHub's close of the Workspace (`:qa` `:wqa` `:xa`, and `:q`
 * on the last window of the last tab page), with `{ discard: 'all' }`
 * (`:qa!`) or `{ discard: 'active' }` (`:q!`) dropping changes first
 * (electron-browser/vimQuit.contribution.ts).
 */
export const CLOSE_WORKSPACE_COMMAND = 'devhubVim.closeWorkspace';
/** Vim's error for closing the last window. */
export const E444 = 'E444: Cannot close last window';

type StepsInput = string | ExStep | readonly (string | ExStep)[];

function toSteps(s: StepsInput): ExStep[] {
	const list: readonly (string | ExStep)[] = typeof s === 'string' || !Array.isArray(s) ? [s as string | ExStep] : s;
	return list.map(x => typeof x === 'string' ? { command: x } : x);
}

const DEFAULTS = { nargs: 'none', range: 'none', defaultRange: '.', bang: false, register: false, bar: true } as const;

/** A built-in that runs VS Code commands. */
function vs(steps: StepsInput, a: Partial<ExSpec> = {}): ExSpec {
	return { ...DEFAULTS, steps: toSteps(steps), ...a };
}

/** A built-in the engine implements. */
function vim(name: string, a: Partial<ExSpec> = {}): ExSpec {
	return { ...DEFAULTS, steps: [], engine: name, nargs: '*', range: 'range', ...a };
}

/** `:cmd` and `:cmd!`: different commands. */
function withBang(plain: StepsInput, bang: StepsInput): ExStep[] {
	return [...toSteps(plain).map(s => ({ ...s, ifBang: false })), ...toSteps(bang).map(s => ({ ...s, ifBang: true }))];
}

/**
 * `devhubVim.open` (browser/vimEdit.ts): the file argument (`${args}`) opened
 * in the active group; `replace` takes the place of the editor a split just
 * copied there, `untitled` opens a new untitled file when there is no argument.
 */
const OPEN = (options: { replace?: true; untitled?: true }): ExStep => ({ command: 'devhubVim.open', args: { file: '${args}', ...options } });
const FILE = { nargs: '?', complete: 'file' } as const;

/** Every built-in ex command, by canonical name. */
export const BUILTIN_EX_SPECS: Readonly<Record<string, ExSpec>> = {
	// `:w` saves; `:[range]w[!] {file}` and `:w >> {file}` write to a file, `:[range]w !{cmd}` to a command (vimEngine.ts exWrite)
	write: vim('write', { bang: true, nargs: '?', complete: 'file', defaultRange: '%', shell: true }),
	wall: vs(SAVE_ALL, { bang: true }),
	update: vs(UPDATE, { bang: true }),
	// the window (editor group), not the buffer (editor): `:bd` closes that
	quit: vs(withBang(QUIT_WINDOW_COMMAND, QUIT_WINDOW_DISCARD_COMMAND), { bang: true }),
	// Vim quitting: the Workspace closes (`:qa!` dropping every change first)
	qall: vs(withBang(CLOSE_WORKSPACE_COMMAND, { command: CLOSE_WORKSPACE_COMMAND, args: { discard: 'all' } }), { bang: true }),
	wq: vs([SAVE, QUIT_WINDOW_COMMAND], { bang: true }),
	xit: vs([UPDATE, QUIT_WINDOW_COMMAND], { bang: true }),
	xall: vs([SAVE_ALL, CLOSE_WORKSPACE_COMMAND], { bang: true }),
	// 'nosplitbelow' / 'nosplitright' (the defaults): the new window is above / left, and gets the focus
	// `:sp {file}` ...: the split, then the file in the new window (devhubVim.open)
	split: vs(['workbench.action.splitEditorUp', OPEN({ replace: true })], FILE),
	vsplit: vs(['workbench.action.splitEditorLeft', OPEN({ replace: true })], FILE),
	new: vs(['workbench.action.splitEditorUp', OPEN({ replace: true, untitled: true })], FILE),
	vnew: vs(['workbench.action.splitEditorLeft', OPEN({ replace: true, untitled: true })], FILE),
	// `:e {file}` opens it (a new file at that path when it does not exist), `:e` reloads (E37 when modified), `:e!` discards the changes
	edit: vs({ command: 'devhubVim.edit', args: { file: '${args}', bang: '${bang}' } }, { ...FILE, bang: true }),
	enew: vs('workbench.action.files.newUntitledFile', { bang: true }),
	// tab pages, each a layout of windows (editor groups): browser/vimTabPages.ts
	// `:tabnew [file]`: a new tab page after this one; without a file it has a new empty
	// buffer (an untitled editor, opened by devhubVim.tabpage.new itself), with one the
	// file is opened in it (devhubVim.open, `%` is the file the line ran in)
	tabnew: vs([{ command: TAB + 'new', args: { file: '${args}' } }, OPEN({})], FILE),
	tabedit: vs([{ command: TAB + 'new', args: { file: '${args}' } }, OPEN({})], FILE),
	// `:tabn` `:tabn {N}` `:{N}tabn` `:tabn $` `:tabn +{N}`; `:tabp [N]`; `:tabc [N | $ | +N | -N]`; `:tabm [N | +N | -N | $]`
	tabnext: vs({ command: TAB + 'next', args: { count: '${count}', arg: '${args}' } }, { nargs: '?', range: 'count', defaultRange: 0 }),
	tabprevious: vs({ command: TAB + 'previous', args: { count: '${count}' } }, { range: 'count', defaultRange: 0 }),
	tabclose: vs({ command: TAB + 'close', args: { count: '${count}', arg: '${args}' } }, { bang: true, nargs: '?', range: 'count', defaultRange: 0 }),
	tabonly: vs(TAB + 'only', { bang: true }),
	tabfirst: vs(TAB + 'first'),
	tablast: vs(TAB + 'last'),
	tabmove: vs({ command: TAB + 'move', args: { arg: '${args}' } }, { nargs: '?' }),
	tabs: vs(TAB + 'list'),
	bnext: vs('workbench.action.nextEditor', { bang: true, nargs: '?' }),
	bprevious: vs('workbench.action.previousEditor', { bang: true, nargs: '?' }),
	bdelete: vs(withBang(CLOSE, REVERT_CLOSE), { bang: true, nargs: '*', complete: 'buffer' }),
	bfirst: vs('workbench.action.firstEditorInGroup', { bang: true }),
	blast: vs('workbench.action.lastEditorInGroup', { bang: true }),
	buffers: vs('workbench.action.showAllEditors', { bang: true }),
	buffer: vs({ command: 'workbench.action.quickOpen', args: 'edt ${args}' }, { bang: true, nargs: '?', complete: 'buffer' }),
	// `:sav[!] {file}`: written there (E13 when it exists, without !), and the editor is that file's (vimEngine.ts exSaveAs)
	saveas: vim('saveas', { range: 'none', bang: true, nargs: '1', complete: 'file' }),
	// the window, its buffers hidden; the last one of a tab page closes the tab page, never the last one (E444; browser/vimTabPages.ts)
	close: vs(CLOSE_WINDOW_COMMAND, { bang: true }),
	only: vs('workbench.action.closeEditorsInOtherGroups', { bang: true }),
	cnext: vs('editor.action.marker.nextInFiles', { bang: true }),
	cprevious: vs('editor.action.marker.prevInFiles', { bang: true }),
	copen: vs('workbench.actions.view.problems'),
	cclose: vs('workbench.action.closePanel'),
	terminal: vs('workbench.action.terminal.new', { nargs: '*' }),
	grep: vs({ command: 'workbench.action.findInFiles', args: { query: '${args}', triggerSearch: true } }, { bang: true, nargs: '*' }),
	// Vim's own, on the buffer
	nohlsearch: vim('nohlsearch', { range: 'none', nargs: 'none' }),
	substitute: vim('substitute'),
	'&': vim('&'),
	'&&': vim('&&'),
	'~': vim('~'),
	global: vim('global', { bang: true, bar: false, defaultRange: '%' }),
	vglobal: vim('vglobal', { bar: false, defaultRange: '%' }),
	delete: vim('delete', { register: true }),
	yank: vim('yank', { register: true }),
	move: vim('move'),
	copy: vim('copy'),
	join: vim('join', { bang: true }),
	put: vim('put', { range: 'line', bang: true, register: true }),
	normal: vim('normal', { bang: true, bar: false }),
	sort: vim('sort', { bang: true, defaultRange: '%' }),
	undo: vim('undo', { range: 'none', nargs: '?' }),
	redo: vim('redo', { range: 'none', nargs: 'none' }),
	mark: vim('mark', { range: 'line' }),
	set: vim('set', { range: 'none', complete: 'option' }),
	registers: vim('registers', { range: 'none' }),
	marks: vim('marks', { range: 'none' }),
	retab: vim('retab', { bang: true, defaultRange: '%' }),
	left: vim('left'),
	right: vim('right'),
	center: vim('center'),
	'<': vim('<'),
	'>': vim('>'),
	'@': vim('@', { range: 'line' }),
	'=': vim('=', { range: 'line', nargs: 'none' }),
	// `:r [file]`, `:r !{cmd}`: its lines below the line (`:0r` above the first)
	read: vim('read', { range: 'line', bang: true, nargs: '?', complete: 'file', shell: true }),
	// `:!{cmd}` (a terminal), `:{range}!{cmd}` (a filter): vimEngine.ts exShell
	'!': vim('!', { nargs: '+', bar: false, complete: 'file', shell: true }),
	// `:js {code}`, `:js ={expr}`, `:[range]jsdo {body}`: the local extension host (vimEngine.ts exJs; not in an untrusted workspace)
	js: vim('js', { range: 'none', nargs: '+', bar: false }),
	jsdo: vim('jsdo', { nargs: '+', bar: false, defaultRange: '%' }),
};

// ---- the user's commands ----------------------------------------------------------

const USER_NAME = /^[A-Z][A-Za-z0-9]*$/;
const SPEC_KEYS: ReadonlySet<string> = new Set(['command', 'args', 'commands', 'nargs', 'range', 'defaultRange', 'bang', 'register', 'complete', 'bar', 'description']);
const NARGS: ReadonlySet<string> = new Set(['none', '0', '1', '?', '*', '+']);
const RANGES: ReadonlySet<string> = new Set(['none', 'line', 'range', 'count']);
/** What `complete` may say. */
export const EX_COMPLETE = /^(file|command|option|buffer|command:\S+)$/;

function isStep(v: unknown): v is ExStep {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) {
		return false;
	}
	const s = v as Record<string, unknown>;
	return typeof s.command === 'string' && s.command.length > 0 && Object.keys(s).every(k => k === 'command' || k === 'args' || k === 'ifBang')
		&& (s.ifBang === undefined || typeof s.ifBang === 'boolean');
}

/** Whether a step's args use the argument placeholders (then nargs defaults to `*`). */
function usesArgs(value: unknown): boolean {
	if (typeof value === 'string') {
		return /\$\{(args|argList)\}/.test(value);
	}
	if (Array.isArray(value)) {
		return value.some(usesArgs);
	}
	if (typeof value === 'object' && value !== null) {
		return Object.values(value).some(usesArgs);
	}
	return false;
}

/**
 * One `devhub.vim.exCommands` value checked: the spec it is, or why it is not
 * one. (The settings' JSON schema says the same to the settings editor.)
 */
export function validateExCommandSpec(v: unknown): ExCommandSpec | string {
	if (typeof v === 'string') {
		return v ? { command: v } : 'the command id is empty';
	}
	if (Array.isArray(v)) {
		return 'a list of commands goes in { "commands": [...] }';
	}
	if (typeof v !== 'object' || v === null) {
		return 'expected a command id or { "command": ... } / { "commands": [...] }';
	}
	const o = v as Record<string, unknown>;
	const unknown = Object.keys(o).filter(k => !SPEC_KEYS.has(k));
	if (unknown.length) {
		return unknown.includes('run') ? '{ "run", "bang" } is now { "commands": [...] } with "ifBang" on the steps, and "bang": true'
			: `unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.map(k => `"${k}"`).join(', ')}`;
	}
	if ((o.command === undefined) === (o.commands === undefined)) {
		return 'give either "command" or "commands"';
	}
	if (o.command !== undefined && (typeof o.command !== 'string' || !o.command)) {
		return '"command" must be a command id';
	}
	if (o.commands !== undefined && (!Array.isArray(o.commands) || !o.commands.length || !o.commands.every(s => (typeof s === 'string' && s.length > 0) || isStep(s)))) {
		return '"commands" must be a list of command ids and { "command", "args"?, "ifBang"? }';
	}
	if (o.args !== undefined && o.commands !== undefined) {
		return '"args" goes with "command"; in "commands" each step has its own';
	}
	if (o.nargs !== undefined && !NARGS.has(o.nargs as string)) {
		return '"nargs" must be "none", "1", "?", "*" or "+"';
	}
	if (o.range !== undefined && !RANGES.has(o.range as string)) {
		return '"range" must be "none", "line", "range" or "count"';
	}
	const range = (o.range ?? 'none') as ExRangeKind;
	if (o.defaultRange !== undefined) {
		const d = o.defaultRange;
		const ok = range === 'count' ? typeof d === 'number' && Number.isInteger(d) && d >= 0
			: range === 'range' ? d === '.' || d === '%'
				: range === 'line' ? d === '.' : false;
		if (!ok) {
			return '"defaultRange" is "." or "%" for "range": "range", "." for "line", a number for "count"';
		}
	}
	for (const k of ['bang', 'register', 'bar'] as const) {
		if (o[k] !== undefined && typeof o[k] !== 'boolean') {
			return `"${k}" must be true or false`;
		}
	}
	if (o.complete !== undefined && (typeof o.complete !== 'string' || !EX_COMPLETE.test(o.complete))) {
		return '"complete" must be "file", "command", "option", "buffer" or "command:<id>"';
	}
	if (o.description !== undefined && typeof o.description !== 'string') {
		return '"description" must be a string';
	}
	return o as ExCommandSpec;
}

/** A user's spec with the attributes it leaves out: the built-in's it overrides, or Vim's `:command` defaults. */
function toSpec(u: ExCommandSpec, base: ExSpec | undefined): ExSpec {
	const steps = u.commands ? toSteps(u.commands) : [u.args === undefined ? { command: u.command! } : { command: u.command!, args: u.args }];
	const range = u.range ?? base?.range ?? 'none';
	return {
		steps,
		nargs: u.nargs ?? base?.nargs ?? (steps.some(s => usesArgs(s.args)) ? '*' : 'none'),
		range,
		defaultRange: u.defaultRange ?? (range === 'count' ? 0 : base && base.range === range ? base.defaultRange : '.'),
		bang: u.bang ?? base?.bang ?? false,
		register: u.register ?? base?.register ?? false,
		bar: u.bar ?? base?.bar ?? true,
		user: true,
		...(u.complete ?? base?.complete ? { complete: u.complete ?? base?.complete } : {}),
		...(u.description !== undefined ? { description: u.description } : {}),
	};
}

/**
 * All the ex commands there are: Vim's built-ins, with the user's
 * `devhub.vim.exCommands` added (uppercase names) or put in their place
 * (any name a built-in answers to).
 */
export class ExRegistry {

	/** The user's own commands, by name. */
	private readonly user = new Map<string, ExSpec>();
	/** The user's specs for built-in names, by canonical name. */
	private readonly overrides = new Map<string, ExSpec>();
	/** Entries that cannot be used, with the reason (Vim's E182 / E183 or the spec's problem). */
	readonly errors: ReadonlyMap<string, string>;

	constructor(raw?: unknown) {
		const errors = new Map<string, string>();
		this.errors = errors;
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
			return;
		}
		for (const [name, value] of Object.entries(raw)) {
			const canonical = USER_NAME.test(name) ? undefined : canonicalExName(name);
			if (!USER_NAME.test(name) && canonical === undefined) {
				errors.set(name, /^[A-Z]/.test(name) ? `E182: Invalid command name: ${name}` : `E183: User defined commands must start with an uppercase letter: ${name}`);
				continue;
			}
			const spec = validateExCommandSpec(value);
			if (typeof spec === 'string') {
				errors.set(canonical ?? name, `devhub.vim.exCommands: ${name}: ${spec}`);
				continue;
			}
			if (canonical !== undefined) {
				this.overrides.set(canonical, toSpec(spec, BUILTIN_EX_SPECS[canonical]));
			} else {
				this.user.set(name, toSpec(spec, undefined));
			}
		}
	}

	/** What a typed name is: a user command (by its name or a unique prefix of it, as Vim matches them), a built-in (by Vim's abbreviations), or Vim's error. */
	lookup(typed: string): { readonly name: string; readonly spec: ExSpec } | { readonly error: string } {
		if (/^[A-Z]/.test(typed)) {
			const exact = this.user.get(typed);
			if (exact) {
				return { name: typed, spec: exact };
			}
			const broken = this.errors.get(typed);
			if (broken) {
				return { error: broken };
			}
			const matches = [...this.user.keys()].filter(n => n.startsWith(typed));
			if (matches.length === 1) {
				return { name: matches[0], spec: this.user.get(matches[0])! };
			}
			return { error: matches.length ? `E464: Ambiguous use of user-defined command: ${typed}` : `E492: Not an editor command: ${typed}` };
		}
		const canonical = canonicalExName(typed);
		if (canonical === undefined) {
			return { error: this.errors.get(typed) ?? `E492: Not an editor command: ${typed}` };
		}
		const broken = this.errors.get(canonical);
		if (broken) {
			return { error: broken };
		}
		const spec = this.overrides.get(canonical) ?? BUILTIN_EX_SPECS[canonical];
		return spec ? { name: canonical, spec } : { error: `E492: Not an editor command: ${typed}` };
	}

	/** Every command for the prompt's completion: Vim's names (`sp[lit]`, what an alias stands for) and the user's. */
	list(): { readonly name: string; readonly detail: string; readonly user: boolean }[] {
		const out: { name: string; detail: string; user: boolean }[] = [];
		for (const { name, abbrev, alias } of builtinExNameInfo()) {
			const canonical = alias ?? name;
			const user = this.overrides.get(canonical);
			const spec = user ?? BUILTIN_EX_SPECS[canonical];
			const short = abbrev === name ? name : `${abbrev}[${name.slice(abbrev.length)}]`;
			const what = user ? describeExSpec(user) + ' (devhub.vim.exCommands)' : spec ? describeExSpec(spec) : '';
			out.push({ name, detail: `:${short}${alias ? ` = :${alias}` : ''}${what ? ` - ${what}` : ''}`, user: !!user });
		}
		for (const [name, spec] of this.user) {
			out.push({ name, detail: describeExSpec(spec), user: true });
		}
		return out;
	}
}

/** What a command runs, in a few words: its description, Vim for the engine's, or its command ids. */
export function describeExSpec(spec: ExSpec): string {
	if (spec.description !== undefined) {
		return spec.description;
	}
	if (spec.engine) {
		return 'Vim';
	}
	return [...new Set(spec.steps.map(s => s.command))].join(', ');
}

/** The registry of Vim's built-ins alone. */
export const BUILTIN_EX_REGISTRY = new ExRegistry();

// ---- file arguments ------------------------------------------------------------

/** Where a file argument is resolved: paths (`/`-separated) in the file system of the workspace. */
export interface ExFileContext {
	/** Vim's current directory: relative names start here. */
	readonly cwd: string;
	/** The current file (`%`), if it has a name. */
	readonly current?: string;
	/** The user's home directory (`~`). */
	readonly home?: string;
}

/** A file argument resolved: an absolute path, a pattern for quick open (`*`), or Vim's error. */
export type ExFileArg = { readonly path: string } | { readonly glob: string } | { readonly error: string };

function posixDirname(p: string): string {
	const i = p.replace(/\/+$/, '').lastIndexOf('/');
	return i <= 0 ? '/' : p.slice(0, i);
}

function posixBasename(p: string): string {
	const t = p.replace(/\/+$/, '');
	return t.slice(t.lastIndexOf('/') + 1);
}

/** `.` and `..` and repeated slashes resolved; absolute in, absolute out. */
export function normalizeExPath(p: string): string {
	const out: string[] = [];
	for (const part of p.split('/')) {
		if (part === '' || part === '.') {
			continue;
		}
		if (part === '..') {
			out.pop();
		} else {
			out.push(part);
		}
	}
	return '/' + out.join('/');
}

/** Vim's filename modifiers on a path (`:p` `:h` `:t` `:r` `:e`), in order. */
export function applyFileModifiers(path: string, mods: string): string {
	let p = path;
	for (const m of mods.split(':').slice(1)) {
		switch (m) {
			case 'p': break; // already absolute
			case 'h': p = posixDirname(p); break;
			case 't': p = posixBasename(p); break;
			case 'r': {
				const tail = posixBasename(p);
				const dot = tail.lastIndexOf('.');
				p = dot > 0 ? p.slice(0, p.length - (tail.length - dot)) : p;
				break;
			}
			case 'e': {
				const tail = posixBasename(p);
				const dot = tail.lastIndexOf('.');
				p = dot > 0 ? tail.slice(dot + 1) : '';
				break;
			}
		}
	}
	return p;
}

/**
 * A file argument of `:e` `:sp` `:vs` `:new` `:vne` `:tabe` `:tabnew`, as Vim
 * reads it: relative to the current directory (`ctx.cwd`), `/...` absolute
 * (`C:\...` / `C:/...` too), `~` / `~/...` the home directory, `%` the current
 * file with `:p` `:h` `:t` `:r` `:e` modifiers (`%:h/x`), `\ ` `\%` `\#` `\*`
 * a literal blank, `%`, `#`, `*`. A name with `*` is a pattern (for quick open).
 * Undefined: no argument.
 */
export function resolveExFileArg(arg: string, ctx: ExFileContext): ExFileArg | undefined {
	let typed = arg.trim();
	if (!typed) {
		return undefined;
	}
	if (/(^|[^\\])\*/.test(typed)) {
		return { glob: typed };
	}
	if (/^[A-Za-z]:[\\/]/.test(typed)) {
		typed = '/' + typed.replace(/\\/g, '/');
	}
	let out = '';
	let i = 0;
	if (typed === '~' || typed.startsWith('~/')) {
		if (ctx.home === undefined) {
			return { error: 'No home directory for ~' };
		}
		out = ctx.home.replace(/\/+$/, '');
		i = 1;
	}
	while (i < typed.length) {
		const c = typed[i];
		if (c === '\\' && i + 1 < typed.length && ' %#*\\'.includes(typed[i + 1])) {
			out += typed[i + 1];
			i += 2;
			continue;
		}
		if (c === '%') {
			const mods = /^(:[phtre])*/.exec(typed.slice(i + 1))![0];
			if (ctx.current === undefined) {
				return { error: 'E499: Empty file name for \'%\' or \'#\', only works with ":p:h"' };
			}
			out += applyFileModifiers(ctx.current, mods);
			i += 1 + mods.length;
			continue;
		}
		out += c;
		i++;
	}
	if (out.startsWith('/')) {
		return { path: normalizeExPath(out) };
	}
	return { path: normalizeExPath(ctx.cwd + '/' + out) };
}

// ---- file encodings and formats ----------------------------------------------------

/**
 * The encodings VS Code writes and reads (SUPPORTED_ENCODINGS in
 * services/textfile/common/encoding.ts: its ids, which "Save with Encoding" and
 * "Reopen with Encoding" take), each with the names Vim and iconv call it by
 * (normalized: lower case, no `-` `_` or blank). A test checks that every id is
 * one VS Code has, so a bump that renames one is found.
 */
const VIM_ENCODINGS: readonly (readonly [id: string, label: string, ...names: string[]])[] = [
	['utf8', 'UTF-8', 'utf8'],
	['utf8bom', 'UTF-8 with BOM', 'utf8bom'],
	['utf16le', 'UTF-16 LE', 'utf16le', 'ucs2le'],
	['utf16be', 'UTF-16 BE', 'utf16be', 'utf16', 'ucs2be', 'ucs2'],
	['windows1252', 'Western (Windows 1252)', 'cp1252', 'windows1252'],
	['iso88591', 'Western (ISO 8859-1)', 'latin1', 'iso88591'],
	['iso88593', 'Western (ISO 8859-3)', 'latin3', 'iso88593'],
	['iso885915', 'Western (ISO 8859-15)', 'latin9', 'iso885915'],
	['macroman', 'Western (Mac Roman)', 'macroman', 'mac', 'applemac'],
	['cp437', 'DOS (CP 437)', 'cp437', 'ibm437'],
	['windows1256', 'Arabic (Windows 1256)', 'cp1256'],
	['iso88596', 'Arabic (ISO 8859-6)'],
	['windows1257', 'Baltic (Windows 1257)', 'cp1257'],
	['iso88594', 'Baltic (ISO 8859-4)', 'latin4'],
	['iso885914', 'Celtic (ISO 8859-14)', 'latin8'],
	['windows1250', 'Central European (Windows 1250)', 'cp1250'],
	['iso88592', 'Central European (ISO 8859-2)', 'latin2'],
	['cp852', 'Central European (CP 852)', 'ibm852'],
	['windows1251', 'Cyrillic (Windows 1251)', 'cp1251'],
	['cp866', 'Cyrillic (CP 866)', 'ibm866'],
	['cp1125', 'Cyrillic (CP 1125)', 'ibm1125'],
	['iso88595', 'Cyrillic (ISO 8859-5)'],
	['koi8r', 'Cyrillic (KOI8-R)'],
	['koi8u', 'Cyrillic (KOI8-U)'],
	['iso885913', 'Estonian (ISO 8859-13)', 'latin7'],
	['windows1253', 'Greek (Windows 1253)', 'cp1253'],
	['iso88597', 'Greek (ISO 8859-7)'],
	['windows1255', 'Hebrew (Windows 1255)', 'cp1255'],
	['iso88598', 'Hebrew (ISO 8859-8)'],
	['iso885910', 'Nordic (ISO 8859-10)', 'latin6'],
	['iso885916', 'Romanian (ISO 8859-16)', 'latin10'],
	['windows1254', 'Turkish (Windows 1254)', 'cp1254'],
	['iso88599', 'Turkish (ISO 8859-9)', 'latin5'],
	['cp857', 'Turkish (CP 857)', 'ibm857'],
	['windows1258', 'Vietnamese (Windows 1258)', 'cp1258'],
	['gbk', 'Simplified Chinese (GBK)', 'cp936'],
	['gb18030', 'Simplified Chinese (GB18030)'],
	['cp950', 'Traditional Chinese (Big5)', 'big5'],
	['big5hkscs', 'Traditional Chinese (Big5-HKSCS)'],
	['shiftjis', 'Japanese (Shift JIS)', 'sjis', 'cp932', 'mskanji', 'windows31j', 'ms932', 'csshiftjis'],
	['eucjp', 'Japanese (EUC-JP)', 'ujis'],
	['euckr', 'Korean (EUC-KR)', 'cp949'],
	['windows874', 'Thai (Windows 874)', 'cp874'],
	['iso885911', 'Latin/Thai (ISO 8859-11)'],
	['koi8ru', 'Cyrillic (KOI8-RU)'],
	['koi8t', 'Tajik (KOI8-T)'],
	['gb2312', 'Simplified Chinese (GB 2312)', 'euccn'],
	['cp865', 'Nordic DOS (CP 865)', 'ibm865'],
	['cp850', 'Western European DOS (CP 850)', 'ibm850'],
];

function normalizeEncodingName(name: string): string {
	return name.toLowerCase().replace(/[-_\s]/g, '');
}

/** Every VS Code encoding id `:set fenc=` takes, in the order of the status bar's "Select Encoding", with its label. */
export function vimEncodingList(): { readonly id: string; readonly label: string }[] {
	return VIM_ENCODINGS.map(([id, label]) => ({ id, label }));
}

/**
 * VS Code's encoding id for a name as Vim (or iconv) spells it: `utf-8`,
 * `UTF8`, `cp932` / `sjis` / `shift_jis` (Shift JIS), `euc-jp`, `latin1`,
 * `iso-8859-15`, `utf-16le`, `windows-1252` / `cp1252`, a VS Code id itself;
 * undefined when VS Code cannot read or write it.
 */
export function vimEncodingId(name: string): string | undefined {
	const n = normalizeEncodingName(name);
	if (!n) {
		return undefined;
	}
	for (const [id, , ...names] of VIM_ENCODINGS) {
		if (id === n || names.includes(n)) {
			return id;
		}
	}
	return undefined;
}

/** Completions for `fenc=` and `++enc=`: the ids whose name (or a Vim spelling of it) starts with what is typed. */
export function vimEncodingCompletions(typed: string): { readonly id: string; readonly label: string }[] {
	const n = normalizeEncodingName(typed);
	return VIM_ENCODINGS.filter(([id, , ...names]) => id.startsWith(n) || names.some(x => x.startsWith(n))).map(([id, label]) => ({ id, label }));
}

/** The encodings that always carry a BOM when written: 'bomb' is on for them and cannot be turned off. */
export function vimEncodingHasBom(id: string): boolean {
	return id === 'utf8bom' || id === 'utf16le' || id === 'utf16be';
}

/** `unix` / `dos` ('fileformat') as VS Code's line endings: `\n` and `\r\n`; `mac` (`\r`) is not one of them. */
export function vimFileFormat(name: string): 'unix' | 'dos' | undefined {
	const n = name.toLowerCase();
	return n === 'unix' || n === 'dos' ? n : undefined;
}

/** The names `:set ff=` completes. */
export const VIM_FILE_FORMATS = [{ name: 'unix', detail: 'LF' }, { name: 'dos', detail: 'CRLF' }] as const;

/** The `++opt` words in front of a file argument (`:e ++enc=cp932 {file}`, `:w ++ff=dos {file}`) and what follows them. */
export interface ExFileOptions {
	/** `++enc=` / `++encoding=`: VS Code's encoding id. */
	readonly enc?: string;
	/** `++ff=` / `++fileformat=`. */
	readonly ff?: 'unix' | 'dos';
	/** The argument without them. */
	readonly rest: string;
}

/**
 * The `++enc=` and `++ff=` words an argument starts with (`:help ++opt`), or
 * Vim's error: an unknown encoding or format, `mac`, and the options VS Code
 * has no equivalent for (`++bin` `++edit` `++bad=`) are E474.
 */
export function parseExFileOptions(args: string): ExFileOptions | { readonly error: string } {
	let rest = args.trimStart();
	let enc: string | undefined;
	let ff: 'unix' | 'dos' | undefined;
	for (let m = /^\+\+(\S*)\s*/.exec(rest); m; m = /^\+\+(\S*)\s*/.exec(rest)) {
		const word = m[0].trim();
		const eq = m[1].indexOf('=');
		const name = eq < 0 ? m[1] : m[1].slice(0, eq);
		const value = eq < 0 ? undefined : m[1].slice(eq + 1);
		if (name === 'enc' || name === 'encoding') {
			enc = value === undefined ? undefined : vimEncodingId(value);
			if (enc === undefined) {
				return { error: `E474: Invalid argument: ${word}` };
			}
		} else if (name === 'ff' || name === 'fileformat') {
			ff = value === undefined ? undefined : vimFileFormat(value);
			if (ff === undefined) {
				return { error: value?.toLowerCase() === 'mac' ? `E474: Invalid argument: ${word} (VS Code has no CR line endings)` : `E474: Invalid argument: ${word}` };
			}
		} else {
			return { error: `E474: Invalid argument: ${word}${/^(bin|binary|nobin|nobinary|edit|bad|bad=.*)$/.test(m[1]) ? ' (not supported)' : ''}` };
		}
		rest = rest.slice(m[0].length);
	}
	return { ...(enc !== undefined ? { enc } : {}), ...(ff !== undefined ? { ff } : {}), rest };
}

// ---- parsing ------------------------------------------------------------------

/** One command of an ex line, as the parser read it (before the range is resolved against the buffer). */
export interface ParsedExCommand {
	/** Where it starts and ends in the line (the end is its `|`, or the end of the line). */
	readonly start: number;
	readonly end: number;
	/** Raw addresses, e.g. ["'<", "'>"], ["1", "$"] for `%`, ["5", "5"] for `5`, ["/foo/", "."]. */
	readonly range: readonly [string, string] | undefined;
	/** The addresses were separated by `;` (the second is relative to the first). */
	readonly semicolon: boolean;
	/** Where the name starts, and the name as typed. */
	readonly nameStart: number;
	readonly name: string;
	/** The command the name is (a canonical built-in name or the user's name), and its spec. */
	readonly command?: string;
	readonly spec?: ExSpec;
	readonly bang: boolean;
	/** Where the argument starts, and the argument (`\|` is `|` for a command that takes `|`). */
	readonly argStart: number;
	readonly args: string;
	/** Vim's error for this command (an unknown name, `!` or a range it does not take, a missing or extra argument). */
	readonly error?: string;
}

/** One address at `s[i]`: where it ends. */
function scanAddress(s: string, i: number): number {
	const c = s[i];
	if (c !== undefined && /[0-9]/.test(c)) {
		while (i < s.length && /[0-9]/.test(s[i])) {
			i++;
		}
	} else if (c === '.' || c === '$') {
		i++;
	} else if (c === '\'' && i + 1 < s.length) {
		i += 2;
	} else if (c === '/' || c === '?') {
		i++;
		while (i < s.length && s[i] !== c) {
			if (s[i] === '\\') {
				i++;
			}
			i++;
		}
		if (i < s.length) {
			i++;
		}
		i = Math.min(i, s.length);
	} else if (c === '\\' && (s[i + 1] === '/' || s[i + 1] === '?' || s[i + 1] === '&')) {
		i += 2;
	}
	while (i < s.length && (s[i] === '+' || s[i] === '-')) {
		i++;
		while (i < s.length && /[0-9]/.test(s[i])) {
			i++;
		}
	}
	return i;
}

/** The `[range]` at `from` (after blanks and colons): the addresses and where they end. */
function scanRange(line: string, from: number): { range: [string, string] | undefined; semicolon: boolean; end: number } {
	let i = from;
	if (line[i] === '%') {
		return { range: ['1', '$'], semicolon: false, end: i + 1 };
	}
	if (line[i] === '*') {
		return { range: ['\'<', '\'>'], semicolon: false, end: i + 1 };
	}
	const addrs: string[] = [];
	let semicolon = false;
	let j = scanAddress(line, i);
	addrs.push(line.slice(i, j));
	i = j;
	while (line[i] === ',' || line[i] === ';') {
		semicolon = line[i] === ';';
		j = scanAddress(line, i + 1);
		addrs.push(line.slice(i + 1, j) || '.');
		i = j;
	}
	let range: [string, string] | undefined;
	if (addrs.length > 1) {
		range = [addrs[addrs.length - 2] || '.', addrs[addrs.length - 1]];
	} else if (addrs[0]) {
		range = [addrs[0], addrs[0]];
	}
	return { range, semicolon: semicolon && !!range, end: i };
}

function skipBlanks(line: string, i: number): number {
	while (i < line.length && /\s/.test(line[i])) {
		i++;
	}
	return i;
}

/** The name at `i`: `&&` `&` `~` `<` `>` `@` `=` `!`, a built-in's letters (`d` of `d3`), a user's letters and digits. */
function scanName(line: string, i: number): number {
	const special = /^(&&|[&~<>@=!])/.exec(line.slice(i));
	if (special) {
		return i + special[1].length;
	}
	const word = /^[A-Z]/.test(line[i] ?? '') ? /^[A-Za-z0-9]+/ : /^[A-Za-z]+/;
	const m = word.exec(line.slice(i));
	return i + (m ? m[0].length : 0);
}

/** The argument from `i`: up to an unescaped `|` when the command takes it (`\|` is a `|`), else the rest of the line. */
function scanArgs(line: string, i: number, bar: boolean): { args: string; end: number } {
	if (!bar) {
		return { args: line.slice(i), end: line.length };
	}
	let out = '';
	for (; i < line.length; i++) {
		if (line[i] === '\\' && line[i + 1] === '|') {
			out += '|';
			i++;
			continue;
		}
		if (line[i] === '|') {
			return { args: out, end: i };
		}
		out += line[i];
	}
	return { args: out, end: line.length };
}

/** Whether the argument fits `nargs`; Vim's error otherwise. */
function checkArgs(args: string, nargs: ExNargs): string | undefined {
	const blank = !args.trim();
	if ((nargs === 'none' || nargs === '0') && !blank) {
		return `E488: Trailing characters: ${args.trim()}`;
	}
	if ((nargs === '1' || nargs === '+') && blank) {
		return 'E471: Argument required';
	}
	return undefined;
}

/**
 * The command of `line` that starts at `from`, as Vim reads it: blanks and
 * colons, the range, the name (looked up in `registry`), `!`, then the
 * argument as the command's spec takes it: to the next unescaped `|` when the
 * command takes `|` (`bar`), or to the end of the line (`:g`, `:normal`,
 * `:!cmd`, `:r !cmd`, `:w !cmd`, `:js`, `:jsdo`, a user command with `bar: false`).
 */
export function parseExCommand(line: string, registry: ExRegistry, from = 0): ParsedExCommand {
	let i = from;
	while (i < line.length && (/\s/.test(line[i]) || line[i] === ':')) {
		i++;
	}
	const r = scanRange(line, i);
	i = skipBlanks(line, r.end);
	const nameStart = i;
	i = scanName(line, i);
	let name = line.slice(nameStart, i);
	const base = { start: from, range: r.range, semicolon: r.semicolon, nameStart };
	if (!name) {
		// `:{range}` alone; anything else here names no command
		const rest = scanArgs(line, i, true);
		const error = rest.args.trim() ? `E492: Not an editor command: ${line.slice(from, rest.end).trim()}` : undefined;
		return { ...base, end: rest.end, name: '', bang: false, argStart: i, args: '', ...(error ? { error } : {}) };
	}
	let found = registry.lookup(name);
	if ('error' in found && /^k[a-zA-Z]$/.test(name)) {
		// `:ka`: `:k` with the mark name glued on
		name = 'k';
		i = nameStart + 1;
		found = registry.lookup(name);
	}
	if ('error' in found) {
		return { ...base, end: line.length, name, bang: false, argStart: i, args: line.slice(i), error: found.error };
	}
	const spec = found.spec;
	let bang = false;
	if (line[i] === '!' && name !== '!') {
		bang = true;
		i++;
	}
	let argStart = skipBlanks(line, i);
	let shellArg = spec.shell === true && (found.name === '!' || line[argStart] === '!');
	if (found.name === 'read' && bang && !spec.user) {
		// `:r!cmd` is `:r !cmd`
		bang = false;
		argStart = i - 1;
		shellArg = true;
	}
	const { args, end } = scanArgs(line, argStart, spec.bar && !shellArg);
	let error: string | undefined;
	if (bang && !spec.bang) {
		error = 'E477: No ! allowed';
	} else if (r.range && spec.range === 'none') {
		error = 'E481: No range allowed';
	} else {
		// range "count": a count may be the first argument (`:Name 3`)
		error = checkArgs(spec.range === 'count' ? args.replace(/^\s*\d+(?:\s+|$)/, '') : args, spec.nargs);
	}
	return {
		...base, end, name, command: found.name, spec, bang, argStart, args,
		...(error ? { error } : {}),
	};
}

/** Every command of an ex line, split at `|` where the commands take it. */
export function parseExCommands(line: string, registry: ExRegistry): ParsedExCommand[] {
	const out: ParsedExCommand[] = [];
	let from = 0;
	for (; ;) {
		const p = parseExCommand(line, registry, from);
		out.push(p);
		if (p.end >= line.length) {
			return out;
		}
		from = p.end + 1;
	}
}

/** `*` / `+` arguments: split on blanks (`\ ` is a blank in one). */
export function splitExArgs(args: string): string[] {
	const out: string[] = [];
	let cur = '';
	let any = false;
	for (let i = 0; i < args.length; i++) {
		const c = args[i];
		if (c === '\\' && /\s/.test(args[i + 1] ?? '')) {
			cur += args[++i];
			any = true;
			continue;
		}
		if (/\s/.test(c)) {
			if (any) {
				out.push(cur);
			}
			cur = '';
			any = false;
			continue;
		}
		cur += c;
		any = true;
	}
	if (any) {
		out.push(cur);
	}
	return out;
}

export interface ExAddressContext {
	/** 0-based. */
	readonly cursorLine: number;
	readonly lastLine: number;
	/** The last visual selection's lines (0-based), for `'<` and `'>`. */
	readonly visual: { readonly start: number; readonly end: number } | undefined;
	/** The line of mark `name` (0-based), if set. */
	readonly mark?: (name: string) => number | undefined;
	/** The next (or previous) line matching a pattern (a JavaScript regex, VS Code's find), from `line` exclusive, wrapping; empty pattern = the last search. */
	readonly search?: (pattern: string, backwards: boolean, line: number) => number | undefined;
}

/** A raw address to a 0-based line, clamped to the buffer; undefined when it names an unset mark or a pattern not found. */
export function resolveExAddress(address: string, ctx: ExAddressContext): number | undefined {
	const [base, offsets] = scanBase(address);
	if (offsets === undefined) {
		return undefined;
	}
	let line: number | undefined;
	if (base === '' || base === '.') {
		line = ctx.cursorLine;
	} else if (base === '$') {
		line = ctx.lastLine;
	} else if (/^[0-9]+$/.test(base)) {
		line = Number(base) - 1;
	} else if (base[0] === '\'') {
		const name = base[1];
		if (name === '<' || name === '>') {
			line = ctx.visual ? (name === '<' ? ctx.visual.start : ctx.visual.end) : undefined;
		} else {
			line = ctx.mark?.(name);
		}
	} else if (base[0] === '/' || base[0] === '?') {
		const back = base[0] === '?';
		let pat = base.slice(1);
		if (pat.endsWith(base[0]) && !pat.endsWith('\\' + base[0])) {
			pat = pat.slice(0, -1);
		}
		line = ctx.search?.(pat, back, ctx.cursorLine);
	} else if (base === '\\/' || base === '\\?' || base === '\\&') {
		line = ctx.search?.('', base === '\\?', ctx.cursorLine);
	}
	if (line === undefined) {
		return undefined;
	}
	for (const off of offsets.match(/[+-]\d*/g) ?? []) {
		const n = off.length > 1 ? Number(off.slice(1)) : 1;
		line += off[0] === '+' ? n : -n;
	}
	return Math.max(0, Math.min(ctx.lastLine, line));
}

function scanBase(address: string): [string, string | undefined] {
	if (scanAddress(address, 0) !== address.length) {
		return ['', undefined];
	}
	const m = /^((?:[+-]\d*)*)$/.exec(address);
	if (m) {
		return ['', m[1]];
	}
	let i = 0;
	const c = address[0];
	if (/[0-9]/.test(c)) {
		while (/[0-9]/.test(address[i] ?? '')) {
			i++;
		}
	} else if (c === '.' || c === '$') {
		i = 1;
	} else if (c === '\'') {
		i = 2;
	} else if (c === '/' || c === '?') {
		i = 1;
		while (i < address.length && address[i] !== c) {
			if (address[i] === '\\') {
				i++;
			}
			i++;
		}
		i = Math.min(address.length, i + 1);
	} else if (c === '\\') {
		i = 2;
	}
	return [address.slice(0, i), address.slice(i)];
}

/**
 * A parsed range as 0-based lines (`a;b`: b from a), or undefined when a mark
 * or a pattern it names is not there. The engine resolves every command's
 * range with this, built-in or the user's.
 */
export function resolveExRange(p: Pick<ParsedExCommand, 'range' | 'semicolon'>, ctx: ExAddressContext): { start: number; end: number } | undefined {
	if (!p.range) {
		return undefined;
	}
	const a = resolveExAddress(p.range[0], ctx);
	const b = p.semicolon && a !== undefined ? resolveExAddress(p.range[1], { ...ctx, cursorLine: a }) : resolveExAddress(p.range[1], ctx);
	if (a === undefined || b === undefined) {
		return undefined;
	}
	return a <= b ? { start: a, end: b } : { start: b, end: a };
}

// ---- what a command's steps run with -----------------------------------------------------

export interface ExInvocation {
	readonly args: string;
	readonly argList: readonly string[];
	readonly bang: boolean;
	/** 1-based lines as typed, or undefined when no range was typed. */
	readonly range: { readonly start: number; readonly end: number } | undefined;
	/** The lines it runs on (1-based): the range, or the default one. */
	readonly line1: number;
	readonly line2: number;
	readonly count: number | undefined;
	readonly register: string;
}

/**
 * What a user's (or a VS Code built-in's) command runs with, from what was
 * typed: the argument (a register name first for `register`, a count first
 * for range `count`, or before the name), the lines (`defaultRange` without a
 * typed range).
 * `range` and `cursorLine` / `lastLine` are 0-based.
 */
export function exInvocation(spec: ExSpec, p: Pick<ParsedExCommand, 'args' | 'bang' | 'range'>, range: { start: number; end: number } | undefined, cursorLine: number, lastLine: number): ExInvocation {
	// `:3Name`: the number as typed (an address would be clamped to the buffer)
	const typedCount = p.range && /^\d+$/.test(p.range[1]) ? Number(p.range[1]) : undefined;
	let args = p.args.trim();
	let register = '';
	if (spec.register) {
		const m = /^([^\d\s])(?:\s+|$)/.exec(args);
		if (m) {
			register = m[1];
			args = args.slice(m[0].length);
		}
	}
	let count: number | undefined;
	let lines = range;
	if (spec.range === 'count') {
		const m = /^(\d+)(?:\s+|$)/.exec(args);
		if (m) {
			count = Number(m[1]);
			args = args.slice(m[0].length);
		} else if (typedCount !== undefined) {
			count = typedCount;
		} else if (range) {
			count = range.end + 1;
		} else {
			count = typeof spec.defaultRange === 'number' ? spec.defaultRange : 0;
		}
		lines = undefined;
	} else if (spec.range === 'line' && range) {
		lines = { start: range.end, end: range.end };
	}
	const all = !lines && spec.range === 'range' && spec.defaultRange === '%';
	const line1 = lines ? lines.start + 1 : all ? 1 : cursorLine + 1;
	const line2 = lines ? lines.end + 1 : all ? lastLine + 1 : cursorLine + 1;
	const argList = spec.nargs === '1' || spec.nargs === '?' ? (args ? [args] : []) : splitExArgs(args);
	return {
		args, argList, bang: p.bang,
		range: lines && spec.range !== 'count' ? { start: lines.start + 1, end: lines.end + 1 } : undefined,
		line1, line2, count, register,
	};
}

function placeholderValue(name: string, inv: ExInvocation): unknown {
	switch (name) {
		case 'args': return inv.args;
		case 'argList': return [...inv.argList];
		case 'bang': return inv.bang;
		case 'range': return inv.range ? { start: inv.range.start, end: inv.range.end } : null;
		case 'line1': return inv.line1;
		case 'line2': return inv.line2;
		case 'count': return inv.count ?? null;
		case 'register': return inv.register;
	}
	return undefined;
}

function placeholderText(name: string, inv: ExInvocation): string | undefined {
	switch (name) {
		case 'bang': return inv.bang ? '!' : '';
		case 'range': return inv.range ? `${inv.range.start},${inv.range.end}` : '';
		case 'argList': return inv.argList.join(' ');
		case 'count': return inv.count === undefined ? '' : String(inv.count);
	}
	const v = placeholderValue(name, inv);
	return v === undefined ? undefined : String(v);
}

/** Fill `${...}` placeholders in a step's args (deeply). Unknown placeholders are left as typed. */
export function substituteExArgs(value: unknown, inv: ExInvocation): unknown {
	if (typeof value === 'string') {
		const exact = /^\$\{(\w+)\}$/.exec(value);
		if (exact) {
			const v = placeholderValue(exact[1], inv);
			return v === undefined ? value : v;
		}
		return value.replace(/\$\{(\w+)\}/g, (all, name: string) => placeholderText(name, inv) ?? all);
	}
	if (Array.isArray(value)) {
		return value.map(v => substituteExArgs(v, inv));
	}
	if (typeof value === 'object' && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = substituteExArgs(v, inv);
		}
		return out;
	}
	return value;
}

/** The steps a command runs for this invocation (`ifBang` decided), args filled in. */
export function expandExSpec(spec: ExSpec, inv: ExInvocation): ExStep[] {
	return spec.steps
		.filter(s => s.ifBang === undefined || s.ifBang === inv.bang)
		.map(s => s.args === undefined ? { command: s.command } : { command: s.command, args: substituteExArgs(s.args, inv) });
}

// ---- shell commands ----------------------------------------------------------------

/**
 * A `:!` command as Vim reads it, first step (the engine's): `!` is the
 * previous command (`:!!` runs it again; E34 without one), `\!` a `!`.
 * `%` and `\%` are left for expandShellPercent.
 */
export function expandShellBang(cmd: string, previous: string | undefined): { readonly cmd: string } | { readonly error: string } {
	let out = '';
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (c === '\\' && cmd[i + 1] === '!') {
			out += '!';
			i++;
			continue;
		}
		if (c === '\\' && cmd[i + 1] === '%') {
			out += '\\%';
			i++;
			continue;
		}
		if (c === '!') {
			if (previous === undefined) {
				return { error: 'E34: No previous command' };
			}
			out += previous;
			continue;
		}
		out += c;
	}
	return { cmd: out };
}

/**
 * The second step (the workbench's, which knows the file): `%` is the current
 * file, relative to the current directory when it is in it, with Vim's `:p`
 * `:h` `:t` `:r` `:e`; `\%` a `%`. E499 when there is no file name.
 */
export function expandShellPercent(cmd: string, ctx: ExFileContext): { readonly cmd: string } | { readonly error: string } {
	let out = '';
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (c === '\\' && cmd[i + 1] === '%') {
			out += '%';
			i++;
			continue;
		}
		if (c === '%') {
			const mods = /^(:[phtre])*/.exec(cmd.slice(i + 1))![0];
			if (ctx.current === undefined) {
				return { error: 'E499: Empty file name for \'%\' or \'#\', only works with ":p:h"' };
			}
			let path = applyFileModifiers(ctx.current, mods.replace(/:p/g, ''));
			const cwd = ctx.cwd.replace(/\/+$/, '');
			if (!mods.includes(':p') && path.startsWith('/')) {
				path = path === cwd ? '.' : path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path;
			}
			out += path;
			i += mods.length;
			continue;
		}
		out += c;
	}
	return { cmd: out };
}

// ---- :substitute ----------------------------------------------------------------

export interface ParsedSubstitute {
	/** Undefined: `:s [flags]` repeats the last pattern and replacement. */
	readonly pattern?: string;
	readonly replacement?: string;
	readonly flags: string;
	readonly count?: number;
	/** Where the line ends, for 'inccommand': in the pattern (no delimiter after it yet), in the replacement, or after it. */
	readonly upTo?: 'pattern' | 'replacement' | 'flags';
}

/** `/{pattern}/{string}/[flags] [count]` with any non-alphanumeric delimiter. */
export function parseSubstitute(args: string): ParsedSubstitute {
	const d = args[0];
	if (d === undefined || /[A-Za-z0-9\s"|\\&]/.test(d)) {
		const m = /^\s*(&?[cegiInp#lr]*)\s*(\d*)\s*$/.exec(args);
		return { flags: m ? m[1] : '', count: m && m[2] ? Number(m[2]) : undefined };
	}
	let i = 1;
	const part = (): string | undefined => {
		let out = '';
		while (i < args.length && args[i] !== d) {
			if (args[i] === '\\' && i + 1 < args.length) {
				// an escaped delimiter is the delimiter itself; anything else stays escaped
				out += args[i + 1] === d ? d : args[i] + args[i + 1];
				i += 2;
				continue;
			}
			out += args[i++];
		}
		if (i >= args.length) {
			return undefined;
		}
		i++;
		return out;
	};
	const start = i;
	let pattern = part();
	if (pattern === undefined) {
		return { pattern: args.slice(start), replacement: '', flags: '', upTo: 'pattern' };
	}
	const repStart = i;
	let replacement = part();
	let rest = '';
	const upTo = replacement === undefined ? 'replacement' : 'flags';
	if (replacement === undefined) {
		replacement = args.slice(repStart).replace(new RegExp('\\\\' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), d);
	} else {
		rest = args.slice(i);
	}
	if (pattern === undefined) {
		pattern = '';
	}
	const m = /^\s*(&?[cegiInp#lr]*)\s*(\d*)/.exec(rest);
	return { pattern, replacement, flags: m ? m[1] : '', count: m && m[2] ? Number(m[2]) : undefined, upTo };
}

/** `:g/pat/cmd`: the pattern and the command (default `p`). */
export function parseGlobal(args: string): { pattern: string; command: string } | undefined {
	const d = args[0];
	if (d === undefined || /[A-Za-z0-9\s"|]/.test(d)) {
		return undefined;
	}
	let i = 1;
	let pattern = '';
	while (i < args.length && args[i] !== d) {
		if (args[i] === '\\' && i + 1 < args.length) {
			pattern += args[i + 1] === d ? d : args[i] + args[i + 1];
			i += 2;
			continue;
		}
		pattern += args[i++];
	}
	const command = i < args.length ? args.slice(i + 1).trim() : '';
	return { pattern, command: command || 'p' };
}
