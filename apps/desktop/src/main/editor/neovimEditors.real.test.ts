/**
 * A Neovim drawn over a terminal pane follows its pane's size only while
 * DevHub's page over that pane is its one UI: Neovim draws every attached UI
 * at the smallest one's size. A page that goes — its overlay ended and made
 * again, its terminal closed — has to take its UI with it, or the Neovim
 * stays at that page's last size whatever the next page over the pane asks.
 *
 * DevHub's own Neovim (`testNeovim.ts`), with the UIs run by main
 * (`NeovimUiSessions`), as with no Neovim host.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSocketDir } from "../../model/testScratch.js";
import type { ManagedNeovims } from "./managedNeovim.js";
import { NeovimEditors, type NeovimPage } from "./neovimEditors.js";
import { NeovimClient } from "./neovimRpc.js";
import { TEST_NVIM } from "./testNeovim.js";

const children: ChildProcess[] = [];
const directories: string[] = [];
const clients: NeovimClient[] = [];

afterEach(() => {
	for (const client of clients.splice(0)) client.close();
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

async function startNvim(): Promise<{ socket: string; probe: NeovimClient }> {
	const sockets = makeSocketDir("nvim-editors");
	directories.push(sockets);
	const socket = join(sockets, "n.sock");
	const child = spawn(
		TEST_NVIM as string,
		["--headless", "--clean", "--listen", socket],
		{ stdio: "ignore" },
	);
	children.push(child);
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (existsSync(socket)) {
			try {
				const probe = await NeovimClient.connect(socket);
				clients.push(probe);
				return { socket, probe };
			} catch {
				// Not listening yet.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("nvim did not open its socket");
}

/** A page as Electron's `WebContents` is to main: it can be closed. */
class FakePage implements NeovimPage {
	static next = 1;
	readonly id = FakePage.next++;
	destroyed = false;
	readonly #destroyed: (() => void)[] = [];
	readonly #navigated: (() => void)[] = [];
	isDestroyed(): boolean {
		return this.destroyed;
	}
	send(): void {}
	postMessage(): void {}
	once(_event: "destroyed", listener: () => void): void {
		this.#destroyed.push(listener);
	}
	on(_event: "did-navigate", listener: () => void): void {
		this.#navigated.push(listener);
	}
	reload(): void {
		for (const listener of this.#navigated) listener();
	}
	close(): void {
		this.destroyed = true;
		for (const listener of this.#destroyed.splice(0)) listener();
	}
}

async function uiSizes(probe: NeovimClient): Promise<string[]> {
	const uis = (await probe.request("nvim_list_uis", [])) as {
		width: number;
		height: number;
	}[];
	return uis.map((ui) => `${String(ui.width)}x${String(ui.height)}`);
}

async function screenSize(probe: NeovimClient): Promise<string> {
	return (await probe.request("nvim_eval", [
		'&columns . "x" . &lines',
	])) as string;
}

describe.skipIf(TEST_NVIM === undefined)("an overlay's UI", () => {
	it("goes with its page, so the next page's size is the Neovim's", async () => {
		const { socket, probe } = await startNvim();
		const ended: string[] = [];
		const editors = new NeovimEditors({
			neovims: {} as ManagedNeovims,
			clipboard: { read: () => Promise.resolve(""), write: () => {} },
			overlays: {
				connection: (key: string) =>
					Promise.resolve({
						socketPath: socket,
						server: Number(key.slice(4)),
						machine: "local" as const,
					}),
				attached: () => {},
				ended: (key: string) => {
					ended.push(key);
				},
			},
		});
		// The pane was small (a split) when its first overlay attached.
		const first = new FakePage();
		await expect(
			editors.attach(first, { workspaceId: "tnv:1", cols: 40, rows: 6 }),
		).resolves.toMatchObject({ ok: true });
		// Its overlay is made again over the same pane, now grown back.
		const second = new FakePage();
		await expect(
			editors.attach(second, { workspaceId: "tnv:2", cols: 120, rows: 40 }),
		).resolves.toMatchObject({ ok: true });
		expect(await uiSizes(probe)).toEqual(["40x6", "120x40"]);
		expect(await screenSize(probe)).toBe("40x6");

		first.close();
		await vi.waitFor(async () => {
			expect(await uiSizes(probe)).toEqual(["120x40"]);
		});
		await vi.waitFor(async () => {
			expect(await screenSize(probe)).toBe("120x40");
		});
		// And it follows the pane from here: a shrink, then a grow.
		editors.call({
			workspaceId: "tnv:2",
			method: "nvim_ui_try_resize",
			params: [60, 10],
		});
		await vi.waitFor(async () => {
			expect(await screenSize(probe)).toBe("60x10");
		});
		editors.call({
			workspaceId: "tnv:2",
			method: "nvim_ui_try_resize",
			params: [150, 45],
		});
		await vi.waitFor(async () => {
			expect(await screenSize(probe)).toBe("150x45");
		});
		// Letting go of a page's UI is not its Neovim ending.
		expect(ended).toEqual([]);
		second.close();
		await vi.waitFor(async () => {
			expect(await uiSizes(probe)).toEqual([]);
		});
		editors.dispose();
	});

	it("is let go of when its page loads again, and the page attaches anew at its size", async () => {
		const { socket, probe } = await startNvim();
		const ended: string[] = [];
		const page = new FakePage();
		const editors = new NeovimEditors({
			neovims: {} as ManagedNeovims,
			clipboard: { read: () => Promise.resolve(""), write: () => {} },
			overlays: {
				connection: () =>
					Promise.resolve({
						socketPath: socket,
						server: 1,
						machine: "local" as const,
					}),
				attached: () => {},
				ended: (key: string) => {
					ended.push(key);
				},
			},
		});
		const request = { workspaceId: "tnv:1", cols: 40, rows: 6 };
		await expect(editors.attach(page, request)).resolves.toMatchObject({
			ok: true,
		});
		page.reload();
		await vi.waitFor(async () => {
			expect(await uiSizes(probe)).toEqual([]);
		});
		await expect(
			editors.attach(page, { ...request, cols: 80, rows: 20 }),
		).resolves.toMatchObject({ ok: true });
		expect(await uiSizes(probe)).toEqual(["80x20"]);
		expect(ended).toEqual([]);
		editors.dispose();
	});

	it("is let go of when its page went while it attached", async () => {
		const { socket, probe } = await startNvim();
		const page = new FakePage();
		const editors = new NeovimEditors({
			neovims: {} as ManagedNeovims,
			clipboard: { read: () => Promise.resolve(""), write: () => {} },
			overlays: {
				connection: () => {
					page.close();
					return Promise.resolve({
						socketPath: socket,
						server: 1,
						machine: "local" as const,
					});
				},
				attached: () => {},
				ended: () => {},
			},
		});
		await expect(
			editors.attach(page, { workspaceId: "tnv:1", cols: 40, rows: 6 }),
		).resolves.toMatchObject({ ok: false });
		await vi.waitFor(async () => {
			expect(await uiSizes(probe)).toEqual([]);
		});
		editors.dispose();
	});
});
