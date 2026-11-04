/**
 * Which processes a workbench's freeze stops: its renderer, its window's
 * utility processes and their trees — never what is shared, never what runs
 * in its terminals, never tmux.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { freezeTargets } from "./freezeTargets.js";
import { parseProcessTable } from "./processTable.js";

// 100 main, 101 GPU, 102 network, 110/111 DevHub's pages, 120 the
// workbench's renderer, 121 its extension host (122 rust-analyzer, 123 its
// proc-macro server, 124 tsserver), 130 the shared pty host with 131 a tmux
// client (a DevHub terminal tab), 140 git under main, 200… tmux's server.
const processes = parseProcessTable(
	readFileSync(new URL("./fixtures/ps-darwin.txt", import.meta.url), "utf8"),
);
// tsserver (124) runs on Electron's binary but is the extension host's child,
// not one of Electron's own processes.
const electron = [100, 101, 102, 110, 111, 120, 121, 130];

describe("a workbench's freeze targets", () => {
	it("are its renderer, then its extension host with everything under it", () => {
		expect(
			freezeTargets({
				processes,
				renderer: 120,
				windowUtilities: [121],
				electron,
			}),
		).toEqual([120, 121, 122, 123, 124]);
	});

	it("never include the shared processes, the pty host, its terminals or main", () => {
		const targets = freezeTargets({
			processes,
			renderer: 120,
			windowUtilities: [121],
			electron,
		});
		for (const shared of [100, 101, 102, 110, 111, 130, 131, 140, 200, 201]) {
			expect(targets).not.toContain(shared);
		}
	});

	it("leave out a tmux an extension started, and what runs in it", () => {
		const withTmux = parseProcessTable(
			[
				"  120   100 1 0.0 /x/Renderer /x/Renderer --type=renderer",
				"  121   100 1 0.0 /x/Plugin /x/Plugin --type=utility",
				"  125   121 1 0.0 /opt/homebrew/bin/tmux tmux -L other new-session -d",
				"  126   125 1 0.0 /bin/zsh -zsh",
				"  127   121 1 0.0 /usr/bin/node node server.js",
				"  128   100 1 0.0 /x/Helper /x/Helper --type=utility",
			].join("\n"),
		);
		expect(
			freezeTargets({
				processes: withTmux,
				renderer: 120,
				windowUtilities: [121, 128],
				electron: [100, 120, 121, 128],
			}),
		).toEqual([120, 121, 127, 128]);
	});

	it("do not walk into another Electron process under a utility", () => {
		const nested = parseProcessTable(
			[
				"  121   100 1 0.0 /x/Plugin /x/Plugin",
				"  129   121 1 0.0 /x/Other /x/Other",
			].join("\n"),
		);
		expect(
			freezeTargets({
				processes: nested,
				renderer: undefined,
				windowUtilities: [121],
				electron: [100, 121, 129],
			}),
		).toEqual([121]);
	});

	it("never start from pid 0, the root of every process", () => {
		// `getOSProcessId()` is 0 for contents with no process up; on macOS
		// `ps` lists `kernel_task` as 0, the parent of launchd.
		const rooted = parseProcessTable(
			[
				"    0     0 1 0.0 kernel_task kernel_task",
				"    1     0 1 0.0 /sbin/launchd /sbin/launchd",
				"  121     1 1 0.0 /x/Plugin /x/Plugin",
			].join("\n"),
		);
		expect(
			freezeTargets({
				processes: rooted,
				renderer: 0,
				windowUtilities: [121],
				electron: [121],
			}),
		).toEqual([121]);
	});

	it("are nothing for a workbench whose processes are gone", () => {
		expect(
			freezeTargets({
				processes,
				renderer: 9999,
				windowUtilities: [],
				electron,
			}),
		).toEqual([]);
	});
});
