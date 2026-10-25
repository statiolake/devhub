/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: tab pages, the list - which pages there are, in which
// order, which one is current, and where `gt` `:tabn 3` `:tabm +1` `:tabc $`
// go. Imports nothing (the tests run it as they run the engine).
//
// A tab page is a layout of editor groups (Vim's windows). The current one is
// the workbench's live layout; every other one is a VS Code editor working
// set (IEditorGroupsService.saveWorkingSet / applyWorkingSet), whose id the
// page holds. ../browser/vimTabPages.ts does the switching on the workbench.

/** What a page shows, for the tab line and `:tabs`: each window's (group's) editor name, in grid order, and which one is active. */
export interface TabPageMeta {
	readonly windows: readonly string[];
	readonly active: number;
}

export interface TabPage extends TabPageMeta {
	/** The working set that holds its layout; null for the current page (its layout is the live one) and for a new, empty one. */
	readonly ws: string | null;
}

export interface TabPagesState {
	readonly pages: readonly TabPage[];
	/** Index of the current page. */
	readonly current: number;
}

/** One page, the live layout: no tab line. */
export const SINGLE_TAB_PAGE: TabPagesState = { pages: [{ ws: null, windows: [], active: 0 }], current: 0 };

/** The working sets' name: tab pages' working sets are told apart from others' (SCM's) by it. */
export const TAB_PAGE_WORKING_SET_NAME = 'devhubVim.tabpage';

/** The label Vim gives a window without a file. */
export const NO_NAME = '[No Name]';

/** A page's label: its active window's editor. */
export function tabPageLabel(page: TabPageMeta): string {
	return page.windows[page.active] || page.windows.find(w => w) || NO_NAME;
}

function isMeta(v: unknown): v is { windows: unknown[]; active: number; ws: unknown } {
	const o = v as Record<string, unknown>;
	return typeof v === 'object' && v !== null && Array.isArray(o.windows) && typeof o.active === 'number';
}

/**
 * The stored list, checked against the working sets there are: a page other
 * than the current one whose working set is gone is dropped; the current
 * page's layout is the live one (a working set it still names, from a switch
 * that did not finish, is `stale`). `orphans` are tab page working sets no
 * page names (to delete).
 */
export function restoreTabPages(raw: string | undefined, workingSets: readonly { readonly id: string; readonly name: string }[]): { state: TabPagesState; stale: string[]; orphans: string[] } {
	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : undefined;
	} catch {
		parsed = undefined;
	}
	const ids = new Set(workingSets.map(w => w.id));
	const pages: TabPage[] = [];
	const stale: string[] = [];
	let current = 0;
	const p = parsed as { pages?: unknown; current?: unknown } | undefined;
	if (p && Array.isArray(p.pages) && typeof p.current === 'number' && p.current >= 0 && p.current < p.pages.length) {
		p.pages.forEach((page, i) => {
			if (!isMeta(page)) {
				return;
			}
			const windows = page.windows.map(w => typeof w === 'string' ? w : '');
			const meta = { windows, active: Math.max(0, Math.min(windows.length - 1, page.active | 0)) };
			if (i === p.current) {
				if (typeof page.ws === 'string') {
					stale.push(page.ws);
				}
				current = pages.length;
				pages.push({ ws: null, ...meta });
			} else if (typeof page.ws === 'string' && ids.has(page.ws)) {
				pages.push({ ws: page.ws, ...meta });
			}
		});
	}
	if (!pages.some(page => page.ws === null)) {
		return { state: SINGLE_TAB_PAGE, stale, orphans: workingSets.filter(w => w.name === TAB_PAGE_WORKING_SET_NAME).map(w => w.id) };
	}
	const named = new Set(pages.map(page => page.ws));
	return {
		state: { pages, current },
		stale,
		orphans: workingSets.filter(w => w.name === TAB_PAGE_WORKING_SET_NAME && !named.has(w.id) && !stale.includes(w.id)).map(w => w.id),
	};
}

export function serializeTabPages(state: TabPagesState): string {
	return JSON.stringify({ current: state.current, pages: state.pages.map(p => ({ ws: p.ws, windows: p.windows, active: p.active })) });
}

/** Vim's E474 for a page number that is none. */
export class TabPageError extends Error { }

/**
 * A tab page number as `:tabn` `:tabc` take it (0-based result): `N` (the
 * first page is 1; `0` is the first too), `$` (the last), `+N` / `-N` (after
 * / before the current one), `+` / `-` (the next / previous one); E474 past
 * either end. Undefined: no argument.
 */
export function tabPageIndex(arg: string, current: number, length: number): number | undefined {
	const a = arg.trim();
	if (!a) {
		return undefined;
	}
	let n: number;
	const m = /^([+-])(\d*)$/.exec(a);
	if (a === '$') {
		n = length - 1;
	} else if (m) {
		const by = m[2] ? Number(m[2]) : 1;
		n = m[1] === '+' ? current + by : current - by;
	} else if (/^\d+$/.test(a)) {
		n = Math.max(1, Number(a)) - 1;
	} else {
		throw new TabPageError('E474: Invalid argument');
	}
	if (n < 0 || n >= length) {
		throw new TabPageError('E474: Invalid argument');
	}
	return n;
}

/**
 * `gt` / `:tabn`: `{count}gt` goes to page {count} (nothing when there is no
 * such page, as Vim beeps), `gt` to the next one, from the last to the first.
 */
export function nextTabPage(count: number | null | undefined, current: number, length: number): number | undefined {
	if (typeof count === 'number' && count > 0) {
		return count <= length ? count - 1 : undefined;
	}
	return (current + 1) % length;
}

/** `{count}gT` / `:tabp {count}`: {count} pages back, from the first round to the last. */
export function previousTabPage(count: number | null | undefined, current: number, length: number): number {
	const by = typeof count === 'number' && count > 0 ? count : 1;
	return (((current - by) % length) + length) % length;
}

/** Where the current page goes after the current one is closed: the next one, or the previous one when it was the last. */
export function afterClosing(current: number, length: number): number {
	return current + 1 < length ? current + 1 : current - 1;
}

/**
 * `:tabm[ove] [N]`: the index the current page moves to. No argument and
 * `$`: last; `N`: after page N (`0`: first; past the last: last); `+N` / `-N`:
 * N places to the right / left (E474 past either end).
 */
export function tabMoveTarget(arg: string, current: number, length: number): number {
	const a = arg.trim();
	if (!a || a === '$') {
		return length - 1;
	}
	const m = /^([+-])(\d*)$/.exec(a);
	if (m) {
		const by = m[2] ? Number(m[2]) : 1;
		const to = m[1] === '+' ? current + by : current - by;
		if (to < 0 || to >= length) {
			throw new TabPageError('E474: Invalid argument');
		}
		return to;
	}
	if (!/^\d+$/.test(a)) {
		throw new TabPageError('E474: Invalid argument');
	}
	const n = Number(a);
	return Math.max(0, Math.min(length - 1, n <= current ? n : n - 1));
}

/** The list with the page at `from` put at `to`. */
export function movePage(state: TabPagesState, from: number, to: number): TabPagesState {
	const pages = [...state.pages];
	const [page] = pages.splice(from, 1);
	pages.splice(to, 0, page);
	return { pages, current: pages.indexOf(state.pages[state.current]) };
}
