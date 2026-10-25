/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { afterClosing, movePage, NO_NAME, nextTabPage, previousTabPage, restoreTabPages, serializeTabPages, SINGLE_TAB_PAGE, TAB_PAGE_WORKING_SET_NAME, tabMoveTarget, tabPageIndex, tabPageLabel, TabPagesState } from '../../common/vimTabPages.js';

suite('DevHub Vim tab pages: the list', () => {

	const page = (ws: string | null, ...windows: string[]) => ({ ws, windows, active: 0 });

	test('gt / {count}gt / gT / {count}gT as Vim: wrap, and a page that is not there is nothing', () => {
		assert.strictEqual(nextTabPage(null, 0, 3), 1);
		assert.strictEqual(nextTabPage(null, 2, 3), 0);
		assert.strictEqual(nextTabPage(0, 2, 3), 0);
		assert.strictEqual(nextTabPage(3, 0, 3), 2);
		assert.strictEqual(nextTabPage(1, 2, 3), 0);
		assert.strictEqual(nextTabPage(4, 0, 3), undefined);
		assert.strictEqual(previousTabPage(null, 0, 3), 2);
		assert.strictEqual(previousTabPage(1, 2, 3), 1);
		assert.strictEqual(previousTabPage(5, 0, 3), 1);
	});

	test('page numbers: N, $, +N, -N, + and -; E474 for none', () => {
		assert.strictEqual(tabPageIndex('', 1, 3), undefined);
		assert.strictEqual(tabPageIndex('2', 0, 3), 1);
		assert.strictEqual(tabPageIndex('$', 0, 3), 2);
		assert.strictEqual(tabPageIndex('+', 0, 3), 1);
		assert.strictEqual(tabPageIndex('+2', 0, 3), 2);
		assert.strictEqual(tabPageIndex('-1', 2, 3), 1);
		assert.throws(() => tabPageIndex('4', 0, 3), /E474/);
		assert.throws(() => tabPageIndex('+3', 0, 3), /E474/);
		assert.throws(() => tabPageIndex('x', 0, 3), /E474/);
	});

	test(':tabmove as Vim: after page N, 0 first, none or $ last, +N / -N relative', () => {
		// [A B C D], current A
		assert.strictEqual(tabMoveTarget('', 0, 4), 3);
		assert.strictEqual(tabMoveTarget('$', 0, 4), 3);
		assert.strictEqual(tabMoveTarget('2', 0, 4), 1); // after B: B A C D
		assert.strictEqual(tabMoveTarget('0', 3, 4), 0);
		assert.strictEqual(tabMoveTarget('1', 3, 4), 1); // after A: A D B C
		assert.strictEqual(tabMoveTarget('9', 1, 4), 3);
		assert.strictEqual(tabMoveTarget('+1', 1, 4), 2);
		assert.strictEqual(tabMoveTarget('-', 1, 4), 0);
		assert.throws(() => tabMoveTarget('+3', 1, 4), /E474/);
		const s: TabPagesState = { pages: [page(null, 'a'), page('b', 'b'), page('c', 'c')], current: 0 };
		const moved = movePage(s, 0, 2);
		assert.deepStrictEqual(moved.pages.map(p => p.windows[0]), ['b', 'c', 'a']);
		assert.strictEqual(moved.current, 2);
	});

	test('closing the current page goes to the next one, or the previous from the last', () => {
		assert.strictEqual(afterClosing(0, 3), 1);
		assert.strictEqual(afterClosing(1, 3), 2);
		assert.strictEqual(afterClosing(2, 3), 1);
	});

	test('labels: the active window\'s editor, [No Name] without one', () => {
		assert.strictEqual(tabPageLabel({ windows: ['a.ts', 'b.ts'], active: 1 }), 'b.ts');
		assert.strictEqual(tabPageLabel({ windows: ['a.ts', ''], active: 1 }), 'a.ts');
		assert.strictEqual(tabPageLabel({ windows: [], active: 0 }), NO_NAME);
	});

	test('restored from storage: pages whose working set is gone are dropped, the live layout is the current page, orphans and stale ones are found', () => {
		const sets = (...ids: string[]) => ids.map(id => ({ id, name: TAB_PAGE_WORKING_SET_NAME }));
		assert.deepStrictEqual(restoreTabPages(undefined, []), { state: SINGLE_TAB_PAGE, stale: [], orphans: [] });
		assert.deepStrictEqual(restoreTabPages('not json', sets('x')).orphans, ['x']);
		const raw = serializeTabPages({ pages: [page('a', 'a.ts'), page(null, 'b.ts'), page('gone', 'c.ts'), page('d', 'd.ts')], current: 1 });
		const r = restoreTabPages(raw, [...sets('a', 'd', 'orphan'), { id: 'scm', name: 'main' }]);
		assert.deepStrictEqual(r.state, { pages: [page('a', 'a.ts'), page(null, 'b.ts'), page('d', 'd.ts')], current: 1 });
		assert.deepStrictEqual(r.orphans, ['orphan']); // not SCM's working set
		// a switch that did not finish: the current page still names its working set; the live layout wins
		const half = restoreTabPages(serializeTabPages({ pages: [page('a', 'a.ts'), page('b', 'b.ts')], current: 1 }), sets('a', 'b'));
		assert.deepStrictEqual(half.state, { pages: [page('a', 'a.ts'), page(null, 'b.ts')], current: 1 });
		assert.deepStrictEqual(half.stale, ['b']);
		assert.deepStrictEqual(half.orphans, []);
	});
});
