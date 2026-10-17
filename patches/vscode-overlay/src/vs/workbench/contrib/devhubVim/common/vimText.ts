/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: text helpers with no editor state - character classes,
// screen columns, CTRL-A / CTRL-X on numbers, g? (rot13), gw/gq text
// formatting. Imports nothing.

export function isWordChar(ch: string): boolean {
	return /[\p{L}\p{N}_]/u.test(ch);
}

/** 0 blank (incl. line break), 1 punctuation, 2 keyword; `big` folds 1 into 2. */
export function charClass(ch: string, big: boolean): number {
	if (ch === '' || ch === '\n' || ch === ' ' || ch === '\t') {
		return 0;
	}
	if (big) {
		return 2;
	}
	return isWordChar(ch) ? 2 : 1;
}

export function isBlank(ch: string): boolean {
	return ch === ' ' || ch === '\t';
}

/** The screen column where character `col` of `text` starts (tabs expand to `tabSize`). */
export function vcolOf(text: string, col: number, tabSize: number): number {
	let v = 0;
	for (let i = 0; i < col && i < text.length; i++) {
		v = text[i] === '\t' ? v + tabSize - (v % tabSize) : v + 1;
	}
	return v + Math.max(0, col - text.length);
}

/** Width on screen of the character at `col` (1 past the end). */
export function charWidth(text: string, col: number, tabSize: number): number {
	if (col >= text.length) {
		return 1;
	}
	if (text[col] === '\t') {
		const v = vcolOf(text, col, tabSize);
		return tabSize - (v % tabSize);
	}
	return 1;
}

/** The character covering screen column `vcol`, or `text.length` + the columns past the end. */
export function colOfVcol(text: string, vcol: number, tabSize: number): { col: number; past: number } {
	let v = 0;
	for (let i = 0; i < text.length; i++) {
		const w = text[i] === '\t' ? tabSize - (v % tabSize) : 1;
		if (vcol < v + w) {
			return { col: i, past: 0 };
		}
		v += w;
	}
	return { col: text.length, past: vcol - v };
}

export function toggleCase(s: string): string {
	let out = '';
	for (const ch of s) {
		const up = ch.toUpperCase();
		out += ch === up ? ch.toLowerCase() : up;
	}
	return out;
}

export function rot13(s: string): string {
	return s.replace(/[A-Za-z]/g, c => {
		const base = c <= 'Z' ? 65 : 97;
		return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
	});
}

// ---- CTRL-A / CTRL-X ---------------------------------------------------------

export interface NumberEdit {
	/** Replaced columns [start, end). */
	readonly start: number;
	readonly end: number;
	readonly text: string;
	/** Where the cursor goes: the last character of the new number. */
	readonly cursor: number;
}

/**
 * Vim's CTRL-A on `text` from `col`: the number under or after the cursor
 * ('nrformats' "bin,hex", Neovim's default: 0x / 0b prefixes, decimal with a
 * leading `-`), plus `delta`. `fromStart` (visual mode) looks from `col` but
 * never backwards past it. Leading zeros keep the width; hex keeps its case.
 */
export function addToNumber(text: string, col: number, delta: number, nrformats: readonly string[], fromStart = false): NumberEdit | undefined {
	const hex = nrformats.includes('hex');
	const bin = nrformats.includes('bin');
	const alpha = nrformats.includes('alpha');
	// A hex or binary literal containing (or right after) the cursor.
	const lit = (prefixes: string, digits: RegExp, enabled: boolean): { start: number; end: number } | undefined => {
		if (!enabled) {
			return undefined;
		}
		const re = new RegExp(`0[${prefixes}]${digits.source}+`, 'g');
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			const s = m.index;
			const e = s + m[0].length;
			if (e > col && (fromStart ? s >= col : true)) {
				if (s <= col || !/[0-9]/.test(text.slice(col, s))) {
					return { start: s, end: e };
				}
				return undefined;
			}
		}
		return undefined;
	};
	// the first digit at or after the cursor (going back to the start of the number under it)
	let d = col;
	if (!fromStart) {
		while (d > 0 && /[0-9]/.test(text[d - 1] ?? '') && /[0-9]/.test(text[d] ?? '')) {
			d--;
		}
	}
	while (d < text.length && !/[0-9]/.test(text[d])) {
		d++;
	}
	const hexLit = lit('xX', /[0-9A-Fa-f]/, hex);
	const binLit = lit('bB', /[01]/, bin);
	const radixLit = [hexLit && { ...hexLit, radix: 16 }, binLit && { ...binLit, radix: 2 }]
		.filter((x): x is { start: number; end: number; radix: number } => !!x)
		.sort((a, b) => a.start - b.start)[0];
	if (alpha) {
		let a = col;
		while (a < text.length && !/[A-Za-z0-9]/.test(text[a])) {
			a++;
		}
		if (a < text.length && /[A-Za-z]/.test(text[a]) && (d >= text.length || a < d) && (!radixLit || a < radixLit.start)) {
			const c = text.charCodeAt(a);
			const base = c >= 97 ? 97 : 65;
			const n = Math.max(0, Math.min(25, c - base + delta));
			return { start: a, end: a + 1, text: String.fromCharCode(base + n), cursor: a };
		}
	}
	if (radixLit && (d >= text.length || radixLit.start <= d)) {
		const { start, end, radix } = radixLit;
		const digits = text.slice(start + 2, end);
		let value = BigInt((radix === 16 ? '0x' : '0b') + digits);
		const width = BigInt(radix === 16 ? 4 * digits.length : digits.length);
		const mod = 1n << (width > 64n ? width : 64n);
		value = ((value + BigInt(delta)) % mod + mod) % mod;
		let s = value.toString(radix);
		if (radix === 16 && /[A-F]/.test(digits) && !/[a-f]/.test(digits)) {
			s = s.toUpperCase();
		}
		if (s.length < digits.length) {
			s = '0'.repeat(digits.length - s.length) + s;
		}
		const out = text.slice(start, start + 2) + s;
		return { start, end, text: out, cursor: start + out.length - 1 };
	}
	if (d >= text.length) {
		return undefined;
	}
	let e = d;
	while (e < text.length && /[0-9]/.test(text[e])) {
		e++;
	}
	let start = d;
	let negative = false;
	if (d > 0 && text[d - 1] === '-' && (!fromStart || d - 1 >= col)) {
		negative = true;
		start = d - 1;
	}
	const digits = text.slice(d, e);
	let value = BigInt(digits) * (negative ? -1n : 1n) + BigInt(delta);
	const neg = value < 0n;
	if (neg) {
		value = -value;
	}
	let s = value.toString();
	if (digits.length > 1 && digits[0] === '0' && s.length < digits.length) {
		s = '0'.repeat(digits.length - s.length) + s;
	}
	const out = (neg ? '-' : '') + s;
	return { start, end: e, text: out, cursor: start + out.length - 1 };
}

// ---- gq / gw --------------------------------------------------------------

/**
 * Vim's internal formatter (gw, and gq without a formatter): each paragraph
 * (lines separated by blank lines) is joined and re-broken at `width`,
 * keeping the first line's indent and a common comment leader (`leader`,
 * e.g. "//"), as with 'formatoptions' "tcq".
 */
export function formatLines(lines: readonly string[], width: number, leader: string | undefined, tabSize: number): string[] {
	const out: string[] = [];
	let para: string[] = [];
	const flush = () => {
		if (!para.length) {
			return;
		}
		const first = para[0];
		let prefix = /^\s*/.exec(first)![0];
		let strip = (l: string) => l.trim();
		if (leader) {
			const esc = leader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const re = new RegExp(`^(\\s*${esc}\\s?)`);
			if (para.every(l => re.test(l))) {
				const m = re.exec(first)!;
				prefix = m[1].endsWith(' ') ? m[1] : m[1] + ' ';
				strip = l => l.replace(new RegExp(`^\\s*${esc}`), '').trim();
			}
		}
		const words = para.map(strip).join(' ').split(/\s+/).filter(w => w.length);
		const prefixWidth = vcolOf(prefix, prefix.length, tabSize);
		let line = '';
		for (const w of words) {
			if (line && prefixWidth + line.length + 1 + w.length > width) {
				out.push(prefix + line);
				line = w;
			} else {
				line = line ? line + ' ' + w : w;
			}
		}
		out.push((prefix + line).replace(/\s+$/, ''));
		para = [];
	};
	for (const l of lines) {
		const body = leader ? l.replace(new RegExp(`^\\s*${leader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '') : l;
		if (!body.trim()) {
			flush();
			out.push(l);
		} else {
			para.push(l);
		}
	}
	flush();
	return out;
}
