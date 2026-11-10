import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CLIENT_LINE_MARK,
	LeftOption,
	isTmuxKey,
	parseTerminalNeovimReading,
	terminalIdOfPaneUrl,
	TerminalNeovims,
	parseControlPanes,
	type ControlPanes,
	type KeyInput,
	type TerminalNeovimReading,
} from "./terminalNeovims.js";
import { neovimShimZshenv } from "./terminalNeovimShim.js";
import { gridSizeFor } from "../../shell/neovim/gridSize.js";

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

describe("an overlay's grid", () => {
	// The cell sizes a Mac gives Menlo 12 at line height 1.2 and nearby
	// settings: on a Retina screen a cell is a half pixel (16.5), elsewhere
	// whole. The page puts a Neovim on its pane's cells (`placeNeovims`).
	const cells = [
		{ width: 7, height: 16 },
		{ width: 7, height: 16.5 },
		{ width: 7.5, height: 14.5 },
		{ width: 8, height: 17.25 },
	];
	it("is its pane's cells, whatever the pane's size", () => {
		const misses: string[] = [];
		for (const cell of cells) {
			for (let width = 10; width <= 200; width += 1) {
				for (let height = 3; height <= 80; height += 1) {
					const grid = gridSizeFor(
						width * cell.width,
						height * cell.height,
						cell,
					);
					if (grid.cols !== width || grid.rows !== height)
						misses.push(
							`${String(cell.width)}x${String(cell.height)} ${String(width)}x${String(height)}: ${String(grid.cols)}x${String(grid.rows)}`,
						);
				}
			}
		}
		expect(misses.slice(0, 5)).toEqual([]);
	});
});

describe("a terminal page's URL", () => {
	it("names its terminal", () => {
		expect(terminalIdOfPaneUrl("devhub-app://shell/pane.html#ws%3A1")).toBe(
			"ws:1",
		);
		expect(terminalIdOfPaneUrl("devhub-app://shell/pane.html#t-2")).toBe("t-2");
		expect(terminalIdOfPaneUrl("devhub-app://shell/index.html")).toBe(
			undefined,
		);
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

	it("follow the left Option from its own key", () => {
		const optionX = key({ key: "≈", code: "KeyX", alt: true });
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
			selectPane: vi.fn(() => Promise.resolve()),
			enterPrefix: vi.fn(() => Promise.resolve()),
			reach: vi.fn((_terminal: unknown, socket: string) =>
				Promise.resolve(`${socket}.here`),
			),
		};
		const changed = vi.fn();
		const gone = vi.fn();
		const neovims = new TerminalNeovims({
			ports,
			changed,
			gone,
			settleMs: 0,
		});
		neovims.setEnabled(true);
		neovims.setTerminals(
			[{ terminalId: "t", machine: "local" }],
			new Set(["t"]),
		);
		const views = () => neovims.neovims("t").overlays;
		return { neovims, ports, changed, gone, views };
	}

	it("finds a pane's Neovim, attaches it, and gives it the keys", async () => {
		const { neovims, ports, views } = setup(parseTerminalNeovimReading(OUTPUT));
		await vi.waitFor(() => {
			expect(views()).toHaveLength(1);
		});
		const [view] = views();
		// Polled: the page is told the pane's cells in the client's screen.
		expect(view).toEqual({
			key: "tnv:1",
			pane: 1,
			shown: true,
			cells: { x: 41, y: 0, width: 39, height: 23, cols: 80, rows: 24 },
		});
		await expect(neovims.connection("tnv:1")).resolves.toMatchObject({
			socketPath: "/tmp/d/s.here",
		});
		expect(neovims.keyboardOverlay("t")).toBeUndefined();
		neovims.attached("tnv:1");
		expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
		expect(neovims.neovims("t").keys).toBe("tnv:1");
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
		expect(views()).toEqual([]);
		neovims.dispose();
	});

	it("gives the keys back on a DevHub open, and tries a pane whose UI ended again", async () => {
		const { neovims, views } = setup(parseTerminalNeovimReading(OUTPUT));
		await vi.waitFor(() => {
			expect(views()).toHaveLength(1);
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
		expect(views()).toEqual([]);
		// …until an open reaches that Neovim.
		neovims.reclaim("t");
		await vi.waitFor(() => {
			expect(views()).toHaveLength(1);
		});
		neovims.dispose();
	});

	it("keeps the keys in the terminal for a prompt until it is answered", async () => {
		const { neovims, views } = setup(parseTerminalNeovimReading(OUTPUT));
		await vi.waitFor(() => {
			expect(views()).toHaveLength(1);
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
		const { neovims, views } = setup(parseTerminalNeovimReading(OUTPUT));
		await vi.waitFor(() => {
			expect(views()).toHaveLength(1);
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

	it("lets a UI go when its pane stops naming the socket", async () => {
		const reading = parseTerminalNeovimReading(OUTPUT);
		const { neovims, ports, gone, views } = setup(reading);
		await vi.waitFor(() => {
			expect(views()).toHaveLength(1);
		});
		neovims.attached("tnv:1");
		// The pane's `nvim` exited, and took its socket back.
		ports.read.mockImplementation(() =>
			Promise.resolve({
				...reading,
				panes: reading.panes.map((one) => ({ ...one, socket: "" })),
			}),
		);
		await vi.waitFor(() => {
			expect(views()).toEqual([]);
		});
		expect(gone).toHaveBeenCalledWith("tnv:1");
		neovims.dispose();
	});

	it("makes no overlay while the setting is off", async () => {
		const { neovims, ports, views } = setup(parseTerminalNeovimReading(OUTPUT));
		neovims.setEnabled(false);
		await vi.waitFor(() => {
			expect(ports.read).toHaveBeenCalledWith(expect.anything(), false);
		});
		expect(views()).toEqual([]);
		neovims.dispose();
	});
	describe("in tmux control mode", () => {
		const panes = (over: Partial<ControlPanes> = {}): ControlPanes => ({
			client: "client-7",
			prefixes: ["C-b"],
			shown: [
				{ pane: 0, active: false },
				{ pane: 1, active: true },
			],
			panes: [
				{ pane: 0, inMode: false, socket: "" },
				{ pane: 1, inMode: false, socket: "/tmp/d/s" },
				{ pane: 2, inMode: false, socket: "" },
			],
			covered: false,
			...over,
		});

		it("says which pane it is in and whether it is shown, without polling", async () => {
			const { neovims, ports, views } = setup(
				parseTerminalNeovimReading(OUTPUT),
			);
			neovims.controlPanes("t", panes());
			await vi.waitFor(() => {
				expect(views()).toHaveLength(1);
			});
			const reads = ports.read.mock.calls.length;
			// Where it is drawn is the page's: no cells.
			expect(views()).toEqual([{ key: "tnv:1", pane: 1, shown: true }]);
			// A zoom: the pane alone.
			neovims.controlPanes("t", panes({ shown: [{ pane: 1, active: true }] }));
			expect(views()[0]?.shown).toBe(true);
			// Another window shown: hidden, and kept.
			neovims.controlPanes("t", panes({ shown: [{ pane: 2, active: true }] }));
			expect(views()).toHaveLength(1);
			expect(views()[0]?.shown).toBe(false);
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
			expect(views()[0]?.shown).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 200));
			// Only the sockets changing is a reading of tmux: none here.
			expect(ports.read.mock.calls.length).toBe(reads);
			neovims.dispose();
		});

		it("keeps a polled overlay when its page starts speaking for the terminal", async () => {
			const { neovims, views } = setup(parseTerminalNeovimReading(OUTPUT));
			await vi.waitFor(() => {
				expect(views()).toHaveLength(1);
			});
			// The page's first report, before tmux was read again: the same
			// overlay, not a new one (a second page, a second UI on the Neovim).
			neovims.controlPanes("t", panes());
			expect(views().map((view) => view.key)).toEqual(["tnv:1"]);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(views().map((view) => view.key)).toEqual(["tnv:1"]);
			neovims.dispose();
		});

		it("attaches only to a socket tmux confirms", async () => {
			const { neovims, views } = setup({ panes: [], client: undefined });
			neovims.controlPanes("t", panes());
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(views()).toEqual([]);
			neovims.dispose();
		});

		it("hands the prefix to the terminal, and the keys come back", async () => {
			const { neovims, ports, views } = setup(
				parseTerminalNeovimReading(OUTPUT),
			);
			neovims.controlPanes("t", panes());
			await vi.waitFor(() => {
				expect(views()).toHaveLength(1);
			});
			neovims.attached("tnv:1");
			expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
			expect(
				neovims.overlayKey("tnv:1", key({ key: "b", control: true })),
			).toBe("hand");
			expect(ports.enterPrefix).not.toHaveBeenCalled();
			// The terminal is typed the prefix by its page; then the prefix
			// again: send-prefix.
			expect(neovims.keyboardOverlay("t")).toBeUndefined();
			expect(neovims.terminalKey("t", key({ key: "b", control: true }))).toBe(
				"pass",
			);
			await vi.waitFor(() => {
				expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
			});
			// A prompt key is no wait here: the guard or DevHub has it.
			neovims.overlayKey("tnv:1", key({ key: "b", control: true }));
			neovims.terminalKey("t", key({ key: ":" }));
			await vi.waitFor(() => {
				expect(neovims.keyboardOverlay("t")).toBe("tnv:1");
			});
			neovims.dispose();
		});

		it("keeps a covered overlay shown and the keys tmux's", async () => {
			const { neovims, changed, views } = setup(
				parseTerminalNeovimReading(OUTPUT),
			);
			neovims.controlPanes("t", panes());
			await vi.waitFor(() => {
				expect(views()).toHaveLength(1);
			});
			neovims.attached("tnv:1");
			expect(neovims.neovims("t").keys).toBe("tnv:1");
			const before = changed.mock.calls.length;
			// A prompt opened over the panes.
			neovims.controlPanes("t", panes({ covered: true }));
			expect(views()[0]?.shown).toBe(true);
			expect(neovims.neovims("t").keys).toBeUndefined();
			expect(neovims.keyboardOverlay("t")).toBeUndefined();
			expect(neovims.terminalKey("t", key({ key: "x" }))).toBe("pass");
			expect(changed.mock.calls.length).toBeGreaterThan(before);
			// It closed: the keys are the Neovim's again.
			neovims.controlPanes("t", panes());
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
			expect(views()[0]?.shown).toBe(false);
			neovims.dispose();
		});

		it("tries a Neovim again once a control client attaches again", async () => {
			const { neovims, views } = setup(parseTerminalNeovimReading(OUTPUT));
			neovims.controlPanes("t", panes());
			await vi.waitFor(() => {
				expect(views()).toHaveLength(1);
			});
			// The connection to the host dropped: the UI ended, the client went.
			neovims.ended("tnv:1");
			neovims.controlPanes("t", panes({ client: "" }));
			expect(views()).toEqual([]);
			neovims.controlPanes("t", panes({ client: "client-8" }));
			await vi.waitFor(() => {
				expect(views()).toHaveLength(1);
			});
			neovims.dispose();
		});

		it("checks a page's report", () => {
			const wire = panes();
			expect(parseControlPanes(wire)).toEqual(wire);
			expect(
				parseControlPanes({ ...wire, shown: [{ pane: -1, active: true }] }),
			).toBeUndefined();
			expect(
				parseControlPanes({ ...wire, shown: [{ pane: "1" }] }),
			).toBeUndefined();
			expect(
				parseControlPanes({ ...wire, covered: undefined }),
			).toBeUndefined();
		});
	});
});

describe("DevHub's nvim", () => {
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
