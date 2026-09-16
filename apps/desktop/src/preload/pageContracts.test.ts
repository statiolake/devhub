/*
 * One page, one entry, one preload, one bridge.
 *
 * The preload *is* the enforcement: a member a page does not own is not
 * refused at runtime, it is absent, which TypeScript can say and a running
 * page cannot work around. That only holds while the correspondence holds —
 * so this asserts the three lists that have to agree, and the one containment
 * rule that makes a bridge a page's own.
 *
 * The failure it exists to catch is quiet in both directions. A page added to
 * `vite.config.ts` and forgotten in `build-preloads.mjs` loads with no
 * `window.devhub` at all; a bridge imported from a second page's module graph
 * is a page spelling members main never meant it to have, which is exactly
 * what `?window=` used to make normal.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
	readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** Every DevHub page, by the name its entry, preload and bridge share. */
const PAGES = [
	"shell",
	"sidebar",
	"agents",
	"toasts",
	"tooltip",
	"picker",
	"settings",
] as const;

/** Which HTML entry each page is served from, where it is not its own name. */
const ENTRY: Partial<Record<(typeof PAGES)[number], string>> = {
	shell: "index",
};

const entryOf = (page: string) => ENTRY[page as (typeof PAGES)[number]] ?? page;

describe("the pages, and what each of them may say", () => {
	it("has one preload bundle per page", () => {
		const script = read("../../scripts/build-preloads.mjs");
		const listed = /const PAGES = \[([^\]]*)\]/.exec(script)?.[1] ?? "";
		const pages = [...listed.matchAll(/"([^"]+)"/g)].map(([, name]) => name);
		expect(pages.sort()).toEqual([...PAGES].sort());
	});

	it("has one HTML entry per page, and no page without one", () => {
		const config = read("../../vite.config.ts");
		for (const page of PAGES) {
			// Settings is its own window rather than a child view, but it is a page
			// like any other: its own entry, its own preload, its own bridge.
			expect(config).toContain(`${entryOf(page)}.html`);
		}
	});

	it("builds a bridge in each preload and exposes it", () => {
		for (const page of PAGES) {
			const preload = read(`./${page}.ts`);
			expect(preload).toContain("contextBridge.exposeInMainWorld");
		}
	});

	/**
	 * The rule that makes a bridge a page's own: it is reachable from that
	 * page's entry and from no other entry.
	 *
	 * Not "lives in the same directory" — `components/sidebar/` is the
	 * Sidebar's own and imports the Sidebar's bridge quite properly. What must
	 * not happen is a *second page's* graph reaching a bridge that is not its
	 * own, because that page would then be spelling members its preload never
	 * exposed: it typechecks, it loads, and the call lands on a channel nobody
	 * answers. That is the failure `?window=` made normal and the split exists
	 * to end.
	 */
	it("reaches each page's bridge from that page's entry and from no other", () => {
		const entries = {
			shell: "main.tsx",
			sidebar: "sidebar/main.tsx",
			agents: "agents/main.tsx",
			toasts: "toasts/main.tsx",
			tooltip: "tooltip/main.tsx",
			picker: "picker/main.tsx",
		} as const;
		const bridges = {
			sidebar: "sidebar/client.tsx",
			agents: "agents/client.tsx",
			toasts: "toasts/client.tsx",
			tooltip: "tooltip/client.tsx",
			picker: "picker/client.tsx",
		} as const;

		const graphs = new Map<string, ReadonlySet<string>>();
		for (const [page, entry] of Object.entries(entries)) {
			graphs.set(page, reachableFrom(entry));
		}

		for (const [owner, bridge] of Object.entries(bridges)) {
			const module = resolveExtension(bridge);
			for (const [page, graph] of graphs) {
				const reaches = graph.has(module);
				expect(
					reaches,
					reaches
						? `the ${page} page reaches the ${owner} page's bridge`
						: `the ${owner} page's entry does not reach its own bridge`,
				).toBe(page === owner);
			}
		}
	});
});

/** `client.tsx` or `client.ts`, whichever is on disk. */
function resolveExtension(relative: string): string {
	const { existsSync } = require("node:fs") as typeof import("node:fs");
	const base = relative.replace(/\.tsx$/, "");
	for (const extension of [".ts", ".tsx"]) {
		const candidate = `${base}${extension}`;
		if (
			existsSync(
				fileURLToPath(new URL(`../shell/${candidate}`, import.meta.url)),
			)
		) {
			return candidate;
		}
	}
	throw new Error(`no module on disk for ${relative}`);
}

/**
 * Every module under `shell/` an entry reaches, following relative imports.
 *
 * Only relative imports, because those are the ones that make a page's graph:
 * a bare specifier is a package, and `../../ipc/...` is the contract both ends
 * share by design. Paths are normalised against the importing file so that a
 * `./client` in one directory is never the `./client` in another.
 */
function reachableFrom(entry: string): ReadonlySet<string> {
	const { existsSync } = require("node:fs") as typeof import("node:fs");
	const exists = (relative: string) =>
		existsSync(fileURLToPath(new URL(`../shell/${relative}`, import.meta.url)));

	const seen = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const current = queue.pop();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);
		const source = read(`../shell/${current}`);
		const here = current.includes("/") ? current.replace(/\/[^/]+$/, "") : "";
		for (const [, specifier] of source.matchAll(/from "([^"]+)"/g)) {
			if (!specifier.startsWith(".")) continue;
			const segments = [...(here === "" ? [] : here.split("/"))];
			for (const part of specifier.split("/")) {
				if (part === ".") continue;
				if (part === "..") segments.pop();
				else segments.push(part);
			}
			const target = segments.join("/");
			// Anything outside `shell/` — `../ipc/contract`, `../model/...` — is
			// shared by design and is not part of any one page's graph.
			if (target.startsWith("..")) continue;
			for (const extension of [".ts", ".tsx"]) {
				if (exists(`${target}${extension}`))
					queue.push(`${target}${extension}`);
			}
		}
	}
	return seen;
}
