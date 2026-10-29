/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the buffer list, as data - VS Code's editors (the tabs)
// are Vim's buffers. What `:ls` prints, which buffer `:b {N|name}` `:bn`
// `:bp` `:bf` `:bl` `:b#` CTRL-^ go to, and the errors they give, as Vim
// computes them. Imports nothing (the tests run it as they run the engine);
// ../browser/vimBuffers.ts keeps the list on the workbench.

/** One buffer as the list has it: an editor, live or not. */
export interface VimBufferEntry {
	/** Vim's buffer number: given when the editor is first seen, never reused, kept while the workspace keeps the list. */
	readonly nr: number;
	/** The name `:ls` shows and `:b {name}` matches: the path relative to the workspace folder (`~` for the home directory), or the editor's name. */
	readonly name: string;
	/** The full name `:b {name}` matches too (the absolute path); the name when there is none. */
	readonly fullName: string;
	/** In the buffer list (`u` in `:ls!` when not): open in some editor group or tab page; closed by the user (`:bd`, its tab's close) it is unlisted. */
	readonly listed: boolean;
	/** An editor of the live layout (Vim: loaded). Not when it is only in another tab page's layout or unlisted. */
	readonly loaded: boolean;
	/** Shown in a window: some editor group's active editor, in this tab page or another one (`a`); loaded and not shown is hidden (`h`). */
	readonly shown: boolean;
	readonly modified: boolean;
	/** Not modifiable (`-`): a read-only editor. */
	readonly readonly: boolean;
	/** The cursor line (1-based) last known, 0 when never known. */
	readonly line: number;
}

/** What `:ls` marks besides the entries' own flags. */
export interface VimBufferMarks {
	/** The current window's buffer (`%`). */
	readonly current: number | undefined;
	/** The current window's alternate buffer (`#`). */
	readonly alternate: number | undefined;
}

/** A Vim error of the buffer commands (E86, E93, E94, E23, E85, E89, E516). */
export class VimBufferError extends Error { }

/** The five flag columns of one `:ls` line (`:help :ls`): u, %/#, a/h, -/=, +. */
export function bufferFlags(b: VimBufferEntry, marks: VimBufferMarks): string {
	return (b.listed ? ' ' : 'u')
		+ (b.nr === marks.current ? '%' : b.nr === marks.alternate ? '#' : ' ')
		+ (b.shown ? 'a' : b.loaded ? 'h' : ' ')
		+ (b.readonly ? '-' : ' ')
		+ (b.modified ? '+' : ' ');
}

/**
 * One `:ls` line as Vim prints it (buflist_list):
 * `%3d%c%c%c%c%c "%s"`, padded to column 18 past the name, then `line N`.
 */
export function formatBufferLine(b: VimBufferEntry, marks: VimBufferMarks): string {
	const head = `${String(b.nr).padStart(3)}${bufferFlags(b, marks)} "${b.name}"`;
	const pad = Math.max(1, 40 - head.length);
	return `${head}${' '.repeat(pad)}line ${b.nr === marks.current || b.loaded ? Math.max(b.line, 1) : b.line}`;
}

/**
 * `:ls[!] [flags]`: the buffers in number order, the unlisted ones only with
 * `!`; `flags` keep the buffers that have every one of them (`+` modified,
 * `-` not modifiable, `a` shown, `h` hidden, `u` unlisted, `%` current, `#`
 * alternate), as Vim's `:ls +`, `:ls h`.
 */
export function listBuffers(entries: readonly VimBufferEntry[], marks: VimBufferMarks, bang: boolean, filter = ''): VimBufferEntry[] {
	const want = filter.replace(/\s+/g, '');
	return [...entries]
		.filter(b => (bang || b.listed) && [...want].every(f => {
			switch (f) {
				case '+': return b.modified;
				case '-': return b.readonly;
				case '=': return b.readonly;
				case 'a': return b.shown;
				case 'h': return b.loaded && !b.shown;
				case 'u': return !b.listed;
				case '%': return b.nr === marks.current;
				case '#': return b.nr === marks.alternate;
				default: return true;
			}
		}))
		.sort((a, b) => a.nr - b.nr);
}

/** Vim's file pattern as a regexp body (`*` any text, `?` one character, `\` quotes), as file_pat_to_reg_pat makes it. */
function filePatternBody(pattern: string): string {
	let out = '';
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === '*') {
			out += '.*';
		} else if (c === '?') {
			out += '.';
		} else if (c === '\\' && i + 1 < pattern.length) {
			out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		} else {
			out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}
	}
	return out;
}

/**
 * The buffer `:b {arg}` (`:sb`, `:bd {arg}`) means, as Vim's buflist_findpat:
 * a number is that buffer (E86 when there is none), `%` the current one, `#`
 * the alternate one (E23), anything else a file pattern matched against each
 * buffer's name and full name, in four tries — anywhere, at the start, at the
 * end, the whole name — until exactly one listed buffer matches; only when no
 * listed buffer matches at all are the unlisted ones tried the same way. More
 * than one match in the last try is E93, none is E94.
 */
export function findBuffer(arg: string, entries: readonly VimBufferEntry[], marks: VimBufferMarks, ignoreCase: boolean): VimBufferEntry {
	const a = arg.trim();
	if (/^\d+$/.test(a)) {
		const found = entries.find(b => b.nr === Number(a));
		if (!found) {
			throw new VimBufferError(`E86: Buffer ${Number(a)} does not exist`);
		}
		return found;
	}
	if (a === '%' || a === '#') {
		const nr = a === '%' ? marks.current : marks.alternate;
		const found = entries.find(b => b.nr === nr);
		if (!found) {
			throw new VimBufferError(a === '#' ? 'E23: No alternate file' : 'E94: No matching buffer for %');
		}
		return found;
	}
	const explicitStart = a.startsWith('^');
	const explicitEnd = a.endsWith('$') && !a.endsWith('\\$');
	const body = filePatternBody(a.slice(explicitStart ? 1 : 0, explicitEnd ? -1 : undefined));
	let ambiguous = false;
	for (const listed of [true, false]) {
		for (let attempt = 0; attempt <= 3; attempt++) {
			const start = explicitStart || (attempt & 1) === 1;
			const end = explicitEnd || attempt >= 2;
			let re: RegExp;
			try {
				re = new RegExp(`${start ? '^' : ''}${body}${end ? '$' : ''}`, ignoreCase ? 'i' : '');
			} catch {
				throw new VimBufferError(`E94: No matching buffer for ${a}`);
			}
			const matches = entries.filter(b => b.listed === listed && (re.test(b.name) || re.test(b.fullName)));
			if (matches.length === 1) {
				return matches[0];
			}
			// once more than one matched, it stays ambiguous unless a later try finds just one (buflist_findpat's -2)
			ambiguous = ambiguous || matches.length > 1;
		}
		if (ambiguous) {
			break;
		}
	}
	throw new VimBufferError(ambiguous ? `E93: More than one match for ${a}` : `E94: No matching buffer for ${a}`);
}

/**
 * `:bn [N]` / `:bp [N]` (`:{N}bn`, `]b` `[b`): N listed buffers on from the
 * current one in number order, round from the last to the first (from no
 * current buffer, from before the first). E85 with no listed buffer.
 */
export function stepBuffer(entries: readonly VimBufferEntry[], current: number | undefined, by: number): VimBufferEntry {
	const listed = entries.filter(b => b.listed).sort((a, b) => a.nr - b.nr);
	if (!listed.length) {
		throw new VimBufferError('E85: There is no listed buffer');
	}
	let i = listed.findIndex(b => b.nr === current);
	if (i < 0) {
		// from a buffer that is not listed (or none): the first one after it, as if it were in the list
		const after = listed.findIndex(b => current !== undefined && b.nr > current);
		i = by > 0 ? (after < 0 ? listed.length : after) - 1 : (after < 0 ? listed.length : after);
	}
	const n = listed.length;
	return listed[(((i + by) % n) + n) % n];
}

/** `:bf` / `:bl`: the first / last listed buffer (E85 with none). */
export function edgeBuffer(entries: readonly VimBufferEntry[], last: boolean): VimBufferEntry {
	const listed = entries.filter(b => b.listed).sort((a, b) => a.nr - b.nr);
	if (!listed.length) {
		throw new VimBufferError('E85: There is no listed buffer');
	}
	return last ? listed[listed.length - 1] : listed[0];
}

/** A count or argument as a number, or undefined. */
export function bufferCount(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) && Number(v) > 0 ? Number(v) : undefined;
}

/**
 * What quitting must not abandon (Neovim's check_changed_any): the first
 * modified buffer, in Vim's order — the current one, those shown in the
 * current tab page's other windows, then every other one by number — or
 * undefined. With `hiddenOnly` (`:q!`, whose current buffer is abandoned)
 * only the buffers no window shows.
 */
export function quitBlocker<T extends { readonly modified: boolean; readonly shown: boolean; readonly current: boolean; readonly nr: number }>(buffers: readonly T[], hiddenOnly: boolean): T | undefined {
	const order = (b: T) => b.current ? 0 : b.shown ? 1 : 2;
	return [...buffers]
		.filter(b => b.modified && (!hiddenOnly || !b.shown))
		.sort((a, b) => order(a) - order(b) || a.nr - b.nr)[0];
}

/** Neovim's message for a quit a modified buffer stops: E37, then E162 naming it. */
export function quitRefusal(name: string): string {
	return `E37: No write since last change  E162: No write since last change for buffer "${name}"`;
}

/** `:bd {N}` on a modified buffer without `!`. */
export function deleteRefusal(nr: number): string {
	return `E89: No write since last change for buffer ${nr} (add ! to override)`;
}

/** The list as workspace storage keeps it. */
export interface StoredBuffer {
	readonly nr: number;
	readonly key: string;
	readonly name: string;
	readonly listed: boolean;
	readonly line: number;
	/** How to open it again when it is not live: the editor's resources (URI strings) and editor id. */
	readonly open?: StoredBufferOpen;
}

export interface StoredBufferOpen {
	readonly resource?: string;
	readonly primary?: string;
	readonly secondary?: string;
	readonly diff?: boolean;
	readonly override?: string;
}

export interface StoredBufferList {
	readonly next: number;
	readonly buffers: readonly StoredBuffer[];
}

/** The most buffers the stored list keeps (the newest numbers). */
export const MAX_STORED_BUFFERS = 500;

export function parseStoredBuffers(raw: string | undefined): StoredBufferList {
	try {
		const p = raw ? JSON.parse(raw) as Partial<StoredBufferList> : undefined;
		if (!p || typeof p.next !== 'number' || !Array.isArray(p.buffers)) {
			return { next: 1, buffers: [] };
		}
		const buffers = p.buffers.filter((b): b is StoredBuffer => !!b && typeof b === 'object' && typeof b.nr === 'number' && b.nr > 0 && typeof b.key === 'string' && typeof b.name === 'string')
			.map(b => ({ nr: b.nr, key: b.key, name: b.name, listed: b.listed !== false, line: typeof b.line === 'number' ? b.line : 0, open: typeof b.open === 'object' && b.open ? b.open : undefined }));
		const next = Math.max(p.next, ...buffers.map(b => b.nr + 1), 1);
		return { next, buffers };
	} catch {
		return { next: 1, buffers: [] };
	}
}

export function serializeStoredBuffers(list: StoredBufferList): string {
	const buffers = [...list.buffers].sort((a, b) => a.nr - b.nr).slice(-MAX_STORED_BUFFERS);
	return JSON.stringify({ next: list.next, buffers });
}
