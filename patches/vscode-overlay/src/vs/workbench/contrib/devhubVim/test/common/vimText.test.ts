/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { BUILTIN_EX_REGISTRY, parseExCommand, parseGlobal, parseSubstitute, resolveExAddress, canonicalExName } from '../../common/vimEx.js';

/** What the parser read: the range, the name as typed, `!`, the argument. */
function parseExLine(line: string) {
	const p = parseExCommand(line, BUILTIN_EX_REGISTRY);
	return { range: p.range, ...(p.semicolon ? { semicolon: true } : {}), name: p.name, bang: p.bang, args: p.args.trim() };
}
import { patternMatchCase, regexError } from '../../common/vimEngine.js';
import { addToNumber, colOfVcol, formatLines, rot13, vcolOf } from '../../common/vimText.js';

suite('DevHub Vim patterns are JavaScript regular expressions', () => {

	test('an invalid one says why; a valid one does not', () => {
		assert.strictEqual(regexError('a(b|c)+\\d{2}'), undefined);
		assert.strictEqual(regexError('\\bfoo\\b'), undefined);
		assert.ok(regexError('(foo'));
		assert.ok(regexError('a\\'));
	});

	test('ignorecase and smartcase decide the case; escapes and group names are no uppercase', () => {
		assert.strictEqual(patternMatchCase('foo', false, false), true);
		assert.strictEqual(patternMatchCase('Foo', true, false), false);
		assert.strictEqual(patternMatchCase('foo', true, true), false);
		assert.strictEqual(patternMatchCase('Foo', true, true), true);
		assert.strictEqual(patternMatchCase('\\W\\S\\D\\B', true, true), false);
		assert.strictEqual(patternMatchCase('\\p{Lu}\\u00C9\\x4A\\cJ(?<Name>x)\\k<Name>', true, true), false);
		assert.strictEqual(patternMatchCase('\\wÉ', true, true), true);
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
		assert.deepStrictEqual(parseSubstitute('/a/b/g'), { pattern: 'a', replacement: 'b', flags: 'g', count: undefined, upTo: 'flags' });
		assert.deepStrictEqual(parseSubstitute('#a/b#c#gi 3'), { pattern: 'a/b', replacement: 'c', flags: 'gi', count: 3, upTo: 'flags' });
		assert.deepStrictEqual(parseSubstitute('/a\\/b/c'), { pattern: 'a/b', replacement: 'c', flags: '', count: undefined, upTo: 'replacement' });
		assert.deepStrictEqual(parseSubstitute('/a/b'), { pattern: 'a', replacement: 'b', flags: '', count: undefined, upTo: 'replacement' });
		assert.deepStrictEqual(parseSubstitute('/a/'), { pattern: 'a', replacement: '', flags: '', count: undefined, upTo: 'replacement' });
		assert.deepStrictEqual(parseSubstitute('/a'), { pattern: 'a', replacement: '', flags: '', upTo: 'pattern' });
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
