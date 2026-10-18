/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: the file argument of `:e` `:sp` `:vs` `:new` `:vne` `:tabe`,
// resolved as Vim resolves it (common/vimEx.ts resolveExFileArg).

import assert from 'assert';
import { normalizeExPath, resolveExFileArg } from '../../common/vimEx.js';

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
