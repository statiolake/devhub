/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the `:` command line - parsing, Vim's name
// abbreviations (`:s` is `:substitute`, `:sp` is `:split`), ranges, and the
// table of commands that run VS Code commands. Imports nothing (the tests run
// it as they run the engine).
//
// Two kinds of built-in commands:
// * ENGINE_EX_COMMANDS are Vim's editing commands (:s :g :d :m :t :normal
//   :sort ...), implemented by the engine on the buffer (vimEngine.ts).
// * BUILTIN_EX_COMMANDS are names bound to VS Code commands, exactly as a
//   keybinding is a key bound to a command: each step is `{ command, args? }`,
//   run in order (each one awaited).
// `devhub.vim.exCommands` adds the user's own, whose names must start with an
// uppercase letter (as Vim's `:command` requires), and may override any
// built-in name (by its full name or any abbreviation Vim accepts for it).
//
// A step's args may use placeholders, filled from the command line
// `:[range]Name[!] [args]`:
//   "${args}"     the argument string             (string)
//   "${argList}"  the arguments split on blanks    (string[])
//   "${bang}"     whether `!` was given            (boolean)
//   "${range}"    { start, end }, 1-based lines, or null without a range
//   "${line1}" / "${line2}"  first / last line (1-based; the cursor line without a range)
// A string that is exactly a placeholder becomes the typed value; inside a
// longer string it is replaced by its text ("!" or "" for bang, "a,b" for range).

export interface ExStep {
	readonly command: string;
	readonly args?: unknown;
}

export type ExSteps = string | ExStep | readonly (string | ExStep)[];

/** A table entry: steps, or `{ run, bang?, description? }` where `bang` runs instead of `run` for `Name!`. */
export type ExCommandEntry = ExSteps | { readonly run: ExSteps; readonly bang?: ExSteps; readonly description?: string };

// ---- names ------------------------------------------------------------------

/** Vim's built-in names: [full name, shortest accepted abbreviation, canonical name if an alias]. */
const EX_NAMES: readonly (readonly [string, string, string?])[] = [
	['write', 'w'], ['wall', 'wa'], ['update', 'up'], ['quit', 'q'], ['qall', 'qa'], ['quitall', 'quita', 'qall'],
	['wq', 'wq'], ['wqall', 'wqa', 'xall'], ['xit', 'x'], ['xall', 'xa'], ['exit', 'exi', 'xit'],
	['split', 'sp'], ['vsplit', 'vs'], ['new', 'new'], ['vnew', 'vne'], ['edit', 'e'], ['enew', 'ene'],
	['tabnew', 'tabnew'], ['tabedit', 'tabe'], ['tabnext', 'tabn'], ['tabprevious', 'tabp'], ['tabNext', 'tabN', 'tabprevious'],
	['tabclose', 'tabc'], ['tabonly', 'tabo'], ['tabfirst', 'tabfir'], ['tablast', 'tabl'],
	['bnext', 'bn'], ['bprevious', 'bp'], ['bNext', 'bN', 'bprevious'], ['bdelete', 'bd'], ['bwipeout', 'bw', 'bdelete'],
	['bfirst', 'bf'], ['brewind', 'br', 'bfirst'], ['blast', 'bl'], ['buffers', 'buffers'], ['files', 'files', 'buffers'], ['ls', 'ls', 'buffers'],
	['buffer', 'b'], ['saveas', 'sav'], ['close', 'clo'], ['only', 'on'],
	['cnext', 'cn'], ['cprevious', 'cp'], ['cNext', 'cN', 'cprevious'], ['copen', 'cope'], ['cclose', 'ccl'],
	['terminal', 'ter'], ['grep', 'gr'], ['vimgrep', 'vim', 'grep'],
	['nohlsearch', 'noh'], ['substitute', 's'], ['global', 'g'], ['vglobal', 'v'], ['delete', 'd'], ['yank', 'y'],
	['move', 'm'], ['copy', 'co'], ['t', 't', 'copy'], ['join', 'j'], ['put', 'pu'], ['normal', 'norm'], ['sort', 'sor'],
	['undo', 'u'], ['redo', 'red'], ['mark', 'ma'], ['k', 'k', 'mark'], ['set', 'se'], ['registers', 'reg'], ['display', 'di', 'registers'],
	['marks', 'marks'], ['retab', 'ret'], ['left', 'le'], ['right', 'ri'], ['center', 'ce'],
	['&', '&'], ['&&', '&&'], ['~', '~'], ['<', '<'], ['>', '>'], ['@', '@'], ['=', '='],
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

/** Commands the engine implements itself, on the buffer. */
export const ENGINE_EX_COMMANDS: ReadonlySet<string> = new Set([
	'nohlsearch', 'substitute', 'global', 'vglobal', 'delete', 'yank', 'move', 'copy', 'join', 'put', 'normal', 'sort',
	'undo', 'redo', 'mark', 'set', 'registers', 'marks', 'retab', 'left', 'right', 'center', '&', '&&', '~', '<', '>', '@', '=',
]);

const SAVE = 'workbench.action.files.save';
const CLOSE = 'workbench.action.closeActiveEditor';
const REVERT_CLOSE = 'workbench.action.revertAndCloseActiveEditor';
const QUICK_OPEN = (prefix: string): ExStep => ({ command: 'workbench.action.quickOpen', args: prefix });

/** Built-in ex commands that run VS Code commands, by canonical name. */
export const BUILTIN_EX_COMMANDS: Readonly<Record<string, ExCommandEntry>> = {
	write: SAVE,
	wall: 'workbench.action.files.saveAll',
	update: SAVE,
	quit: { run: CLOSE, bang: REVERT_CLOSE },
	qall: { run: 'workbench.action.closeAllEditors', bang: ['workbench.action.files.revert', 'workbench.action.closeAllEditors'] },
	wq: [SAVE, CLOSE],
	xit: [SAVE, CLOSE],
	xall: ['workbench.action.files.saveAll', 'workbench.action.closeAllEditors'],
	// 'nosplitbelow' / 'nosplitright' (the defaults): the new window is above / left, and gets the focus
	split: 'workbench.action.splitEditorUp',
	vsplit: 'workbench.action.splitEditorLeft',
	new: ['workbench.action.splitEditorUp', 'workbench.action.files.newUntitledFile'],
	vnew: ['workbench.action.splitEditorLeft', 'workbench.action.files.newUntitledFile'],
	edit: { run: QUICK_OPEN('${args}'), bang: 'workbench.action.files.revert' },
	enew: 'workbench.action.files.newUntitledFile',
	tabnew: 'workbench.action.files.newUntitledFile',
	tabedit: QUICK_OPEN('${args}'),
	tabnext: 'workbench.action.nextEditor',
	tabprevious: 'workbench.action.previousEditor',
	tabclose: { run: CLOSE, bang: REVERT_CLOSE },
	tabonly: 'workbench.action.closeOtherEditors',
	tabfirst: 'workbench.action.firstEditorInGroup',
	tablast: 'workbench.action.lastEditorInGroup',
	bnext: 'workbench.action.nextEditor',
	bprevious: 'workbench.action.previousEditor',
	bdelete: { run: CLOSE, bang: REVERT_CLOSE },
	bfirst: 'workbench.action.firstEditorInGroup',
	blast: 'workbench.action.lastEditorInGroup',
	buffers: 'workbench.action.showAllEditors',
	buffer: QUICK_OPEN('edt ${args}'),
	saveas: 'workbench.action.files.saveAs',
	close: 'workbench.action.closeGroup',
	only: 'workbench.action.closeEditorsInOtherGroups',
	cnext: 'editor.action.marker.nextInFiles',
	cprevious: 'editor.action.marker.prevInFiles',
	copen: 'workbench.actions.view.problems',
	cclose: 'workbench.action.closePanel',
	terminal: 'workbench.action.terminal.new',
	grep: { command: 'workbench.action.findInFiles', args: { query: '${args}', triggerSearch: true } },
};

const USER_NAME = /^[A-Z][A-Za-z0-9]*$/;

function isStep(v: unknown): v is ExStep {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as ExStep).command === 'string' && (v as ExStep).command.length > 0;
}

function isSteps(v: unknown): v is ExSteps {
	if (typeof v === 'string') {
		return v.length > 0;
	}
	if (Array.isArray(v)) {
		return v.length > 0 && v.every(s => (typeof s === 'string' && s.length > 0) || isStep(s));
	}
	return isStep(v);
}

function isRunEntry(v: unknown): v is { run: ExSteps; bang?: ExSteps; description?: string } {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && 'run' in v;
}

export function isExCommandEntry(v: unknown): v is ExCommandEntry {
	if (isRunEntry(v)) {
		return isSteps(v.run) && (v.bang === undefined || isSteps(v.bang));
	}
	return isSteps(v);
}

export interface UserExCommands {
	/** By the user's name (uppercase) or the canonical built-in name it overrides. */
	readonly table: ReadonlyMap<string, ExCommandEntry>;
	/** Names that were given but cannot be used, with the reason. */
	readonly errors: ReadonlyMap<string, string>;
}

/**
 * The user's `devhub.vim.exCommands`. A name must start with an uppercase
 * letter, or name a built-in command (which it then overrides; `w` and
 * `write` are the same name).
 */
export function validateUserExCommands(raw: unknown): UserExCommands {
	const table = new Map<string, ExCommandEntry>();
	const errors = new Map<string, string>();
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { table, errors };
	}
	for (const [name, entry] of Object.entries(raw)) {
		const key = USER_NAME.test(name) ? name : canonicalExName(name);
		if (key === undefined) {
			errors.set(name, `User-defined ex commands must start with an uppercase letter: ${name}`);
		} else if (!isExCommandEntry(entry)) {
			errors.set(name, `Invalid definition for ex command ${name}: expected a command id, { command, args }, a list of them, or { run, bang }`);
		} else {
			table.set(key, entry);
		}
	}
	return { table, errors };
}

// ---- parsing ------------------------------------------------------------------

/** `:[range]name[!] args`, before the range is resolved against the buffer. */
export interface ParsedExLine {
	/** Raw addresses, e.g. ["'<", "'>"], ["1", "$"] for `%`, ["5", "5"] for `5`, ["/foo/", "."]. */
	readonly range: readonly [string, string] | undefined;
	/** The addresses were separated by `;` (the second is relative to the first). */
	readonly semicolon?: true;
	readonly name: string;
	readonly bang: boolean;
	readonly args: string;
}

/** One address at the start of `s`: its text (possibly empty) and the rest. */
function scanAddress(s: string): [string, string] {
	let i = 0;
	const c = s[0];
	if (c !== undefined && /[0-9]/.test(c)) {
		while (i < s.length && /[0-9]/.test(s[i])) {
			i++;
		}
	} else if (c === '.' || c === '$') {
		i = 1;
	} else if (c === '\'' && s.length > 1) {
		i = 2;
	} else if (c === '/' || c === '?') {
		i = 1;
		while (i < s.length && s[i] !== c) {
			if (s[i] === '\\') {
				i++;
			}
			i++;
		}
		if (i < s.length) {
			i++;
		}
	} else if (c === '\\' && (s[1] === '/' || s[1] === '?' || s[1] === '&')) {
		i = 2;
	}
	while (i < s.length && (s[i] === '+' || s[i] === '-')) {
		i++;
		while (i < s.length && /[0-9]/.test(s[i])) {
			i++;
		}
	}
	return [s.slice(0, i), s.slice(i)];
}

export function parseExLine(line: string): ParsedExLine {
	let s = line.replace(/^[\s:]+/, '');
	let range: [string, string] | undefined;
	let semicolon = false;
	if (s.startsWith('%')) {
		range = ['1', '$'];
		s = s.slice(1);
	} else if (s.startsWith('*')) {
		range = ['\'<', '\'>'];
		s = s.slice(1);
	} else {
		const addrs: string[] = [];
		let [first, rest] = scanAddress(s);
		addrs.push(first);
		s = rest;
		while (s.startsWith(',') || s.startsWith(';')) {
			semicolon = s[0] === ';';
			[first, rest] = scanAddress(s.slice(1));
			addrs.push(first || '.');
			s = rest;
		}
		if (addrs.length > 1) {
			range = [addrs[addrs.length - 2] || '.', addrs[addrs.length - 1]];
		} else if (addrs[0]) {
			range = [addrs[0], addrs[0]];
		}
	}
	s = s.replace(/^\s+/, '');
	let name = '';
	const special = /^(&&|[&~<>@=])/.exec(s);
	if (special) {
		name = special[1];
	} else {
		const m = /^[A-Za-z][A-Za-z0-9]*/.exec(s);
		name = m ? m[0] : '';
	}
	s = s.slice(name.length);
	const bang = s.startsWith('!') && name !== '';
	if (bang) {
		s = s.slice(1);
	}
	return { range, ...(semicolon && range ? { semicolon: true } : {}), name, bang, args: s.trim() };
}

export interface ExAddressContext {
	/** 0-based. */
	readonly cursorLine: number;
	readonly lastLine: number;
	/** The last visual selection's lines (0-based), for `'<` and `'>`. */
	readonly visual: { readonly start: number; readonly end: number } | undefined;
	/** The line of mark `name` (0-based), if set. */
	readonly mark?: (name: string) => number | undefined;
	/** The next (or previous) line matching a Vim pattern, from `line` exclusive, wrapping; empty pattern = the last search. */
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
	const [all] = scanAddress(address);
	if (all !== address) {
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

export interface ExInvocation {
	readonly args: string;
	readonly bang: boolean;
	/** 1-based lines, or undefined when no range was typed. */
	readonly range: { readonly start: number; readonly end: number } | undefined;
	/** 1-based cursor line, for line1/line2 without a range. */
	readonly cursorLine: number;
}

function placeholderValue(name: string, inv: ExInvocation): unknown {
	switch (name) {
		case 'args': return inv.args;
		case 'argList': return inv.args ? inv.args.split(/\s+/) : [];
		case 'bang': return inv.bang;
		case 'range': return inv.range ? { start: inv.range.start, end: inv.range.end } : null;
		case 'line1': return inv.range ? inv.range.start : inv.cursorLine;
		case 'line2': return inv.range ? inv.range.end : inv.cursorLine;
	}
	return undefined;
}

function placeholderText(name: string, inv: ExInvocation): string | undefined {
	switch (name) {
		case 'bang': return inv.bang ? '!' : '';
		case 'range': return inv.range ? `${inv.range.start},${inv.range.end}` : '';
		case 'argList': return inv.args;
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

/** The steps an entry runs for this invocation, args filled in. */
export function expandExEntry(entry: ExCommandEntry, inv: ExInvocation): ExStep[] {
	const steps: ExSteps = isRunEntry(entry) ? (inv.bang && entry.bang !== undefined ? entry.bang : entry.run) : entry as ExSteps;
	const list: readonly (string | ExStep)[] = typeof steps === 'string' || !Array.isArray(steps) ? [steps as string | ExStep] : steps;
	return list.map(s => typeof s === 'string'
		? { command: s }
		: s.args === undefined ? { command: s.command } : { command: s.command, args: substituteExArgs(s.args, inv) });
}

/** Names starting with `prefix`, sorted, for Tab in the `:` prompt. */
export function completeExName(prefix: string, names: Iterable<string>): string[] {
	const out = new Set<string>();
	for (const n of names) {
		if (n.startsWith(prefix)) {
			out.add(n);
		}
	}
	return [...out].sort();
}

/** Vim's built-in names with letters, for the prompt's completion: the full name, the shortest abbreviation, the name it is an alias of. */
export function builtinExNameInfo(): { readonly name: string; readonly abbrev: string; readonly alias?: string }[] {
	return EX_NAMES.filter(([full]) => /^[A-Za-z]/.test(full)).map(([name, abbrev, alias]) => alias ? { name, abbrev, alias } : { name, abbrev });
}

/**
 * The `[range]` at the start of an ex line, as parseExLine reads it (with the
 * leading blanks and colons): its length, so the prompt's completion knows
 * where the command name starts.
 */
export function exRangeLength(line: string): number {
	let s = line.replace(/^[\s:]+/, '');
	if (s.startsWith('%') || s.startsWith('*')) {
		s = s.slice(1);
	} else {
		s = scanAddress(s)[1];
		while (s.startsWith(',') || s.startsWith(';')) {
			s = scanAddress(s.slice(1))[1];
		}
	}
	s = s.replace(/^\s+/, '');
	return line.length - s.length;
}

/** Every name Tab completes: the built-in full names (no aliases' targets twice) and the user's. */
export function builtinExNames(): string[] {
	return EX_NAMES.map(([full]) => full).filter(n => /^[A-Za-z]/.test(n));
}

// ---- :substitute ----------------------------------------------------------------

export interface ParsedSubstitute {
	/** Undefined: `:s [flags]` repeats the last pattern and replacement. */
	readonly pattern?: string;
	readonly replacement?: string;
	readonly flags: string;
	readonly count?: number;
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
		return { pattern: args.slice(start), replacement: '', flags: '' };
	}
	const repStart = i;
	let replacement = part();
	let rest = '';
	if (replacement === undefined) {
		replacement = args.slice(repStart).replace(new RegExp('\\\\' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), d);
	} else {
		rest = args.slice(i);
	}
	if (pattern === undefined) {
		pattern = '';
	}
	const m = /^\s*(&?[cegiInp#lr]*)\s*(\d*)/.exec(rest);
	return { pattern, replacement, flags: m ? m[1] : '', count: m && m[2] ? Number(m[2]) : undefined };
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
