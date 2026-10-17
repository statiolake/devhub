/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: Vim regular expressions (`:help pattern`) translated to
// JavaScript ones, and `:s` replacement strings (`:help sub-replace-special`).
// Imports nothing.
//
// Supported: the four magic levels (\v \m \M \V, default 'magic'), \( \) \%(
// \| \+ \= \? \{n,m} \{-n,m} \< \> \zs \ze, the character classes \s \S \d \D
// \w \W \a \A \l \L \u \U \x \X \o \O \h \H \k \K \i \I \f \F \p \P and their
// \_x forms, [] collections with [:alpha:]-style classes, ~ (the last
// substitute string), \c \C, \1..\9, \n \t \e \r. Patterns are matched one
// line at a time (a pattern that needs \n never matches); \%V, \%23l and the
// other \% items other than \%( \%d \%x \%u are not supported (an error says so).

export interface VimRegex {
	/** JavaScript source, compiled with the `u` flag (plus `i` when `ignoreCase`). */
	readonly source: string;
	readonly ignoreCase: boolean;
}

export interface VimRegexOptions {
	readonly ignorecase: boolean;
	readonly smartcase: boolean;
	/** The previous substitute string, for `~`. */
	readonly lastReplacement?: string;
}

const KEYWORD = '[\\p{L}\\p{N}_]';
const NOT_KEYWORD = '[^\\p{L}\\p{N}_]';

const CLASSES: Record<string, string> = {
	s: '[ \\t]', S: '[^ \\t]', d: '[0-9]', D: '[^0-9]', w: '[0-9A-Za-z_]', W: '[^0-9A-Za-z_]',
	a: '[A-Za-z]', A: '[^A-Za-z]', l: '[a-z]', L: '[^a-z]', u: '[A-Z]', U: '[^A-Z]',
	x: '[0-9A-Fa-f]', X: '[^0-9A-Fa-f]', o: '[0-7]', O: '[^0-7]', h: '[A-Za-z_]', H: '[^A-Za-z_]',
	k: KEYWORD, K: NOT_KEYWORD, i: KEYWORD, I: NOT_KEYWORD,
	f: '[\\p{L}\\p{N}_./\\\\~+,#$%-]', F: '[^\\p{L}\\p{N}_./\\\\~+,#$%-]', p: '[^\\p{Cc}]', P: '[^\\p{Cc}]',
};

const POSIX: Record<string, string> = {
	alpha: 'A-Za-z', digit: '0-9', alnum: '0-9A-Za-z', lower: 'a-z', upper: 'A-Z', space: ' \\t\\n\\r\\f\\v',
	blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: ' -~', graph: '!-~',
	return: '\\r', tab: '\\t', escape: '\\x1b', backspace: '\\x08', ident: '0-9A-Za-z_', keyword: '\\p{L}\\p{N}_', fname: '\\p{L}\\p{N}_./\\\\-',
};

const JS_SYNTAX = /[\\^$.*+?()[\]{}|/]/;

function lit(ch: string): string {
	return JS_SYNTAX.test(ch) ? '\\' + ch : ch;
}

function litString(s: string): string {
	return Array.from(s).map(lit).join('');
}

/** Characters with a meaning without a backslash, per magic level (the rest need one). */
const UNESCAPED_SPECIAL: Record<string, string> = {
	v: '^$.*[~()|+=?{@<>%&',
	m: '^$.*[~',
	M: '^$',
	V: '',
};

export class VimRegexError extends Error { }

/** Vim pattern -> JavaScript regex source; throws VimRegexError. */
export function vimRegex(pattern: string, opts: VimRegexOptions): VimRegex {
	let magic: 'v' | 'm' | 'M' | 'V' = 'm';
	let ignoreCase: boolean | undefined;
	let out = '';
	let zs = -1;
	let ze = -1;
	let depth = 0;
	const chars = Array.from(pattern);
	/** Whether the output so far ends where `^` is a line start (pattern start, after `(`, `|`). */
	const atBranchStart = () => out === '' || /(?:\(\?:|\(|\|)$/.test(out) && !/\\[(|]$/.test(out);
	let i = 0;
	const peekSpecial = (at: number): { ch: string; special: boolean; len: number } | undefined => {
		if (at >= chars.length) {
			return undefined;
		}
		if (chars[at] === '\\' && at + 1 < chars.length) {
			const c = chars[at + 1];
			// a backslash makes the unescaped-special ones literal, and the others special
			return { ch: c, special: !UNESCAPED_SPECIAL[magic].includes(c), len: 2 };
		}
		return { ch: chars[at], special: UNESCAPED_SPECIAL[magic].includes(chars[at]), len: 1 };
	};
	while (i < chars.length) {
		const t = peekSpecial(i)!;
		i += t.len;
		const { ch, special } = t;
		if (!special) {
			out += t.len === 2 && /[A-Za-z0-9]/.test(ch) ? escapeLetter(ch) : lit(ch);
			continue;
		}
		switch (ch) {
			case 'v': case 'm': case 'M': case 'V':
				magic = ch;
				continue;
			case 'c':
				ignoreCase = true;
				continue;
			case 'C':
				ignoreCase = false;
				continue;
			case '^':
				out += atBranchStart() ? '^' : '\\^';
				continue;
			case '$': {
				const next = peekSpecial(i);
				const end = !next || (next.special && (next.ch === '|' || next.ch === ')')) || (next.len === 2 && next.ch === 'n');
				out += end ? '$' : '\\$';
				continue;
			}
			case '.':
				out += '.';
				continue;
			case '*':
				out += atBranchStart() ? '\\*' : '*';
				continue;
			case '+':
				out += '+';
				continue;
			case '=': case '?':
				out += '?';
				continue;
			case '{': {
				let body = '';
				while (i < chars.length && chars[i] !== '}') {
					if (chars[i] === '\\' && chars[i + 1] === '}') {
						i++;
						break;
					}
					body += chars[i++];
				}
				if (chars[i] === '}') {
					i++;
				}
				const m = /^(-?)(\d*)(?:(,)(\d*))?$/.exec(body);
				if (!m) {
					throw new VimRegexError(`Syntax error in \\{${body}}`);
				}
				const lazy = m[1] === '-';
				let q: string;
				if (!m[3]) {
					q = m[2] === '' ? '*' : `{${m[2]}}`;
				} else {
					q = `{${m[2] || '0'},${m[4]}}`;
				}
				out += q + (lazy ? '?' : '');
				continue;
			}
			case '(':
				out += '(';
				depth++;
				continue;
			case ')':
				if (depth === 0) {
					throw new VimRegexError('Unmatched \\)');
				}
				depth--;
				out += ')';
				continue;
			case '|':
				out += '|';
				continue;
			case '&':
				// \& is "and" in Vim (branch concat); approximate with a lookahead of what follows
				throw new VimRegexError('\\& is not supported');
			case '<':
				out += `(?<!${KEYWORD})(?=${KEYWORD})`;
				continue;
			case '>':
				out += `(?<=${KEYWORD})(?!${KEYWORD})`;
				continue;
			case '~':
				out += litString(opts.lastReplacement ?? '');
				continue;
			case '[': {
				const r = collection(chars, i);
				if (!r) {
					out += '\\[';
					continue;
				}
				out += r.source;
				i = r.next;
				continue;
			}
			case '%': {
				const n = chars[i];
				if (n === '(') {
					i++;
					depth++;
					out += '(?:';
					continue;
				}
				if (n === 'd' || n === 'x' || n === 'u' || n === 'U' || n === 'o') {
					i++;
					const digits = n === 'd' ? /[0-9]/ : n === 'o' ? /[0-7]/ : /[0-9A-Fa-f]/;
					let num = '';
					while (i < chars.length && digits.test(chars[i])) {
						num += chars[i++];
					}
					const code = parseInt(num, n === 'd' ? 10 : n === 'o' ? 8 : 16);
					if (!num || !Number.isFinite(code)) {
						throw new VimRegexError(`Invalid character code: \\%${n}${num}`);
					}
					out += lit(String.fromCodePoint(code));
					continue;
				}
				throw new VimRegexError(`Not supported: \\%${n ?? ''}`);
			}
			case 'z': {
				const n = chars[i++];
				if (n === 's') {
					zs = out.length;
					continue;
				}
				if (n === 'e') {
					ze = out.length;
					continue;
				}
				throw new VimRegexError(`Not supported: \\z${n ?? ''}`);
			}
			case '_': {
				const n = chars[i++];
				if (n === '.') {
					out += '[\\s\\S]';
				} else if (n === '^' || n === '$') {
					out += n;
				} else if (n && CLASSES[n]) {
					out += CLASSES[n];
				} else {
					throw new VimRegexError(`Not supported: \\_${n ?? ''}`);
				}
				continue;
			}
			case '@':
				throw new VimRegexError('\\@ (look-around) is not supported');
			default:
				out += t.len === 2 ? escapeLetter(ch) : lit(ch);
		}
	}
	if (depth !== 0) {
		throw new VimRegexError('Unmatched \\(');
	}
	let source = out;
	if (zs >= 0 || ze >= 0) {
		const s = zs >= 0 ? zs : 0;
		const e = ze >= 0 ? ze : out.length;
		if (e < s) {
			throw new VimRegexError('\\ze before \\zs');
		}
		source = (s > 0 ? `(?<=${out.slice(0, s)})` : '') + out.slice(s, e) + (e < out.length ? `(?=${out.slice(e)})` : '');
	}
	if (ignoreCase === undefined) {
		ignoreCase = opts.ignorecase && !(opts.smartcase && hasUpper(pattern));
	}
	try {
		new RegExp(source, 'u' + (ignoreCase ? 'i' : ''));
	} catch (e) {
		throw new VimRegexError(`Invalid pattern: ${pattern}`);
	}
	return { source, ignoreCase };
}

/** 'smartcase': an upper-case letter that is not part of an item like \S. */
function hasUpper(pattern: string): boolean {
	const chars = Array.from(pattern);
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] === '\\') {
			i++;
			continue;
		}
		if (/\p{Lu}/u.test(chars[i])) {
			return true;
		}
	}
	return false;
}

function escapeLetter(ch: string): string {
	if (CLASSES[ch]) {
		return CLASSES[ch];
	}
	switch (ch) {
		case 'n': return '\\n';
		case 't': return '\\t';
		case 'e': return '\\x1b';
		case 'r': return '\\r';
		case 'b': return '\\x08';
	}
	if (/[1-9]/.test(ch)) {
		return '\\' + ch;
	}
	return lit(ch);
}

/** `[...]` starting after the `[`; undefined when it has no closing `]` (then `[` is literal). */
function collection(chars: string[], start: number): { source: string; next: number } | undefined {
	let i = start;
	let body = '';
	let negate = false;
	if (chars[i] === '^') {
		negate = true;
		i++;
	}
	if (chars[i] === ']') {
		body += '\\]';
		i++;
	}
	while (i < chars.length && chars[i] !== ']') {
		const c = chars[i];
		if (c === '[' && chars[i + 1] === ':') {
			const close = chars.indexOf(':', i + 2);
			if (close > 0 && chars[close + 1] === ']') {
				const name = chars.slice(i + 2, close).join('');
				if (POSIX[name] !== undefined) {
					body += POSIX[name];
					i = close + 2;
					continue;
				}
			}
			body += '\\[';
			i++;
			continue;
		}
		if (c === '\\' && i + 1 < chars.length) {
			const n = chars[i + 1];
			i += 2;
			switch (n) {
				case 'e': body += '\\x1b'; break;
				case 't': body += '\\t'; break;
				case 'r': body += '\\r'; break;
				case 'n': body += '\\n'; break;
				case '\\': body += '\\\\'; break;
				case ']': body += '\\]'; break;
				case '^': body += '\\^'; break;
				case '-': body += '\\-'; break;
				case 'd': {
					let num = '';
					while (/[0-9]/.test(chars[i] ?? '')) {
						num += chars[i++];
					}
					body += lit(String.fromCodePoint(Number(num)));
					break;
				}
				default: body += '\\\\' + (/[A-Za-z0-9]/.test(n) ? n : '\\' + n);
			}
			continue;
		}
		body += c === '[' || c === '/' ? '\\' + c : c;
		i++;
	}
	if (i >= chars.length) {
		return undefined;
	}
	return { source: `[${negate ? '^' : ''}${body}]`, next: i + 1 };
}

/** A JavaScript RegExp for a translated pattern (global, so `lastIndex` works). */
export function compileVimRegex(r: VimRegex): RegExp {
	return new RegExp(r.source, 'gu' + (r.ignoreCase ? 'i' : ''));
}

/**
 * All matches in one line, as [start, end) columns (UTF-16). An empty match
 * advances by one character, as Vim does.
 */
export function lineMatches(re: RegExp, text: string, limit = Number.MAX_SAFE_INTEGER): [number, number][] {
	const out: [number, number][] = [];
	re.lastIndex = 0;
	while (out.length < limit) {
		const m = re.exec(text);
		if (!m) {
			break;
		}
		out.push([m.index, m.index + m[0].length]);
		if (m[0].length === 0) {
			if (re.lastIndex >= text.length) {
				break;
			}
			re.lastIndex += text.codePointAt(re.lastIndex)! > 0xffff ? 2 : 1;
		}
	}
	return out;
}

// ---- :s replacement strings ------------------------------------------------

type CaseMode = '' | 'u' | 'l' | 'U' | 'L';

/**
 * Expand a `:s` replacement (`:help sub-replace-special`, 'magic'): & \0 \1..\9
 * ~ \u \l \U \L \e \E \r \n \t \\ \&. `\r` is a line break, `\n` a NUL, as
 * in Vim. Returns the text for one match.
 */
export function expandReplacement(rep: string, match: RegExpExecArray, lastReplacement: string): string {
	let out = '';
	let one: CaseMode = '';
	let all: CaseMode = '';
	const add = (s: string) => {
		for (const ch of s) {
			let c = ch;
			if (all === 'U') {
				c = c.toUpperCase();
			} else if (all === 'L') {
				c = c.toLowerCase();
			}
			if (one === 'u') {
				c = c.toUpperCase();
				one = '';
			} else if (one === 'l') {
				c = c.toLowerCase();
				one = '';
			}
			out += c;
		}
	};
	const chars = Array.from(rep);
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i];
		if (c === '&') {
			add(match[0]);
			continue;
		}
		if (c === '~') {
			add(lastReplacement);
			continue;
		}
		if (c !== '\\' || i + 1 >= chars.length) {
			add(c);
			continue;
		}
		const n = chars[++i];
		if (/[0-9]/.test(n)) {
			add(match[Number(n)] ?? '');
			continue;
		}
		switch (n) {
			case 'u': case 'l': one = n; break;
			case 'U': case 'L': all = n; break;
			case 'e': case 'E': all = ''; one = ''; break;
			case 'r': out += '\n'; break;
			case 'n': out += '\0'; break;
			case 't': out += '\t'; break;
			default: add(n);
		}
	}
	return out;
}

/** The text of a replacement string with `~` expanded (what the next `~` stands for). */
export function expandTilde(rep: string, lastReplacement: string): string {
	let out = '';
	const chars = Array.from(rep);
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] === '\\' && i + 1 < chars.length) {
			out += chars[i] + chars[++i];
		} else if (chars[i] === '~') {
			out += lastReplacement;
		} else {
			out += chars[i];
		}
	}
	return out;
}

/** Literal text as a very-nomagic Vim pattern (`\V` + escaped backslashes and `/`). */
export function literalVimPattern(text: string, delimiter = '/'): string {
	return '\\V' + text.replace(/\\/g, '\\\\').split(delimiter).join('\\' + delimiter).replace(/\n/g, '\\n');
}
