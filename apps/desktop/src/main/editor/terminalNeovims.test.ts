import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CLIENT_LINE_MARK,
	forwardedKey,
	isTmuxKey,
	overlayRect,
	parseTerminalNeovimReading,
	TerminalNeovims,
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

	it("makes no overlay while the setting is off", async () => {
		const { neovims, ports } = setup(parseTerminalNeovimReading(OUTPUT));
		neovims.setEnabled(false);
		await vi.waitFor(() => {
			expect(ports.read).toHaveBeenCalledWith(expect.anything(), false);
		});
		expect(neovims.views()).toEqual([]);
		neovims.dispose();
	});
});

describe("DevHub's nvim", () => {
	it("is a POSIX sh script that runs the real nvim outside a DevHub pane", () => {
		const directory = mkdtempSync(join(tmpdir(), "nvim-shim-"));
		const shim = join(directory, "shim");
		const real = join(directory, "real");
		execFileSync("mkdir", [shim, real]);
		writeFileSync(
			join(shim, "nvim"),
			neovimShimScript({
				directory: shim,
				tmux: "/bin/false",
				sessionPrefix: "tm-",
			}),
			{ mode: 0o755 },
		);
		writeFileSync(join(real, "nvim"), '#!/bin/sh\necho "real $*"\n', {
			mode: 0o755,
		});
		execFileSync("sh", ["-n", join(shim, "nvim")]);
		const output = execFileSync(join(shim, "nvim"), ["a b", "c"], {
			env: { PATH: `${shim}:${real}:/usr/bin:/bin` },
		}).toString();
		expect(output).toBe("real a b c\n");
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
