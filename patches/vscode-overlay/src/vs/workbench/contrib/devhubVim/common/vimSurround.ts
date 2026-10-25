/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: tpope/vim-surround's text rules, as pure functions of
// strings. The engine (vimEngine.ts) finds what to surround or unsurround -
// with its own motions and text objects - and asks here what goes there:
// `surroundDelimiters` is vim-surround's choice of the pair for a
// replacement character (s:wrap's first half) and `surroundWrap` how the
// pair goes around the text (its second half, with s:fixindent), for the
// register types vim-surround knows ('char', 'line', 'block'). Imports
// nothing.

/** What a replacement character puts around the text. */
export interface SurroundDelimiters {
	readonly before: string;
	readonly after: string;
	/** `ys{motion}<Space>(`: one more blank inside on each side. */
	readonly extraspace: string;
}

/** The characters after which `ys` / `cs` / `S` ask for a tag (`<` as in vim-surround's input("<")). */
export function surroundAsksTag(replacement: string): boolean {
	const c = replacement.replace(/^ /, '');
	return c === 't' || c === 'T' || c === '<';
}

/** The tag a `T` replacement offers: the first one of what `ds` / `cs` removed last. */
export function surroundDefaultTag(lastRemoved: string): string {
	return /<(.*?)>/.exec(lastRemoved)?.[1] ?? '';
}

/**
 * The pair for a replacement character (` ` before it: `extraspace`): `b ( )
 * B { } r [ ] a > ` (an opening one with blanks inside), a tag (`t T <`,
 * with `tag` as typed at the prompt; `removed`: what `cs` took away, whose
 * attributes the new tag keeps unless the typed one ends in `>`), `p` (blank
 * lines), `s` (a leading blank), `:` (a leading colon), any other character
 * that is not an ASCII letter around both sides; a letter puts nothing. Undefined
 * for what DevHub does not do of vim-surround's (`l` `\` LaTeX environments,
 * `f` `F` function calls, `b:surround_*` / `g:surround_*` custom pairs).
 */
export function surroundDelimiters(replacement: string, tag: string | undefined, removed: string): SurroundDelimiters | undefined {
	let c = replacement;
	let extraspace = '';
	if (c.length > 1 && c.startsWith(' ')) {
		c = c.slice(1);
		extraspace = ' ';
	}
	const pairs = 'b()B{}r[]a<>';
	const idx = pairs.indexOf(c);
	if (c === ' ') {
		return { before: '', after: '', extraspace };
	}
	if (c === 'p') {
		return { before: '\n', after: '\n\n', extraspace };
	}
	if (c === 's') {
		return { before: ' ', after: '', extraspace };
	}
	if (c === ':') {
		return { before: ':', after: '', extraspace };
	}
	if (c === 't' || c === 'T' || c === '<') {
		let t = tag ?? '';
		if (!t) {
			return { before: '', after: '', extraspace };
		}
		const keepAttributes = !t.endsWith('>');
		t = t.replace(/>*$/, '');
		const attributes = keepAttributes ? (/<[^ \t\n]+([\s\S]*?)>/.exec(removed)?.[1] ?? '') : '';
		if (t.endsWith('/')) {
			return { before: `<${t.slice(0, -1)}${attributes} />`, after: '', extraspace };
		}
		return { before: `<${t}${attributes}>`, after: `</${t.replace(/ [\s\S]*$/, '')}>`, extraspace };
	}
	if (c === 'l' || c === '\\' || c === 'f' || c === 'F') {
		return undefined;
	}
	if (idx >= 0) {
		const spc = idx % 3 === 1 ? ' ' : '';
		const i = idx - idx % 3;
		return { before: pairs[i + 1] + spc, after: spc + pairs[i + 2], extraspace };
	}
	if (/^[A-Za-z]$/.test(c)) {
		return { before: '', after: '', extraspace };
	}
	return { before: c, after: c, extraspace };
}

/** The buffer's 'tabstop', 'shiftwidth' (0: the tabstop) and 'expandtab', for the indent `yS` / `cS` / `gS` add. */
export interface SurroundIndent {
	readonly tabstop: number;
	readonly shiftwidth: number;
	readonly expandtab: boolean;
}

/**
 * vim-surround's s:wrap: `text` (what a register of `type` would hold:
 * `line` without its last line break) with the pair around it. `special`:
 * `yS` `ySS` `cS` `gS` and a linewise `S` - the pair on lines of its own and
 * the text indented by a 'shiftwidth'. `initspaces`: the indent of the
 * text's first line (`line`) or of the cursor's line. A `line` result is
 * the lines that replace the text's lines; a `block` one has a line for
 * each of the text's.
 */
export function surroundWrap(text: string, d: SurroundDelimiters, type: 'char' | 'line' | 'block', special: boolean, initspaces: string, indent: SurroundIndent): string {
	let keeper = type === 'line' ? text + '\n' : text;
	let before = d.before;
	let after = d.after.replace(/\n/g, '\n' + initspaces);
	if (type === 'line' || (special && type === 'char')) {
		before = before.replace(/ +$/, '');
		after = after.replace(/^ +/, '');
		if (!after.startsWith('\n')) {
			after = initspaces + after;
		}
		if (!keeper.endsWith('\n') && !after.startsWith('\n')) {
			keeper += '\n';
		} else if (keeper.endsWith('\n') && after.startsWith('\n')) {
			after = after.slice(1);
		}
		if (!keeper.startsWith('\n') && !/\n[ \t]*$/.test(before)) {
			before += '\n';
			if (special) {
				before += '\t';
			}
		} else if (keeper.startsWith('\n') && /\n[ \t]*$/.test(before)) {
			keeper = keeper.slice(1);
		}
		if (type === 'line' && /\n[ \t]*\n$/.test(keeper)) {
			keeper = keeper.slice(0, -1);
		}
	}
	if (type === 'line') {
		before = initspaces + before;
	}
	const pad = /\n([ \t]*)$/.exec(before);
	if (pad) {
		if (type === 'char') {
			keeper = initspaces + keeper;
		}
		before = before.slice(0, before.length - pad[1].length);
		keeper = fixIndent(keeper, pad[1], indent);
	}
	if (type === 'line') {
		const out = before + keeper + after;
		// a linewise register's lines: its last line break ends the last line
		return out.endsWith('\n') ? out.slice(0, -1) : out;
	}
	if (type === 'block') {
		const b = before.replace(/\n/g, ' ');
		const a = after.replace(/\n/g, ' ');
		return keeper.split('\n').map(l => b + l + a).join('\n');
	}
	return before + d.extraspace + keeper + d.extraspace + after;
}

/**
 * s:fixindent: every non-empty line gets `padding` in front (vim-surround's
 * `\t`: a 'shiftwidth'), in the buffer's indent style. Unlike vim-surround,
 * only the indent is converted between tabs and spaces, never blanks
 * inside a line.
 */
function fixIndent(text: string, padding: string, o: SurroundIndent): string {
	const sw = o.shiftwidth || o.tabstop;
	const spaces = (s: string) => s.replace(/\t/g, ' '.repeat(sw));
	const pad = spaces(padding);
	return text.replace(/(^|\n)([ \t]*)(?=[^\n])/g, (_m, nl: string, ind: string) => {
		let i = pad + spaces(ind);
		if (!o.expandtab && o.tabstop > 0) {
			i = i.replace(new RegExp(`[ \\t]{${o.tabstop}}`, 'g'), '\t');
		}
		return nl + i;
	});
}
