/**
 * One `ps` line, read back into its columns, whatever spaces the paths have.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	parseFootprints,
	parseProcessTable,
	parseProcessTables,
	parseProcStatus,
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

const statOutput = readFileSync(
	new URL("./fixtures/ps-stat-darwin.txt", import.meta.url),
	"utf8",
);
const argsOutput = readFileSync(
	new URL("./fixtures/ps-args-darwin.txt", import.meta.url),
	"utf8",
);
const joined = parseProcessTables(statOutput, argsOutput);
const byPid = (pid: number) => joined.find((row) => row.pid === pid)!;

describe("reading the two ps runs", () => {
	it("keeps the executable whole, however many spaces its path has", () => {
		expect(byPid(121)).toMatchObject({
			ppid: 100,
			rssKb: 177000,
			comm: "/Applications/DevHub.app/Contents/Frameworks/DevHub Helper (Plugin).app/Contents/MacOS/DevHub Helper (Plugin)",
			args: "/Applications/DevHub.app/Contents/Frameworks/DevHub Helper (Plugin).app/Contents/MacOS/DevHub Helper (Plugin) --type=utility --utility-sub-type=node.mojom.NodeService",
		});
		expect(byPid(121).exited).toBeUndefined();
	});

	it("names a process whose argv is not its executable", () => {
		// The Claude CLI's executable is a version-numbered file, and its argv
		// is `claude`: one split of the two side by side cannot tell them apart.
		expect(byPid(212).args).toBe("claude");
		expect(processName(byPid(212))).toBe("claude");
		expect(processName(byPid(141))).toBe("tail");
	});

	it("marks a zombie and a process already ending as exited", () => {
		expect(byPid(150).exited).toBe(true);
		expect(byPid(151).exited).toBe(true);
		expect(byPid(152).exited).toBeUndefined();
	});

	it("gives a process the second run missed its executable as its command line", () => {
		const [row] = parseProcessTables("  9 1 10 0.0 S /bin/zsh\n", "");
		expect(row!.args).toBe("/bin/zsh");
	});

	it("reads Linux's one-letter state and short comm", () => {
		const [row] = parseProcessTables(
			"  9   1  10  0.0 S tmux: server\n",
			"  9 tmux -L devhub new-session -d\n",
		);
		expect(row!.comm).toBe("tmux: server");
		expect(row!.exited).toBeUndefined();
	});
});

describe("naming what Node runs", () => {
	it("is the script, or the package a generic script belongs to", () => {
		expect(processName(byPid(124))).toBe("prettier");
		expect(processName(byPid(211))).toBe("@modelcontextprotocol/server-github");
	});

	it("is what a package runner was asked for", () => {
		expect(processName(byPid(213))).toBe("@playwright/mcp@latest");
		expect(processName(byPid(214))).toBe("mcp-server-fetch");
	});

	it("is Electron's helper's own name where it runs no script", () => {
		expect(processName(byPid(125))).toBe("DevHub Helper");
	});
});

describe("reading each process's memory", () => {
	it("is devhub-footprint's footprint and resident set, in RAM no more than the footprint", () => {
		expect(
			parseFootprints(
				"100 524288000 300000000\n121 104857600 734003200\nnonsense\n",
			),
		).toEqual(
			new Map([
				[100, { footprintBytes: 524288000, residentBytes: 300000000 }],
				// A helper's resident set counts the frameworks it shares.
				[121, { footprintBytes: 104857600, residentBytes: 104857600 }],
			]),
		);
	});

	it("is VmRSS + VmSwap and VmRSS on Linux, nothing for a kernel thread", () => {
		const status = readFileSync(
			new URL("./fixtures/proc-status-linux.txt", import.meta.url),
			"utf8",
		);
		expect(parseProcStatus(status)).toEqual({
			footprintBytes: (412340 + 96512) * 1024,
			residentBytes: 412340 * 1024,
		});
		expect(parseProcStatus("Name:\tkthreadd\nState:\tS (sleeping)\n")).toBe(
			undefined,
		);
	});
});
