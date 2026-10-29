/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferFlags, edgeBuffer, findBuffer, formatBufferLine, listBuffers, parseStoredBuffers, quitBlocker, quitRefusal, serializeStoredBuffers, stepBuffer, VimBufferEntry } from '../../common/vimBuffers.js';

suite('DevHub Vim buffers: the list', () => {

	const buf = (nr: number, name: string, o: Partial<VimBufferEntry> = {}): VimBufferEntry => ({
		nr, name, fullName: `/work/${name}`, listed: true, loaded: true, shown: false, modified: false, readonly: false, line: 1, ...o,
	});
	const list = [
		buf(1, 'src/main.ts', { shown: true, line: 12 }),
		buf(2, 'src/util.ts', { modified: true, line: 3 }),
		buf(3, 'README.md', { listed: false, loaded: false, line: 0 }),
		buf(5, 'src/main.test.ts', { loaded: false, line: 7 }),
		buf(6, 'Settings', { fullName: 'Settings', readonly: true }),
	];
	const marks = { current: 1, alternate: 2 };

	test(':ls lines as Vim prints them: number, u % # a h - +, the name quoted, line N in column 40', () => {
		assert.deepStrictEqual(listBuffers(list, marks, false).map(b => formatBufferLine(b, marks)), [
			'  1 %a   "src/main.ts"                  line 12',
			'  2 #h + "src/util.ts"                  line 3',
			'  5      "src/main.test.ts"             line 7',
			'  6  h-  "Settings"                     line 1',
		]);
		// :ls! adds the unlisted ones
		assert.deepStrictEqual(listBuffers(list, marks, true).map(b => b.nr), [1, 2, 3, 5, 6]);
		assert.strictEqual(bufferFlags(list[2], marks), 'u    ');
		assert.strictEqual(formatBufferLine(list[2], marks), '  3u     "README.md"                    line 0');
		// a name past column 40 still gets one blank
		assert.strictEqual(formatBufferLine(buf(10, 'a/very/long/path/to/some/file/deep/inside.ts'), marks), ' 10  h   "a/very/long/path/to/some/file/deep/inside.ts" line 1');
	});

	test(':ls {flags} keeps the buffers that have them all', () => {
		assert.deepStrictEqual(listBuffers(list, marks, false, '+').map(b => b.nr), [2]);
		assert.deepStrictEqual(listBuffers(list, marks, false, 'h').map(b => b.nr), [2, 6]);
		assert.deepStrictEqual(listBuffers(list, marks, false, 'a').map(b => b.nr), [1]);
		assert.deepStrictEqual(listBuffers(list, marks, true, 'u').map(b => b.nr), [3]);
		assert.deepStrictEqual(listBuffers(list, marks, false, '%').map(b => b.nr), [1]);
		assert.deepStrictEqual(listBuffers(list, marks, false, 'h+').map(b => b.nr), [2]);
	});

	test(':b {N}, %, #, and a name as Vim matches it: anywhere, then at the start, at the end, whole; listed before unlisted; E86 E93 E94 E23', () => {
		assert.strictEqual(findBuffer('5', list, marks, false).nr, 5);
		assert.throws(() => findBuffer('4', list, marks, false), /^Error: E86: Buffer 4 does not exist$/);
		assert.strictEqual(findBuffer('%', list, marks, false).nr, 1);
		assert.strictEqual(findBuffer('#', list, marks, false).nr, 2);
		assert.throws(() => findBuffer('#', list, { current: 1, alternate: undefined }, false), /E23: No alternate file/);
		assert.strictEqual(findBuffer('util', list, marks, false).nr, 2);
		// "main" is in two names: the start does not decide, nor the end; the whole name does not match: E93
		assert.throws(() => findBuffer('main', list, marks, false), /E93: More than one match for main/);
		// at the end only one: "main.ts" is the end of src/main.ts alone
		assert.strictEqual(findBuffer('main.ts', list, marks, false).nr, 1);
		assert.strictEqual(findBuffer('test', list, marks, false).nr, 5);
		assert.strictEqual(findBuffer('src/*test*', list, marks, false).nr, 5);
		// the full name matches too
		assert.strictEqual(findBuffer('/work/src/util', list, marks, false).nr, 2);
		// an unlisted buffer only when no listed one matches
		assert.strictEqual(findBuffer('README', list, marks, false).nr, 3);
		assert.throws(() => findBuffer('readme', list, marks, false), /E94: No matching buffer for readme/);
		assert.strictEqual(findBuffer('readme', list, marks, true).nr, 3, '\'fileignorecase\' (macOS)');
	});

	test(':bn :bp [N] go round the listed buffers in number order; :bf :bl; E85 with none', () => {
		assert.strictEqual(stepBuffer(list, 1, 1).nr, 2);
		assert.strictEqual(stepBuffer(list, 2, 1).nr, 5, 'the unlisted 3 is skipped');
		assert.strictEqual(stepBuffer(list, 6, 1).nr, 1, 'from the last to the first');
		assert.strictEqual(stepBuffer(list, 1, -1).nr, 6);
		assert.strictEqual(stepBuffer(list, 1, 3).nr, 6);
		assert.strictEqual(stepBuffer(list, 1, -5).nr, 6);
		// from an unlisted buffer (or none), as if it were in the list
		assert.strictEqual(stepBuffer(list, 3, 1).nr, 5);
		assert.strictEqual(stepBuffer(list, 3, -1).nr, 2);
		assert.strictEqual(stepBuffer(list, undefined, 1).nr, 1);
		assert.strictEqual(edgeBuffer(list, false).nr, 1);
		assert.strictEqual(edgeBuffer(list, true).nr, 6);
		assert.throws(() => stepBuffer([], undefined, 1), /E85: There is no listed buffer/);
	});

	test('what stops a quit (Neovim check_changed_any): the current buffer, then the other windows\', then the hidden ones by number; :q! only hidden ones', () => {
		const b = (nr: number, modified: boolean, shown = false, current = false) => ({ nr, modified, shown, current });
		assert.strictEqual(quitBlocker([b(1, false, true, true), b(2, false)], false), undefined);
		assert.strictEqual(quitBlocker([b(4, true), b(1, true, true, true), b(2, true, true)], false)?.nr, 1);
		assert.strictEqual(quitBlocker([b(4, true), b(1, false, true, true), b(9, true, true)], false)?.nr, 9);
		assert.strictEqual(quitBlocker([b(4, true), b(3, true), b(1, false, true, true)], false)?.nr, 3);
		assert.strictEqual(quitBlocker([b(1, true, true, true), b(2, true, true)], true), undefined, ':q!: the buffers windows show are not checked');
		assert.strictEqual(quitBlocker([b(1, true, true, true), b(7, true)], true)?.nr, 7);
		assert.strictEqual(quitRefusal('src/a.ts'), 'E37: No write since last change  E162: No write since last change for buffer "src/a.ts"');
	});

	test('the stored list: numbers and the next one survive; junk is dropped', () => {
		const stored = { next: 7, buffers: [{ nr: 2, key: 'k2', name: 'b', listed: false, line: 4, open: { resource: 'file:///b' } }, { nr: 1, key: 'k1', name: 'a', listed: true, line: 0 }] };
		const parsed = parseStoredBuffers(serializeStoredBuffers(stored));
		assert.strictEqual(parsed.next, 7);
		assert.deepStrictEqual(parsed.buffers.map(b => [b.nr, b.key, b.listed, b.line, b.open?.resource]), [[1, 'k1', true, 0, undefined], [2, 'k2', false, 4, 'file:///b']]);
		assert.deepStrictEqual(parseStoredBuffers('{"next": 2, "buffers": [{"nr": 9, "key": "x", "name": "x"}, {"nr": "y"}]}').next, 10);
		assert.deepStrictEqual(parseStoredBuffers('nonsense'), { next: 1, buffers: [] });
	});
});
