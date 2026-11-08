import { describe, expect, it } from "vitest";
import { keyBytes, popupInput } from "./popup.js";
import {
	parseCommands,
	popupOf,
	popupPosition,
	popupSize,
	printfEscaped,
} from "./tmuxCommand.js";

// The person's `bind m`, as `list-keys` writes it.
const BIND_M =
	'display-popup -E -w 80% -h 60% "  target_window=\\$(tmux list-windows -F \\"#{window_index}: #{window_name}\\" |     fzf --prompt=\\"Move pane to window: \\" |     cut -d: -f1);   if [ -n \\"\\$target_window\\" ]; then     tmux move-pane -t \\":\\$target_window\\";   fi "';

describe("tmux's command syntax", () => {
	it("splits commands and words as tmux does", () => {
		expect(parseCommands("copy-mode \\; send-keys -X clear-selection")).toEqual(
			[["copy-mode"], ["send-keys", "-X", "clear-selection"]],
		);
		expect(parseCommands('a \'b c\' "d\\"e" {f ; g}')).toEqual([
			["a", "b c", 'd"e', "f ; g"],
		]);
	});

	it("reads the person's popup binding", () => {
		const popup = popupOf(BIND_M);
		expect(popup).toMatchObject({
			closeOnExit: 1,
			width: "80%",
			height: "60%",
		});
		expect(popup?.command).toContain(
			'tmux list-windows -F "#{window_index}: #{window_name}"',
		);
		expect(popup?.command).toContain('tmux move-pane -t ":$target_window"');
		expect(popupOf("display-popup -EE")?.closeOnExit).toBe(2);
		expect(popupOf("display-popup -C")).toBeUndefined();
		expect(popupOf("display-popup ls \\; kill-pane")).toBeUndefined();
		expect(popupOf("split-window")).toBeUndefined();
	});

	it("places a popup as tmux does", () => {
		expect(popupSize("80%", 200, 100)).toBe(160);
		expect(popupSize(undefined, 200, 100)).toBe(100);
		expect(popupSize("300", 200, 100)).toBe(200);
		expect(popupPosition(undefined, 200, 160)).toBe(20);
		expect(popupPosition("5", 200, 160)).toBe(5);
		// -y is the last line.
		expect(popupPosition("30", 60, 10, true)).toBe(21);
	});

	it("passes a command on one line", () => {
		expect(printfEscaped("a\nb")).toBe("\\141\\012\\142");
		const lines = new TextDecoder().decode(
			popupInput({
				directory: "/d",
				tmux: "/s,1,2",
				pane: "%0",
				shell: "/bin/sh",
				command: "ls",
				path: "/p",
			}),
		);
		expect(lines).toBe("/d\n/s,1,2\n%0\n/bin/sh\n\\154\\163\n/p\n");
	});

	it("types tmux's key names as a terminal sends them", () => {
		expect(keyBytes("a")).toBe("a");
		expect(keyBytes("C-c")).toBe("\u0003");
		expect(keyBytes("M-f")).toBe("\u001bf");
		expect(keyBytes("Enter")).toBe("\r");
		expect(keyBytes("Up")).toBe("\u001b[A");
		expect(keyBytes("BSpace")).toBe("\u007f");
		expect(keyBytes("C-Space")).toBe("\u0000");
	});
});
