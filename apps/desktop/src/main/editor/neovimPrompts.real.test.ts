/**
 * Neovim's prompts as a real Neovim asks them of DevHub (`ext_messages` and
 * `ext_cmdline`, as DevHub attaches): what `shell/neovim/prompts.ts` reads
 * of `confirm()`, `:confirm`, the swap file's E325, `inputlist()` and
 * `:s///c`, answered with the keys a click on an answer sends
 * (`nvim_input`) — and that a long message waits for no hit-enter.
 *
 * DevHub's own Neovim (`testNeovim.ts`).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NeovimClient } from "./neovimRpc.js";
import { NeovimUi, type NeovimUiSink } from "./neovimUi.js";
import { makeSocketDir } from "../../model/testScratch.js";
import {
	applyRedraw,
	initialUiState,
	type NeovimUiState,
} from "../../shell/neovim/redraw.js";
import {
	nativePrompt,
	substituteMatch,
	type NativePrompt,
} from "../../shell/neovim/prompts.js";
import { TEST_NVIM } from "./testNeovim.js";

const NVIM = TEST_NVIM;

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

interface Harness {
	readonly ui: NeovimUi;
	readonly state: NeovimUiState;
	readonly dir: string;
	until(check: (state: NeovimUiState) => boolean, what: string): Promise<void>;
	input(keys: string): void;
	eval(expr: string): Promise<unknown>;
}

async function attached(): Promise<Harness> {
	const dir = makeSocketDir("nvim-prompts");
	directories.push(dir);
	const socket = join(dir, "n.sock");
	const child = spawn(
		NVIM as string,
		["--headless", "--clean", "--listen", socket],
		{ stdio: "ignore", cwd: dir },
	);
	children.push(child);
	let client: NeovimClient | undefined;
	for (let attempt = 0; attempt < 200 && !client; attempt += 1) {
		if (existsSync(socket)) {
			try {
				client = await NeovimClient.connect(socket);
			} catch {
				// Not listening yet.
			}
		}
		if (!client) await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!client) throw new Error("nvim did not open its socket");
	const state = initialUiState();
	const waiters: (() => void)[] = [];
	const sink: NeovimUiSink = {
		redraw: (batches) => {
			const changes = applyRedraw(state, batches);
			if (changes.flushed) {
				for (const wake of waiters.splice(0)) wake();
			}
		},
		guiWindows: () => undefined,
		guiOpen: () => undefined,
		guiClose: () => undefined,
		guiSend: () => undefined,
		guiEvent: () => undefined,
	};
	const ui = new NeovimUi(client, {
		read: () => Promise.resolve(""),
		write: () => undefined,
	});
	await ui.attach(sink, 80, 24);
	const h: Harness = {
		ui,
		state,
		dir,
		async until(check, what) {
			const deadline = Date.now() + 5_000;
			while (!check(state)) {
				if (Date.now() > deadline)
					throw new Error(`timed out waiting for ${what}`);
				await new Promise<void>((resolve) => {
					waiters.push(resolve);
					setTimeout(resolve, 50);
				});
			}
		},
		input(keys) {
			ui.call("nvim_input", [keys]);
		},
		eval(expr) {
			return ui.client.request("nvim_eval", [expr]);
		},
	};
	return h;
}

/** The prompt the page would draw now. */
function shown(h: Harness): NativePrompt | undefined {
	return nativePrompt(h.state);
}

async function asked(
	h: Harness,
	kind: NativePrompt["kind"],
): Promise<NativePrompt> {
	await h.until((s) => nativePrompt(s)?.kind === kind, `a ${kind} prompt`);
	return shown(h) as NativePrompt;
}

async function answered(h: Harness): Promise<void> {
	await h.until((s) => nativePrompt(s) === undefined, "the prompt answered");
}

/** The answer a click on the answer labelled `label` sends. */
function keysOf(prompt: NativePrompt, label: string): string {
	const choices = prompt.kind === "list" ? prompt.items : prompt.choices;
	const choice = choices.find((c) => c.label === label);
	if (!choice) throw new Error(`no answer ${label}`);
	return choice.keys;
}

describe.skipIf(NVIM === undefined)("Neovim's prompts, natively", () => {
	it("asks confirm() with two answers and a multi-line question, and takes a click's key", async () => {
		const h = await attached();
		h.input(
			':let g:r = confirm("Delete the file?\\nIt is gone for good.", "&Delete\\n&Cancel", 2)<CR>',
		);
		const prompt = await asked(h, "confirm");
		expect(prompt).toMatchObject({
			kind: "confirm",
			title: "Delete the file?",
			body: ["It is gone for good."],
		});
		if (prompt.kind !== "confirm") throw new Error("not confirm");
		expect(prompt.choices.map((c) => [c.label, c.key, c.isDefault])).toEqual([
			["Delete", "D", false],
			["Cancel", "C", true],
		]);
		h.input(keysOf(prompt, "Delete"));
		await answered(h);
		expect(await h.eval("g:r")).toBe(1);
		h.ui.client.close();
	});

	it("asks confirm() with three answers: Return takes the default, Esc cancels", async () => {
		const h = await attached();
		const ask = ':let g:r = confirm("Save?", "&Yes\\n&No\\n&Cancel", 3)<CR>';
		h.input(ask);
		let prompt = await asked(h, "confirm");
		if (prompt.kind !== "confirm") throw new Error("not confirm");
		expect(prompt.choices.map((c) => c.isDefault)).toEqual([
			false,
			false,
			true,
		]);
		h.input("<CR>");
		await answered(h);
		expect(await h.eval("g:r")).toBe(3);
		h.input(ask);
		prompt = await asked(h, "confirm");
		h.input("<Esc>");
		await answered(h);
		expect(await h.eval("g:r")).toBe(0);
		// The accelerator, typed, is the same answer as the click.
		h.input(ask);
		prompt = await asked(h, "confirm");
		h.input(keysOf(prompt, "No"));
		await answered(h);
		expect(await h.eval("g:r")).toBe(2);
		h.ui.client.close();
	});

	it("asks :confirm's question", async () => {
		const h = await attached();
		h.input(":set modified<CR>:confirm quit<CR>");
		const prompt = await asked(h, "confirm");
		expect(prompt).toMatchObject({ title: 'Save changes to "Untitled"?' });
		h.input(keysOf(prompt, "Cancel"));
		await answered(h);
		expect(await h.eval("&modified")).toBe(1);
		h.ui.client.close();
	});

	it("asks inputlist()'s with its numbered items, a click's number taking it", async () => {
		const h = await attached();
		h.input(':let g:x = inputlist(["Pick one:", "1. alpha", "2. beta"])<CR>');
		let prompt = await asked(h, "list");
		expect(prompt).toMatchObject({
			kind: "list",
			title: "Pick one:",
			typed: "",
		});
		// Typed, then a click on another: the click's number is the answer.
		h.input("1");
		await h.until((s) => {
			const p = nativePrompt(s);
			return p?.kind === "list" && p.typed === "1";
		}, "the number typed");
		prompt = shown(h) as NativePrompt;
		h.input(keysOf(prompt, "beta"));
		await answered(h);
		expect(await h.eval("g:x")).toBe(2);
		h.ui.client.close();
	});

	it("asks :s///c's at each match, the bar under it, through yes, no and last", async () => {
		const h = await attached();
		await h.ui.client.request("nvim_buf_set_lines", [
			0,
			0,
			-1,
			false,
			["x", "foo a", "foo b", "x foo c", "foo d"],
		]);
		h.input(":%s/foo/bar/gc<CR>");
		const prompt = await asked(h, "substitute");
		expect(prompt).toMatchObject({ replacement: "bar" });
		await h.until((s) => substituteMatch(s)?.row === 1, "the first match");
		h.input(keysOf(prompt, "Yes"));
		// Neovim draws the next match, then asks again (two flushes): the
		// bar is held across the one between (PromptViews.tsx).
		await h.until(
			(s) =>
				substituteMatch(s)?.row === 2 && nativePrompt(s)?.kind === "substitute",
			"the second match asked",
		);
		h.input(keysOf(prompt, "No"));
		await h.until(
			(s) =>
				substituteMatch(s)?.col === 2 && nativePrompt(s)?.kind === "substitute",
			"the third match asked",
		);
		// ^E and ^Y are keys still: Neovim scrolls, the question stays.
		h.input("<C-e>");
		await asked(h, "substitute");
		h.input(keysOf(prompt, "Last"));
		await answered(h);
		expect(
			await h.ui.client.request("nvim_buf_get_lines", [0, 0, -1, false]),
		).toEqual(["x", "bar a", "foo b", "x bar c", "foo d"]);
		h.ui.client.close();
	});

	it("asks the swap file's E325, its heading the title, its six answers", async () => {
		const h = await attached();
		const file = join(h.dir, "f.txt");
		writeFileSync(file, "hello\n");
		// A crashed session's swap file, its change preserved.
		spawnSync(
			NVIM as string,
			[
				"--clean",
				"--headless",
				"--cmd",
				"set directory=.",
				"f.txt",
				"-c",
				"normal! ix",
				"-c",
				"preserve",
				"-c",
				"lua os.exit(9)",
			],
			{ cwd: h.dir, stdio: "ignore", timeout: 10_000 },
		);
		expect(existsSync(join(h.dir, ".f.txt.swp"))).toBe(true);
		h.input(":set directory=.<CR>:e f.txt<CR>");
		const prompt = await asked(h, "confirm");
		if (prompt.kind !== "confirm") throw new Error("not confirm");
		expect(prompt.title).toBe("E325: ATTENTION");
		expect(prompt.body.join("\n")).toContain("Found a swap file");
		expect(prompt.choices.map((c) => c.label)).toEqual([
			"Open Read-Only",
			"Edit anyway",
			"Recover",
			"Delete it",
			"Quit",
			"Abort",
		]);
		h.input(keysOf(prompt, "Open Read-Only"));
		await answered(h);
		expect(await h.eval("&readonly")).toBe(1);
		h.ui.client.close();
	});

	it("waits at no hit-enter: a long message is said, and the next key is Normal mode's", async () => {
		const h = await attached();
		h.input(':echo "one\\ntwo\\nthree\\nfour\\nfive"<CR>');
		await h.until(
			(s) =>
				s.messages.some(
					(m) =>
						m.type === "show" &&
						m.msg.content.some((c) => c.text.includes("five")),
				),
			"the message",
		);
		h.input("ix<Esc>");
		const deadline = Date.now() + 5_000;
		while ((await h.eval("getline(1)")) !== "x") {
			if (Date.now() > deadline) throw new Error("the key went elsewhere");
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(shown(h)).toBeUndefined();
		expect(h.state.cmdline).toEqual([]);
		h.ui.client.close();
	});
});
