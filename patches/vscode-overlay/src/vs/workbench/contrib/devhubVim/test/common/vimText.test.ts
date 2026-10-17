/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { parseExLine, parseGlobal, parseSubstitute, resolveExAddress, canonicalExName } from '../../common/vimEx.js';
import { VimRegexError, compileVimRegex, expandReplacement, lineMatches, literalVimPattern, vimRegex } from '../../common/vimRegex.js';
import { addToNumber, colOfVcol, formatLines, rot13, vcolOf } from '../../common/vimText.js';

const OPTS = { ignorecase: false, smartcase: false };

/** [start, end] of the matches of a Vim pattern in `text`. */
function matches(pattern: string, text: string, opts: { ignorecase: boolean; smartcase: boolean; lastReplacement?: string } = OPTS): [number, number][] {
	return lineMatches(compileVimRegex(vimRegex(pattern, opts)), text);
}

function sub(pattern: string, rep: string, text: string, last = ''): string {
	const re = new RegExp(vimRegex(pattern, OPTS).source, 'u');
	const m = re.exec(text)!;
	return text.slice(0, m.index) + expandReplacement(rep, m, last) + text.slice(m.index + m[0].length);
}

suite('DevHub Vim regular expressions', () => {

	test('magic: \\( \\| \\+ \\= \\{n,m} \\< \\> and literal + ? ( )', () => {
		assert.deepStrictEqual(matches('a\\+', 'baaab'), [[1, 4]]);
		assert.deepStrictEqual(matches('a+', 'a+aa'), [[0, 2]]);
		assert.deepStrictEqual(matches('colou\\=r', 'color colour'), [[0, 5], [6, 12]]);
		assert.deepStrictEqual(matches('\\(ab\\)\\{2}', 'ababab'), [[0, 4]]);
		assert.deepStrictEqual(matches('a\\{-1,}', 'aaa'), [[0, 1], [1, 2], [2, 3]]);
		assert.deepStrictEqual(matches('\\<is\\>', 'this is'), [[5, 7]]);
		assert.deepStrictEqual(matches('cat\\|dog', 'dog cat'), [[0, 3], [4, 7]]);
		assert.deepStrictEqual(matches('f(x)', 'f(x)'), [[0, 4]]);
		assert.deepStrictEqual(matches('a.c', 'abc a.c'), [[0, 3], [4, 7]]);
		assert.deepStrictEqual(matches('a\\.c', 'abc a.c'), [[4, 7]]);
		assert.deepStrictEqual(matches('^\\s*x', '  x x'), [[0, 3]]);
		assert.deepStrictEqual(matches('x$', 'x x'), [[2, 3]]);
		assert.deepStrictEqual(matches('a^b', 'a^b'), [[0, 3]]);
		assert.deepStrictEqual(matches('*a', '*a'), [[0, 2]]);
	});

	test('\\v very magic, \\V very nomagic, \\M nomagic', () => {
		assert.deepStrictEqual(matches('\\v(a|b)+', 'xabx'), [[1, 3]]);
		assert.deepStrictEqual(matches('\\v<x>', 'x xx'), [[0, 1]]);
		assert.deepStrictEqual(matches('\\Va.b*', 'axb a.b*'), [[4, 8]]);
		assert.deepStrictEqual(matches('\\Va\\.b', 'axb'), [[0, 3]]);
		assert.deepStrictEqual(matches('\\Ma*', 'aa*'), [[1, 3]]);
	});

	test('classes, collections, \\zs \\ze, ~, case', () => {
		assert.deepStrictEqual(matches('\\d\\+', 'a12b3'), [[1, 3], [4, 5]]);
		assert.deepStrictEqual(matches('\\u\\l', 'aBcD'), [[1, 3]]);
		assert.deepStrictEqual(matches('[[:digit:]x]\\+', 'a1x2b'), [[1, 4]]);
		assert.deepStrictEqual(matches('[^a-c]', 'abcd'), [[3, 4]]);
		assert.deepStrictEqual(matches('[]]', 'a]'), [[1, 2]]);
		assert.deepStrictEqual(matches('foo\\zsbar', 'foobar bar'), [[3, 6]]);
		assert.deepStrictEqual(matches('foo\\zebar', 'foobar foo'), [[0, 3]]);
		assert.deepStrictEqual(matches('x~', 'xab', { ...OPTS, lastReplacement: 'ab' }), [[0, 3]]);
		assert.deepStrictEqual(matches('foo\\c', 'FOO'), [[0, 3]]);
		assert.deepStrictEqual(matches('Foo', 'foo Foo', { ignorecase: true, smartcase: true }), [[4, 7]]);
		assert.deepStrictEqual(matches('foo', 'foo Foo', { ignorecase: true, smartcase: true }), [[0, 3], [4, 7]]);
		assert.deepStrictEqual(matches('\\Sx', 'ax', { ignorecase: true, smartcase: true }), [[0, 2]]);
		assert.deepStrictEqual(matches('\\%d65', 'zA'), [[1, 2]]);
		assert.throws(() => vimRegex('a\\)', OPTS), VimRegexError);
		assert.throws(() => vimRegex('\\%V', OPTS), VimRegexError);
	});

	test('literal patterns (* on a word, v_*)', () => {
		const p = literalVimPattern('a.b/c\\d');
		assert.deepStrictEqual(matches(p, 'xa.b/c\\dx'), [[1, 8]]);
	});

	test(':s replacements: & \\0 \\1 ~ \\u \\U \\L \\e \\r \\n', () => {
		assert.strictEqual(sub('b', '<&>', 'abc'), 'a<b>c');
		assert.strictEqual(sub('b', '\\&', 'abc'), 'a&c');
		assert.strictEqual(sub('\\(a\\)\\(b\\)', '\\2\\1\\0', 'ab'), 'baab');
		assert.strictEqual(sub('b', 'x~y', 'abc', 'Q'), 'axQyc');
		assert.strictEqual(sub('\\w\\+', '\\u&', 'foo'), 'Foo');
		assert.strictEqual(sub('\\w\\+', '\\U&\\Ex', 'foo'), 'FOOx');
		assert.strictEqual(sub('\\w\\+', '\\L\\u&', 'FOO'), 'Foo');
		assert.strictEqual(sub(',', '\\r', 'a,b'), 'a\nb');
		assert.strictEqual(sub(',', '\\n', 'a,b'), 'a\0b');
	});
});

suite('DevHub Vim ex parsing', () => {

	test('names: abbreviations and aliases', () => {
		assert.deepStrictEqual(['s', 'su', 'sp', 'se', 'sor', 'w', 'wa', 'q', 'qa', 'x', 'noh', 'norm', 't', 'co', 'm', 'g', 'v', 'vs', 'j', 'pu', 'd', 'y', 'u', 'red', 'ls', 'bn', 'tabn', 'ka'].map(canonicalExName),
			['substitute', 'substitute', 'split', 'set', 'sort', 'write', 'wall', 'quit', 'qall', 'xit', 'nohlsearch', 'normal', 'copy', 'copy', 'move', 'global', 'vglobal', 'vsplit', 'join', 'put', 'delete', 'yank', 'undo', 'redo', 'buffers', 'bnext', 'tabnext', undefined]);
	});

	test('special names, ; ranges, patterns and marks as addresses', () => {
		assert.deepStrictEqual(parseExLine('&&'), { range: undefined, name: '&&', bang: false, args: '' });
		assert.deepStrictEqual(parseExLine('%s/a/b/g'), { range: ['1', '$'], name: 's', bang: false, args: '/a/b/g' });
		assert.deepStrictEqual(parseExLine('\'a,\'bd'), { range: ['\'a', '\'b'], name: 'd', bang: false, args: '' });
		assert.deepStrictEqual(parseExLine('/foo/,/bar/d'), { range: ['/foo/', '/bar/'], name: 'd', bang: false, args: '' });
		assert.deepStrictEqual(parseExLine('2;+3d'), { range: ['2', '+3'], semicolon: true, name: 'd', bang: false, args: '' });
		assert.deepStrictEqual(parseExLine('>>'), { range: undefined, name: '>', bang: false, args: '>' });
		assert.deepStrictEqual(parseExLine('*y'), { range: ['\'<', '\'>'], name: 'y', bang: false, args: '' });
		const ctx = { cursorLine: 5, lastLine: 20, visual: undefined, mark: (n: string) => n === 'a' ? 2 : undefined, search: (p: string) => p === 'foo' ? 9 : undefined };
		assert.strictEqual(resolveExAddress('\'a', ctx), 2);
		assert.strictEqual(resolveExAddress('\'z', ctx), undefined);
		assert.strictEqual(resolveExAddress('/foo/', ctx), 9);
		assert.strictEqual(resolveExAddress('/foo/+1', ctx), 10);
		assert.strictEqual(resolveExAddress('+3', ctx), 8);
		assert.strictEqual(resolveExAddress('$-1', ctx), 19);
	});

	test(':s and :g arguments', () => {
		assert.deepStrictEqual(parseSubstitute('/a/b/g'), { pattern: 'a', replacement: 'b', flags: 'g', count: undefined });
		assert.deepStrictEqual(parseSubstitute('#a/b#c#gi 3'), { pattern: 'a/b', replacement: 'c', flags: 'gi', count: 3 });
		assert.deepStrictEqual(parseSubstitute('/a\\/b/c'), { pattern: 'a/b', replacement: 'c', flags: '', count: undefined });
		assert.deepStrictEqual(parseSubstitute('/a/b'), { pattern: 'a', replacement: 'b', flags: '', count: undefined });
		assert.deepStrictEqual(parseSubstitute(' g'), { flags: 'g', count: undefined });
		assert.deepStrictEqual(parseSubstitute('&'), { flags: '&', count: undefined });
		assert.deepStrictEqual(parseGlobal('/x/d'), { pattern: 'x', command: 'd' });
		assert.deepStrictEqual(parseGlobal('!a\\!b!s/a/b/'), { pattern: 'a!b', command: 's/a/b/' });
		assert.deepStrictEqual(parseGlobal('/x/'), { pattern: 'x', command: 'p' });
	});
});

suite('DevHub Vim text helpers', () => {

	test('screen columns with tabs', () => {
		assert.strictEqual(vcolOf('\tab', 1, 4), 4);
		assert.strictEqual(vcolOf('a\tb', 2, 4), 4);
		assert.deepStrictEqual(colOfVcol('\tab', 2, 4), { col: 0, past: 0 });
		assert.deepStrictEqual(colOfVcol('\tab', 5, 4), { col: 2, past: 0 });
		assert.deepStrictEqual(colOfVcol('ab', 5, 4), { col: 2, past: 3 });
	});

	test('CTRL-A on numbers', () => {
		const nf = ['bin', 'hex'];
		assert.deepStrictEqual(addToNumber('x 9 y', 0, 1, nf), { start: 2, end: 3, text: '10', cursor: 3 });
		assert.deepStrictEqual(addToNumber('-1', 0, 1, nf), { start: 0, end: 2, text: '0', cursor: 0 });
		assert.deepStrictEqual(addToNumber('0xff', 1, 1, nf), { start: 0, end: 4, text: '0x100', cursor: 4 });
		assert.deepStrictEqual(addToNumber('0x0', 0, -1, nf), { start: 0, end: 3, text: '0xffffffffffffffff', cursor: 17 });
		assert.deepStrictEqual(addToNumber('0x10', 0, 1, []), { start: 0, end: 1, text: '1', cursor: 0 });
		assert.deepStrictEqual(addToNumber('0b11', 0, 1, nf), { start: 0, end: 4, text: '0b100', cursor: 4 });
		assert.deepStrictEqual(addToNumber('009', 0, 1, nf), { start: 0, end: 3, text: '010', cursor: 2 });
		assert.deepStrictEqual(addToNumber('a12b', 2, 1, nf), { start: 1, end: 3, text: '13', cursor: 2 });
		assert.deepStrictEqual(addToNumber('b', 0, 1, ['alpha']), { start: 0, end: 1, text: 'c', cursor: 0 });
		assert.strictEqual(addToNumber('abc', 0, 1, nf), undefined);
	});

	test('rot13 and the internal formatter', () => {
		assert.strictEqual(rot13('Hello, World'), 'Uryyb, Jbeyq');
		assert.deepStrictEqual(formatLines(['a b c d e f'], 5, undefined, 4), ['a b c', 'd e f']);
		assert.deepStrictEqual(formatLines(['  a b', 'c d e', '', 'x'], 7, undefined, 4), ['  a b c', '  d e', '', 'x']);
		assert.deepStrictEqual(formatLines(['# a b c', '# d'], 7, '#', 4), ['# a b c', '# d']);
		assert.deepStrictEqual(formatLines(['# a b c d'], 7, '#', 4), ['# a b c', '# d']);
	});
});
