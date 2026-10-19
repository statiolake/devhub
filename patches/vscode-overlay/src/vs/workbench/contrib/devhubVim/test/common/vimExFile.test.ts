/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: the file argument of `:e` `:sp` `:vs` `:new` `:vne` `:tabe`,
// resolved as Vim resolves it (common/vimEx.ts resolveExFileArg).

import assert from 'assert';
import { normalizeExPath, parseExFileOptions, resolveExFileArg, vimEncodingCompletions, vimEncodingHasBom, vimEncodingId, vimEncodingList, vimFileFormat } from '../../common/vimEx.js';

suite('DevHub Vim: file arguments', () => {

	const ctx = { cwd: '/ws', current: '/ws/src/vim/main.ts', home: '/Users/me' };

	test('relative to the current directory (the workspace folder), not to the current file', () => {
		assert.deepStrictEqual(resolveExFileArg('README.md', ctx), { path: '/ws/README.md' });
		assert.deepStrictEqual(resolveExFileArg('  src/a.ts ', ctx), { path: '/ws/src/a.ts' });
		assert.deepStrictEqual(resolveExFileArg('./src/../b.ts', ctx), { path: '/ws/b.ts' });
		assert.deepStrictEqual(resolveExFileArg('../other/c.ts', ctx), { path: '/other/c.ts' });
		assert.strictEqual(resolveExFileArg('', ctx), undefined);
		assert.strictEqual(resolveExFileArg('   ', ctx), undefined);
	});

	test('absolute paths, ~ and Windows drives', () => {
		assert.deepStrictEqual(resolveExFileArg('/etc/hosts', ctx), { path: '/etc/hosts' });
		assert.deepStrictEqual(resolveExFileArg('~/.zshrc', ctx), { path: '/Users/me/.zshrc' });
		assert.deepStrictEqual(resolveExFileArg('~', ctx), { path: '/Users/me' });
		// `~user` is not expanded; `a~b` is a name
		assert.deepStrictEqual(resolveExFileArg('~x/y', ctx), { path: '/ws/~x/y' });
		assert.deepStrictEqual(resolveExFileArg('a~b', ctx), { path: '/ws/a~b' });
		assert.ok('error' in resolveExFileArg('~/x', { cwd: '/ws' })!);
		assert.deepStrictEqual(resolveExFileArg('C:\\Users\\me\\a.txt', ctx), { path: '/C:/Users/me/a.txt' });
		assert.deepStrictEqual(resolveExFileArg('c:/x', ctx), { path: '/c:/x' });
	});

	test('% is the current file, with :p :h :t :r :e', () => {
		assert.deepStrictEqual(resolveExFileArg('%', ctx), { path: '/ws/src/vim/main.ts' });
		assert.deepStrictEqual(resolveExFileArg('%:p', ctx), { path: '/ws/src/vim/main.ts' });
		assert.deepStrictEqual(resolveExFileArg('%:h/keys.ts', ctx), { path: '/ws/src/vim/keys.ts' });
		assert.deepStrictEqual(resolveExFileArg('%:h:h', ctx), { path: '/ws/src' });
		assert.deepStrictEqual(resolveExFileArg('%:r.test.ts', ctx), { path: '/ws/src/vim/main.test.ts' });
		// :t is a name, relative to the current directory again
		assert.deepStrictEqual(resolveExFileArg('%:t', ctx), { path: '/ws/main.ts' });
		assert.deepStrictEqual(resolveExFileArg('x.%:e', ctx), { path: '/ws/x.ts' });
		// escaped: a literal %, a blank in a name
		assert.deepStrictEqual(resolveExFileArg('100\\%.txt', ctx), { path: '/ws/100%.txt' });
		assert.deepStrictEqual(resolveExFileArg('my\\ notes.md', ctx), { path: '/ws/my notes.md' });
		assert.deepStrictEqual(resolveExFileArg('my notes.md', ctx), { path: '/ws/my notes.md' });
		// no current file (untitled): Vim's E499
		const r = resolveExFileArg('%:h/x', { cwd: '/ws' });
		assert.ok(r && 'error' in r && r.error.startsWith('E499'), JSON.stringify(r));
	});

	test('a name with * is a pattern for quick open; \\* is a star in the name', () => {
		assert.deepStrictEqual(resolveExFileArg('src/*.ts', ctx), { glob: 'src/*.ts' });
		assert.deepStrictEqual(resolveExFileArg('*main*', ctx), { glob: '*main*' });
		assert.deepStrictEqual(resolveExFileArg('a\\*b', ctx), { path: '/ws/a*b' });
	});

	test('paths are normalized as paths, whatever file system they are in', () => {
		assert.strictEqual(normalizeExPath('/a//b/./c/../d/'), '/a/b/d');
		assert.strictEqual(normalizeExPath('/..'), '/');
		// a remote workspace's folder is a path too: the browser puts it back into that folder's URI
		assert.deepStrictEqual(resolveExFileArg('x', { cwd: '/home/dev/proj', home: '/home/dev' }), { path: '/home/dev/proj/x' });
	});
});

suite('DevHub Vim: file encodings', () => {

	test('Vim\'s and iconv\'s names are VS Code\'s encoding ids', () => {
		const ids: Record<string, string> = {
			'utf-8': 'utf8', 'UTF8': 'utf8', 'utf8': 'utf8', 'utf-8-bom': 'utf8bom', 'utf8bom': 'utf8bom',
			'utf-16le': 'utf16le', 'UTF-16BE': 'utf16be', 'utf-16': 'utf16be', 'ucs-2le': 'utf16le', 'ucs-2': 'utf16be',
			'cp932': 'shiftjis', 'sjis': 'shiftjis', 'shift_jis': 'shiftjis', 'Shift-JIS': 'shiftjis', 'shiftjis': 'shiftjis', 'ms932': 'shiftjis',
			'euc-jp': 'eucjp', 'eucjp': 'eucjp', 'ujis': 'eucjp', 'euc-kr': 'euckr', 'cp949': 'euckr',
			'latin1': 'iso88591', 'iso-8859-1': 'iso88591', 'iso8859-15': 'iso885915', 'latin9': 'iso885915', 'latin2': 'iso88592',
			'cp1252': 'windows1252', 'windows-1252': 'windows1252', 'cp1251': 'windows1251', 'cp1250': 'windows1250',
			'gbk': 'gbk', 'cp936': 'gbk', 'gb2312': 'gb2312', 'euc-cn': 'gb2312', 'gb18030': 'gb18030', 'big5': 'cp950', 'cp950': 'cp950',
			'koi8-r': 'koi8r', 'cp866': 'cp866', 'cp437': 'cp437', 'macroman': 'macroman', 'cp874': 'windows874',
		};
		for (const [name, id] of Object.entries(ids)) {
			assert.strictEqual(vimEncodingId(name), id, name);
		}
		for (const bad of ['', 'klingon', 'utf-32', 'ucs-4', 'euc', 'cp', 'utf']) {
			assert.strictEqual(vimEncodingId(bad), undefined, bad);
		}
	});

	test('every id is its own name, with a label, once (the list is what VS Code\'s "Select Encoding" has)', () => {
		const list = vimEncodingList();
		assert.strictEqual(list.length, 49);
		assert.strictEqual(new Set(list.map(e => e.id)).size, list.length);
		for (const { id, label } of list) {
			assert.strictEqual(vimEncodingId(id), id);
			assert.ok(label.length > 0);
		}
		// a name belongs to one encoding
		const seen = new Map<string, string>();
		for (const name of ['utf8', 'sjis', 'latin1', 'cp1252']) {
			seen.set(name, vimEncodingId(name)!);
		}
		assert.strictEqual(new Set(seen.values()).size, seen.size);
	});

	test('completion: by id or by a Vim spelling, in the order of VS Code\'s list', () => {
		assert.deepStrictEqual(vimEncodingCompletions('utf').map(e => e.id), ['utf8', 'utf8bom', 'utf16le', 'utf16be']);
		assert.deepStrictEqual(vimEncodingCompletions('utf-1').map(e => e.id), ['utf16le', 'utf16be']);
		assert.deepStrictEqual(vimEncodingCompletions('sj').map(e => e.id), ['shiftjis']);
		assert.deepStrictEqual(vimEncodingCompletions('euc').map(e => e.id), ['eucjp', 'euckr', 'gb2312']);
		assert.strictEqual(vimEncodingCompletions('').length, 49);
		assert.deepStrictEqual(vimEncodingCompletions('zz'), []);
	});

	test('BOM: UTF-8 with BOM and UTF-16 have one; unix and dos are the line ends VS Code has, mac is not', () => {
		assert.deepStrictEqual(['utf8', 'utf8bom', 'utf16le', 'utf16be', 'shiftjis'].map(vimEncodingHasBom), [false, true, true, true, false]);
		assert.deepStrictEqual(['unix', 'DOS', 'mac', 'x', ''].map(vimFileFormat), ['unix', 'dos', undefined, undefined, undefined]);
	});

	test('++enc= and ++ff= in front of a file argument; the rest is the file', () => {
		assert.deepStrictEqual(parseExFileOptions('++enc=cp932 src/a.ts'), { enc: 'shiftjis', rest: 'src/a.ts' });
		assert.deepStrictEqual(parseExFileOptions('  ++encoding=UTF-16LE   ++ff=dos  my notes.md'), { enc: 'utf16le', ff: 'dos', rest: 'my notes.md' });
		assert.deepStrictEqual(parseExFileOptions('++fileformat=unix'), { ff: 'unix', rest: '' });
		assert.deepStrictEqual(parseExFileOptions('++enc=latin1 ++enc=sjis x'), { enc: 'shiftjis', rest: 'x' });
		// not in front: a name (a + in a file name is allowed)
		assert.deepStrictEqual(parseExFileOptions('a++enc=sjis'), { rest: 'a++enc=sjis' });
		assert.deepStrictEqual(parseExFileOptions('>> out.txt'), { rest: '>> out.txt' });
		assert.deepStrictEqual(parseExFileOptions(''), { rest: '' });
	});

	test('++opt errors are E474: unknown encoding, ff=mac and others, no value, the options VS Code cannot do', () => {
		const error = (args: string) => (parseExFileOptions(args) as { error: string }).error;
		assert.strictEqual(error('++enc=klingon x'), 'E474: Invalid argument: ++enc=klingon');
		assert.strictEqual(error('++enc x'), 'E474: Invalid argument: ++enc');
		assert.strictEqual(error('++enc= x'), 'E474: Invalid argument: ++enc=');
		assert.strictEqual(error('++ff=mac'), 'E474: Invalid argument: ++ff=mac (VS Code has no CR line endings)');
		assert.strictEqual(error('++ff=x'), 'E474: Invalid argument: ++ff=x');
		assert.strictEqual(error('++bin x'), 'E474: Invalid argument: ++bin (not supported)');
		assert.strictEqual(error('++bad=keep x'), 'E474: Invalid argument: ++bad=keep (not supported)');
		assert.strictEqual(error('++what x'), 'E474: Invalid argument: ++what');
	});
});
