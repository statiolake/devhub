import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CLIENT_LINE_MARK,
	forwardedKey,
	LeftOption,
	isTmuxKey,
	overlayRect,
	parseTerminalNeovimReading,
	TerminalNeovims,
	parseControlPanes,
	type ControlPanes,
	type KeyInput,
	type TerminalNeovimReading,
} from "./terminalNeovims.js";
import { neovimShimScript, neovimShimZshenv } from "./terminalNeovimShim.js";

const pane = (fields: string) => fields.split(" ").join("\t");
const OUTPUT = [
	pane("%0 1 0 0 0 0 40 23 0 "),
	pane("%1 1 1 0 41 0 39 23 0 /tmp/d/s"),
	pane("%2 0 1 0 0 0 80 23 0 "),
	`${CLIENT_LINE_MARK}${pane("/dev/pts/2 80 24 root on bottom C-b None")}`,
	"",
].join("\n");

function key(partial: Partial<KeyInput>): KeyInput {
	return {
		type: "keyDown",
		key: "",
		control: false,
		alt: false,
		shift: false,
		meta: false,
		...partial,
	};
}

describe("a terminal's reading", () => {
	it("is read pane by pane, then DevHub's client", () => {
		const reading = parseTerminalNeovimReading(OUTPUT);
		expect(reading.panes.map((one) => one.paneId)).toEqual(["%0", "%1", "%2"]);
		expect(reading.panes[1]).toMatchObject({
			paneActive: true,
			left: 41,
			width: 39,
			socket: "/tmp/d/s",
		});
		expect(reading.client).toEqual({
			name: "/dev/pts/2",
			width: 80,
			height: 24,
			keyTable: "root",
			statusTop: 0,
			prefixes: ["C-b"],
		});
	});

	it("counts a status line on top", () => {
		const reading = parseTerminalNeovimReading(
			`${CLIENT_LINE_MARK}${pane("c 80 24 root 2 top C-a C-b")}`,
		);
		expect(reading.client?.statusTop).toBe(2);
		expect(reading.client?.prefixes).toEqual(["C-a", "C-b"]);
	});
});

describe("where an overlay goes", () => {
	const reading = parseTerminalNeovimReading(OUTPUT);
	const client = reading.client!;
	it("is the pane's cells, from the emulator's screen", () => {
		// 80 cells over 640 px, 24 rows over 480 px: 8 × 20.
		expect(
			overlayRect(reading.panes[1]!, client, {
				x: 4,
				y: 4,
				width: 640,
				height: 480,
				zoom: 1,
			}),
		).toEqual({ x: 4 + 41 * 8, y: 4, width: 39 * 8, height: 23 * 20 });
	});

	it("is pushed down by a status line on top, and scaled by the page's zoom", () => {
		expect(
			overlayRect(
				reading.panes[0]!,
				{ ...client, statusTop: 1 },
				{ x: 0, y: 0, width: 640, height: 480, zoom: 1.5 },
			),
		).toEqual({ x: 0, y: 30, width: 480, height: 690 });
	});
});

describe("tmux key names", () => {
	it("match the keys Electron reports", () => {
		expect(isTmuxKey("C-b", key({ key: "b", control: true }))).toBe(true);
		expect(
			isTmuxKey("C-b", key({ key: "B", control: true, shift: true })),
		).toBe(true);
		expect(isTmuxKey("C-b", key({ key: "b" }))).toBe(false);
		expect(isTmuxKey("C-b", key({ key: "b", control: true, meta: true }))).toBe(
			false,
		);
		expect(isTmuxKey("C-Space", key({ key: " ", control: true }))).toBe(true);
		expect(isTmuxKey("M-a", key({ key: "a", alt: true }))).toBe(true);
		expect(isTmuxKey("`", key({ key: "`" }))).toBe(true);
		expect(isTmuxKey("F12", key({ key: "F12" }))).toBe(true);
	});

	it("are forwarded as Electron input events", () => {
		expect(forwardedKey(key({ key: "i" })).map((one) => one.type)).toEqual([
			"keyDown",
			"char",
			"keyUp",
		]);
		expect(forwardedKey(key({ key: "ArrowUp" }))[0]).toMatchObject({
			keyCode: "Up",
		});
		expect(forwardedKey(key({ key: "Unidentified" }))).toEqual([]);
	});

	it("forward an Option chord by its physical key, and the left Option first", () => {
		// Option+X on a Mac: `key` is what Option made of it.
		const optionX = key({ key: "≈", code: "KeyX", alt: true });
		expect(forwardedKey(optionX, true)).toEqual([
			{ type: "keyDown", keyCode: "Alt", modifiers: ["alt", "left"] },
			{ type: "keyDown", keyCode: "x", modifiers: ["alt"] },
			{ type: "keyUp", keyCode: "x", modifiers: ["alt"] },
		]);
		// The right Option: no Alt said, so the overlay does not read Meta.
		expect(forwardedKey(optionX, false).map((one) => one.keyCode)).toEqual([
			"x",
			"x",
		]);
		const held = new LeftOption();
		expect(
			held.note(
				key({ type: "keyDown", key: "Alt", code: "AltLeft", alt: true }),
			),
		).toBe(true);
		expect(held.note(optionX)).toBe(true);
		expect(held.note(key({ type: "keyUp", key: "Alt", code: "AltLeft" }))).toBe(
			false,
		);
	});
});

describe("TerminalNeovims", () => {
	function setup(reading: TerminalNeovimReading) {
		const ports = {
			read: vi.fn(() => Promise.resolve(reading)),
			claim: vi.fn(() => Promise.resolve()),
			selectPane: vi.fn(() => Promise.resolve()),
			enterPrefix: vi.fn(() => Promise.resolve()),
			reach: vi.fn((_terminal: unknown, socket: string) =>
				Promise.resolve(`${socket}.here`),
			),
		};
		const changed = vi.fn();
		const neovims = new TerminalNeovims({ ports, changed, settleMs: 0 });
		neovims.setEnabled(true);
		neovims.screen("t", { x: 0, y: 0, width: 640, height: 480, zoom: 1 });
		neovims.setTerminals(
			[{ terminalId: "t", machine: "local" }],
			new Set(["t"]),
		);
		return { neovims, ports, changed };
	}

	it("finds a pane's Neovim, attaches it, and gives it the keys", async () => {
		const { neovims, ports } = setup(parseTerminalNeovimReading(OUTPUT));
		await vi.waitFor(() => {
			expect(neovims.views()).toHaveLength(1);
		});
		const [view] = neovims.views();
		expect(view).toMatchObject({ terminalId: "t", key: "tnv:1" });
		expect(view?.rect).toEqual({ x: 328, y: 0, width: 312, height: 460 });
		await expect(neovims.connection("tnv:1")).resolves.toMatchObject({
			socketPath: "/tmp/d/s.here",
		});
		expect(neovims.keyboardOverlay("t")).toBeUndefined();
		neovims.attached("tnv:1");
		expect(ports.claim).toHaveBeenCalledWith(
			{ terminalId: "t", machine: "local" },
			"%1",
		);
		expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
		// The prefix is tmux's; the key after it too; then the keys come back.
		expect(neovims.overlayKey("tnv:1", key({ key: "b", control: true }))).toBe(
			"prefix",
		);
		expect(ports.enterPrefix).toHaveBeenCalled();
		expect(neovims.keyboardOverlay("t")).toBeUndefined();
		expect(neovims.terminalKey("t", key({ key: "z" }))).toBe("pass");
		await vi.waitFor(() => {
			expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
		});
		// A click beside it lends the keys; a key tmux would give the pane
		// under the overlay takes them back.
		neovims.terminalFocused("t");
		expect(neovims.keyboardOverlay("t")).toBeUndefined();
		expect(neovims.terminalKey("t", key({ key: "i" }))).toBe("redirect");
		expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
		neovims.ended("tnv:1");
		expect(neovims.views()).toEqual([]);
		neovims.dispose();
	});

	it("gives the keys back on a DevHub open, and tries a pane whose UI ended again", async () => {
		const { neovims } = setup(parseTerminalNeovimReading(OUTPUT));
		await vi.waitFor(() => {
			expect(neovims.views()).toHaveLength(1);
		});
		neovims.attached("tnv:1");
		expect(neovims.shownOverlay("t")).toBe("tnv:1");
		neovims.terminalFocused("t");
		expect(neovims.keyboardOverlay("t")).toBeUndefined();
		neovims.reclaim("t");
		expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
		// Its UI ended (the connection to a host dropped) with the pane
		// still naming the socket: not drawn again by itself…
		neovims.ended("tnv:1");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(neovims.views()).toEqual([]);
		// …until an open reaches that Neovim.
		neovims.reclaim("t");
		await vi.waitFor(() => {
			expect(neovims.views()).toHaveLength(1);
		});
		neovims.dispose();
	});

	it("keeps the keys in the terminal for a prompt until it is answered", async () => {
		const { neovims } = setup(parseTerminalNeovimReading(OUTPUT));
		await vi.waitFor(() => {
			expect(neovims.views()).toHaveLength(1);
		});
		neovims.attached("tnv:1");
		neovims.overlayKey("tnv:1", key({ key: "b", control: true }));
		neovims.terminalKey("t", key({ key: ":" }));
		expect(neovims.terminalKey("t", key({ key: "x" }))).toBe("pass");
		expect(neovims.keyboardOverlay("t")).toBeUndefined();
		neovims.terminalKey("t", key({ key: "Enter" }));
		await vi.waitFor(() => {
			expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
		});
		neovims.dispose();
	});

	it("gives the keys back after the prefix twice (send-prefix)", async () => {
		const { neovims } = setup(parseTerminalNeovimReading(OUTPUT));
		await vi.waitFor(() => {
			expect(neovims.views()).toHaveLength(1);
		});
		neovims.attached("tnv:1");
		neovims.overlayKey("tnv:1", key({ key: "b", control: true }));
		expect(neovims.terminalKey("t", key({ key: "b", control: true }))).toBe(
			"pass",
		);
		await vi.waitFor(() => {
			expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
		});
		neovims.dispose();
	});

	it("makes no overlay while the setting is off", async () => {
		const { neovims, ports } = setup(parseTerminalNeovimReading(OUTPUT));
		neovims.setEnabled(false);
		await vi.waitFor(() => {
			expect(ports.read).toHaveBeenCalledWith(expect.anything(), false);
		});
		expect(neovims.views()).toEqual([]);
		neovims.dispose();
	});
	describe("in tmux control mode", () => {
		const panes = (over: Partial<ControlPanes> = {}): ControlPanes => ({
			x: 4,
			y: 2,
			cellWidth: 8,
			cellHeight: 20,
			cols: 80,
			rows: 24,
			zoom: 1,
			client: "client-7",
			prefixes: ["C-b"],
			shown: [
				{ pane: 0, x: 0, y: 0, width: 40, height: 24, active: false },
				{ pane: 1, x: 41, y: 0, width: 39, height: 24, active: true },
			],
			panes: [
				{ pane: 0, inMode: false, socket: "" },
				{ pane: 1, inMode: false, socket: "/tmp/d/s" },
				{ pane: 2, inMode: false, socket: "" },
			],
			covered: false,
			...over,
		});

		it("places the overlay on the page's pane rectangle, without polling", async () => {
			const { neovims, ports } = setup(parseTerminalNeovimReading(OUTPUT));
			neovims.controlPanes("t", panes());
			await vi.waitFor(() => {
				expect(neovims.views()).toHaveLength(1);
			});
			const reads = ports.read.mock.calls.length;
			expect(neovims.views()[0]?.rect).toEqual({
				x: 4 + 41 * 8,
				y: 2,
				width: 39 * 8,
				height: 24 * 20,
			});
			// A zoom: the pane alone, at once.
			neovims.controlPanes(
				"t",
				panes({
					shown: [{ pane: 1, x: 0, y: 0, width: 80, height: 24, active: true }],
				}),
			);
			expect(neovims.views()[0]?.rect).toEqual({
				x: 4,
				y: 2,
				width: 640,
				height: 480,
			});
			// Another window shown: hidden, and kept.
			neovims.controlPanes(
				"t",
				panes({
					shown: [{ pane: 2, x: 0, y: 0, width: 80, height: 24, active: true }],
				}),
			);
			expect(neovims.views()).toHaveLength(1);
			expect(neovims.views()[0]?.rect).toBeUndefined();
			// In copy mode: hidden.
			neovims.controlPanes(
				"t",
				panes({
					panes: [
						{ pane: 0, inMode: false, socket: "" },
						{ pane: 1, inMode: true, socket: "/tmp/d/s" },
						{ pane: 2, inMode: false, socket: "" },
					],
				}),
			);
			expect(neovims.views()[0]?.rect).toBeUndefined();
			await new Promise((resolve) => setTimeout(resolve, 200));
			// Only the sockets changing is a reading of tmux: none here.
			expect(ports.read.mock.calls.length).toBe(reads);
			neovims.dispose();
		});

		it("attaches only to a socket tmux confirms", async () => {
			const { neovims } = setup({ panes: [], client: undefined });
			neovims.controlPanes("t", panes());
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(neovims.views()).toEqual([]);
			neovims.dispose();
		});

		it("hands the prefix to the terminal's page, and the keys come back", async () => {
			const { neovims, ports } = setup(parseTerminalNeovimReading(OUTPUT));
			neovims.controlPanes("t", panes());
			await vi.waitFor(() => {
				expect(neovims.views()).toHaveLength(1);
			});
			neovims.attached("tnv:1");
			expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
			expect(
				neovims.overlayKey("tnv:1", key({ key: "b", control: true })),
			).toBe("hand");
			expect(ports.enterPrefix).not.toHaveBeenCalled();
			// The handed prefix arriving, then the prefix again: send-prefix.
			expect(neovims.terminalKey("t", key({ key: "b", control: true }))).toBe(
				"pass",
			);
			expect(neovims.keyboardOverlay("t")).toBeUndefined();
			expect(neovims.terminalKey("t", key({ key: "b", control: true }))).toBe(
				"pass",
			);
			await vi.waitFor(() => {
				expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
			});
			// A prompt key is no wait here: the guard or DevHub has it.
			neovims.overlayKey("tnv:1", key({ key: "b", control: true }));
			neovims.terminalKey("t", key({ key: "b", control: true }));
			neovims.terminalKey("t", key({ key: ":" }));
			await vi.waitFor(() => {
				expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
			});
			neovims.dispose();
		});

		it("keeps a covered overlay shown, the page above it and the keys tmux's", async () => {
			const { neovims, changed } = setup(parseTerminalNeovimReading(OUTPUT));
			neovims.controlPanes("t", panes());
			await vi.waitFor(() => {
				expect(neovims.views()).toHaveLength(1);
			});
			neovims.attached("tnv:1");
			expect(neovims.overlaid("t")).toEqual({ panes: [1], raised: false });
			const before = changed.mock.calls.length;
			// A prompt opened over the panes.
			neovims.controlPanes("t", panes({ covered: true }));
			expect(neovims.views()[0]?.rect).toBeDefined();
			expect(neovims.overlaid("t")).toEqual({ panes: [1], raised: true });
			expect(neovims.keyboardOverlay("t")).toBeUndefined();
			expect(neovims.terminalKey("t", key({ key: "x" }))).toBe("pass");
			expect(changed.mock.calls.length).toBeGreaterThan(before);
			// It closed: under the Neovim again, and the keys are its.
			neovims.controlPanes("t", panes());
			expect(neovims.overlaid("t")).toEqual({ panes: [1], raised: false });
			expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
			// Copy mode in that pane: tmux's view of it, the overlay hidden.
			neovims.controlPanes(
				"t",
				panes({
					covered: true,
					panes: [
						{ pane: 0, inMode: false, socket: "" },
						{ pane: 1, inMode: true, socket: "/tmp/d/s" },
						{ pane: 2, inMode: false, socket: "" },
					],
				}),
			);
			expect(neovims.overlaid("t")).toEqual({ panes: [], raised: false });
			neovims.dispose();
		});

		it("tries a Neovim again once a control client attaches again", async () => {
			const { neovims } = setup(parseTerminalNeovimReading(OUTPUT));
			neovims.controlPanes("t", panes());
			await vi.waitFor(() => {
				expect(neovims.views()).toHaveLength(1);
			});
			// The connection to the host dropped: the UI ended, the client went.
			neovims.ended("tnv:1");
			neovims.controlPanes("t", panes({ client: "" }));
			expect(neovims.views()).toEqual([]);
			neovims.controlPanes("t", panes({ client: "client-8" }));
			await vi.waitFor(() => {
				expect(neovims.views()).toHaveLength(1);
			});
			neovims.dispose();
		});

		it("checks a page's report", () => {
			const wire = { ...panes(), zoom: undefined };
			expect(parseControlPanes(wire, 2)?.zoom).toBe(2);
			expect(parseControlPanes({ ...wire, cols: -1 }, 1)).toBeUndefined();
			expect(
				parseControlPanes({ ...wire, shown: [{ pane: "1" }] }, 1),
			).toBeUndefined();
			expect(
				parseControlPanes({ ...wire, covered: undefined }, 1),
			).toBeUndefined();
		});
	});
});

describe("DevHub's nvim", () => {
	it("is a POSIX sh script that runs DevHub's Neovim, never the PATH's, outside a DevHub pane", () => {
		const directory = mkdtempSync(join(tmpdir(), "nvim-shim-"));
		const shim = join(directory, "shim");
		const path = join(directory, "path");
		const devhub = join(directory, "devhub", "bin");
		execFileSync("mkdir", ["-p", shim, path, devhub]);
		writeFileSync(
			join(shim, "nvim"),
			neovimShimScript({
				nvim: join(devhub, "nvim"),
				tmux: "/bin/false",
				sessionPrefixes: ["tm-", "ws-"],
			}),
			{ mode: 0o755 },
		);
		writeFileSync(
			join(devhub, "nvim"),
			'#!/bin/sh\necho "devhub $* runtime=${VIMRUNTIME-unset}"\n',
			{ mode: 0o755 },
		);
		writeFileSync(join(path, "nvim"), '#!/bin/sh\necho "path $*"\n', {
			mode: 0o755,
		});
		execFileSync("sh", ["-n", join(shim, "nvim")]);
		const output = execFileSync(join(shim, "nvim"), ["a b", "c"], {
			env: {
				PATH: `${shim}:${path}:/usr/bin:/bin`,
				VIMRUNTIME: "/opt/homebrew/share/nvim/runtime",
			},
		}).toString();
		// The runtime is found beside it, not the one another Neovim set.
		expect(output).toBe("devhub a b c runtime=unset\n");
	});

	it.runIf(existsSync("/bin/zsh") || existsSync("/usr/bin/zsh"))(
		"stays first on a zsh's PATH whatever the person's startup files do",
		() => {
			const directory = mkdtempSync(join(tmpdir(), "nvim-zsh-"));
			const home = join(directory, "home");
			const zsh = join(directory, "shim", "zsh");
			execFileSync("mkdir", ["-p", home, zsh]);
			writeFileSync(join(zsh, ".zshenv"), neovimShimZshenv());
			writeFileSync(
				join(home, ".zshenv"),
				"export PATH=/brew/bin:$PATH; export MARK=env\n",
			);
			writeFileSync(join(home, ".zshrc"), "export RC=rc\n");
			const output = execFileSync("zsh", ["-i"], {
				input: 'print -r -- "<$path[1]|$MARK|$RC|${ZDOTDIR-none}>"\n',
				env: {
					HOME: home,
					ZDOTDIR: zsh,
					DEVHUB_NVIM_SHIM: "/shim",
					PATH: "/shim:/usr/bin:/bin",
				},
			}).toString();
			expect(output).toContain("</shim|env|rc|none>");
		},
	);
});
