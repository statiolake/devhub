/**
 * The carried Neovim setup over a real ssh, to a real host, when one is
 * named: `DEVHUB_CARRY_SSH_HOST=<alias>` (an alias in `~/.ssh/config` with a
 * key; a throwaway account), and the local setup to carry in
 * `DEVHUB_CARRY_MAC_*` (`HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`; this
 * machine's own environment otherwise). Skipped without a host: CI has none.
 * `docs/remote-neovim-config.md`, "Checked", says how it was run.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { makeSocketDir } from "../../model/testScratch.js";
import { TEST_NVIM } from "../editor/testNeovim.js";
import { NeovimConfigSource, type CarryReport } from "./carryHost.js";
import { SshRuntime } from "./ssh.js";
import {
	bundledHostTool,
	toolInstallDirectory,
	type HostTool,
} from "./toolDelivery.js";

const HOST = process.env.DEVHUB_CARRY_SSH_HOST;

describe.skipIf(HOST === undefined || TEST_NVIM === undefined)(
	"your Neovim setup on a real ssh host",
	() => {
		const control = makeSocketDir("devhub-carry-ssh-");
		afterAll(async () => {
			await rm(control, { recursive: true, force: true });
		});

		/** The app's own bundle (`out/host-tools`, `build:binaries`), as DevHub delivers it. */
		function delivery(tool: HostTool) {
			return bundledHostTool(
				tool,
				toolInstallDirectory(".devhub-server", tool),
				fileURLToPath(new URL("../../../out/host-tools", import.meta.url)),
			);
		}

		it(
			"syncs, builds by the spec and reports, through the runtime",
			async () => {
				const reports: CarryReport[] = [];
				const environment = {
					...process.env,
					HOME: process.env.DEVHUB_CARRY_MAC_HOME ?? process.env.HOME,
					XDG_CONFIG_HOME: process.env.DEVHUB_CARRY_MAC_XDG_CONFIG_HOME,
					XDG_DATA_HOME: process.env.DEVHUB_CARRY_MAC_XDG_DATA_HOME,
					XDG_STATE_HOME: await mkdtemp(join(tmpdir(), "devhub-carry-state-")),
				};
				const source = new NeovimConfigSource({
					nvim: () => TEST_NVIM,
					environment: () => environment,
					source: "carrySsh.test",
					report: (report) => reports.push(report),
				});
				const runtime = new SshRuntime({
					host: HOST ?? "",
					controlDirectory: control,
					nvim: delivery("nvim"),
					rg: delivery("rg"),
					fd: delivery("fd"),
					node: delivery("node"),
					neovimConfig: source,
				});
				const program = await runtime.neovimProgram();
				expect(program.kind).toBe("resolved");
				const deadline = Date.now() + 15 * 60_000;
				while (reports.length === 0 && Date.now() < deadline) {
					await new Promise((done) => setTimeout(done, 1000));
				}
				console.log(JSON.stringify(reports, null, 2));
				expect(reports.at(-1)?.text).toContain("Your Neovim config is on");
				runtime.resumed();
			},
			20 * 60_000,
		);
	},
);
