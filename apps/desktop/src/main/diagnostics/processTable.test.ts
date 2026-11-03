/**
 * One `ps` line, read back into its columns, whatever spaces the paths have.
 */

import { describe, expect, it } from "vitest";
import {
	parseProcessTable,
	processName,
	splitCommand,
} from "./processTable.js";

describe("reading ps", () => {
	it("reads the numbers and keeps a path with spaces whole", () => {
		const [row] = parseProcessTable(
			"  122   121 1900000  48.5 /Users/me/Library/Application Support/x/rust-analyzer /Users/me/Library/Application Support/x/rust-analyzer --stdio\n",
		);
		expect(row).toEqual({
			pid: 122,
			ppid: 121,
			rssKb: 1900000,
			cpuPercent: 48.5,
			comm: "/Users/me/Library/Application Support/x/rust-analyzer",
			args: "/Users/me/Library/Application Support/x/rust-analyzer --stdio",
		});
	});

	it("reads a decimal comma, and skips what is not a row", () => {
		const rows = parseProcessTable(
			"garbage\n   7     1   100   2,5 /bin/sh sh\n\n",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.cpuPercent).toBe(2.5);
	});

	it("splits Linux's short comm from a command line that names a path", () => {
		expect(splitCommand("node            /usr/bin/node /srv/x.js")).toEqual({
			comm: "node",
			args: "/usr/bin/node /srv/x.js",
		});
	});

	it("splits a login shell, whose argv[0] is not its executable", () => {
		expect(splitCommand("/bin/zsh -zsh")).toEqual({
			comm: "/bin/zsh",
			args: "-zsh",
		});
	});
});

describe("naming a process", () => {
	it("is the executable's name", () => {
		expect(processName({ comm: "/opt/homebrew/bin/nvim", args: "nvim" })).toBe(
			"nvim",
		);
		expect(processName({ comm: "-zsh", args: "-zsh" })).toBe("zsh");
	});

	it("is the script an interpreter or a Node helper runs", () => {
		expect(
			processName({
				comm: "/A/DevHub Helper (Plugin)",
				args: "/A/DevHub Helper (Plugin) --max-old-space-size=3072 /A/b/tsserver.js --serverMode x",
			}),
		).toBe("tsserver.js");
		expect(
			processName({
				comm: "/usr/local/bin/node",
				args: "/usr/local/bin/node --inspect /usr/local/bin/claude --resume",
			}),
		).toBe("claude");
		expect(
			processName({ comm: "python3.12", args: "python3.12 -m http.server" }),
		).toBe("http.server");
	});
});
