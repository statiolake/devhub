import { describe, expect, it } from "vitest";
import { KeyRouter, parseBindings, waitingCommand } from "./keyGuard.js";

// As `list-keys` writes them, from the person's tmux.conf and tmux's defaults.
const LINES = [
	'bind-key    -T prefix         ,                         command-prompt -I "#W" { rename-window "%%" }',
	'bind-key    -T prefix         W                         confirm-before -p "kill this session? (y/n)" kill-session',
	'bind-key    -T prefix         m                         display-popup -E -w 80% -h 60% "target=$(fzf)"',
	"bind-key    -T prefix         [                         copy-mode",
	"bind-key    -T prefix         w                         choose-tree -Zw",
	"bind-key    -T prefix         z                         resize-pane -Z",
	"bind-key    -T prefix         C-q                       send-prefix",
	"bind-key    -T prefix         \\;                        last-pane",
	"bind-key -r -T prefix         Up                        select-pane -U",
	"bind-key    -T prefix         g                         switch-client -T goto",
	"bind-key    -T goto           p                         display-panes",
	"bind-key    -T goto           n                         next-window",
	"bind-key    -T root           M-m                       popup -E htop",
	'bind-key    -T copy-mode-vi   y                         send-keys -X copy-pipe "tmux load-buffer -w -"',
];

const router = () => new KeyRouter(parseBindings(LINES), ["C-q"], 500);

describe("the key guard", () => {
	it("reads list-keys, escaped keys and repeats included", () => {
		const bindings = parseBindings(LINES);
		expect(bindings.get("prefix")?.get(";")?.command).toBe("last-pane");
		expect(bindings.get("prefix")?.get("Up")?.repeat).toBe(true);
		expect(bindings.get("copy-mode-vi")?.get("y")?.command).toContain(
			"copy-pipe",
		);
	});

	it("knows the commands that wait on a control client, aliases too", () => {
		expect(waitingCommand('display-popup -E "fzf"')).toBe("display-popup");
		expect(waitingCommand("popup -E htop")).toBe("popup");
		expect(waitingCommand('if -F 1 "confirm-before kill-pane"')).toBe(
			"confirm-before",
		);
		expect(waitingCommand("copy-mode \\; send-keys -X cancel")).toBeUndefined();
		expect(waitingCommand("select-pane -m")).toBeUndefined();
	});

	it("holds the prefix until its key says which binding it is", () => {
		const r = router();
		expect(r.route("C-q", 0)).toEqual({ send: [] });
		expect(r.holdingPrefix).toBe(true);
		expect(r.route("z", 0)).toEqual({ send: ["C-q", "z"] });
		expect(r.route("x", 0)).toEqual({ send: ["x"] });
		// An unbound key after the prefix is tmux's to ignore.
		r.route("C-q", 0);
		expect(r.route("Q", 0)).toEqual({ send: ["C-q", "Q"] });
	});

	it("refuses a binding that would wait, and never sends its prefix", () => {
		const r = router();
		for (const key of ["W", ","]) {
			r.route("C-q", 0);
			const route = r.route(key, 0);
			expect(route.send).toEqual([]);
			expect(route.refused?.keys).toBe(`C-q ${key}`);
			expect(route.resetTable).toBe(false);
		}
		// A popup is DevHub's to run (`popup.ts`): handed over, not sent.
		r.route("C-q", 0);
		const popup = r.route("m", 0);
		expect(popup.send).toEqual([]);
		expect(popup.popup).toMatchObject({ closeOnExit: 1, width: "80%" });
		expect(r.route("M-m", 0).popup).toBeDefined();
		// The prefix's own send-prefix still goes.
		r.route("C-q", 0);
		expect(r.route("C-q", 0)).toEqual({ send: ["C-q", "C-q"] });
	});

	it("follows a repeat and a switch-client -T, and resets a table it refused in", () => {
		const r = router();
		r.route("C-q", 0);
		expect(r.route("Up", 0)).toEqual({ send: ["C-q", "Up"] });
		expect(r.route("Up", 100)).toEqual({ send: ["Up"] });
		// After repeat-time the key is the root table's.
		expect(r.route("Up", 1000)).toEqual({ send: ["Up"] });
		r.route("C-q", 2000);
		expect(r.route("g", 2000)).toEqual({ send: ["C-q", "g"] });
		const route = r.route("p", 2000);
		expect(route.refused?.command).toBe("display-panes");
		expect(route.resetTable).toBe(true);
		r.route("C-q", 3000);
		r.route("g", 3000);
		expect(r.route("n", 3000)).toEqual({ send: ["n"] });
	});
});
