/**
 * Which managed Neovims a machine gets, and what terminal mode says about a
 * host's: this Mac's are phase 1's own, a host's are terraformed first, and
 * the host's condition is its terraform's notices, its failure, and the
 * `devhub` command's server install — said together, and taken down when
 * there is nothing left to say.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedNeovims } from "../editor/managedNeovim.js";
import type { NeovimDelivery } from "../editor/neovimDelivery.js";
import type { Runtime, RuntimeId } from "../runtime/runtime.js";
import type { TmuxTerminalRuntime } from "../terminal/tmux.js";
import { makeScratchDir } from "../../model/testScratch.js";
import { NeovimMachines } from "./neovimMachines.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/** A host played by this machine's `sh` under a scratch home, with an `nvim` of its own. */
function host(): Runtime {
	const home = makeScratchDir("machines-home");
	directories.push(home);
	return {
		exec: (request: { argv: readonly string[]; stdin?: Uint8Array }) => {
			const [file, ...args] = request.argv;
			const result = spawnSync(file as string, args, {
				env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
				input: request.stdin === undefined ? "" : Buffer.from(request.stdin),
			});
			let stdout = result.stdout;
			if (args[1]?.startsWith("printf 'home=")) {
				// A musl host with a usable Neovim of its own: the fallback path,
				// which needs no bundle.
				stdout = Buffer.from(
					`${stdout.toString("utf8")}libc=musl\nhostnvim=/usr/bin/nvim\nhostnvimversion=NVIM v0.11.0\n`,
				);
			}
			return Promise.resolve({
				code: result.status,
				signal: null,
				stdout,
				stderr: result.stderr,
			});
		},
	} as unknown as Runtime;
}

const NO_BUNDLE: NeovimDelivery = {
	statement: () => Promise.resolve("this DevHub carries no Neovim for Linux"),
	tarball: () => Promise.reject(new Error("none")),
};

function machines(options: {
	readonly installServerFiles?: () => Promise<void>;
	readonly adapter?: () => Promise<TmuxTerminalRuntime>;
}) {
	const conditions: { machine: RuntimeId; summary: string | undefined }[] = [];
	const local = new ManagedNeovims({
		panes: {
			open: () => Promise.reject(new Error("not here")),
			state: () => Promise.resolve("gone"),
			activate: () => Promise.resolve(),
			kill: () => Promise.resolve(),
		},
		nvim: () => Promise.resolve("nvim"),
		socketDirectory: "/tmp",
	});
	const runtime = host();
	const neovims = new NeovimMachines({
		local,
		runtime: () => runtime,
		adapter:
			options.adapter ??
			(() => Promise.resolve({} as unknown as TmuxTerminalRuntime)),
		delivery: NO_BUNDLE,
		serverDataFolderName: ".devhub-server",
		controlSocketPath: "/Users/me/devhub/control.sock",
		localEnvironment: () => ({ XDG_CONFIG_HOME: "/nonexistent" }),
		localHome: "/nonexistent",
		condition: (machine, summary) => {
			conditions.push({ machine, summary });
		},
		installServerFiles: options.installServerFiles ?? (() => Promise.resolve()),
	});
	return { neovims, local, conditions };
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("the managed Neovims of each machine", () => {
	it("are phase 1's own on this Mac, and one set per host", () => {
		const { neovims, local } = machines({});
		expect(neovims.on("local")).toBe(local);
		const host = neovims.on("ssh:build-box" as RuntimeId);
		expect(host).not.toBe(local);
		expect(neovims.on("ssh:build-box" as RuntimeId)).toBe(host);
	});

	it("say a host's fallback as its condition", async () => {
		const { neovims, conditions } = machines({});
		neovims.warm("ssh:build-box" as RuntimeId);
		await settle();
		expect(conditions.at(-1)).toEqual({
			machine: "ssh:build-box",
			summary: expect.stringMatching(
				/^Build-box runs musl .* Terminal mode uses build-box's own \/usr\/bin\/nvim instead, with your configuration\.$/u,
			) as unknown,
		});
	});

	it("add the devhub command's install failing, and take it back down when it is the only thing", async () => {
		let fail = true;
		const { neovims, conditions } = machines({
			installServerFiles: () =>
				fail
					? Promise.reject(new Error("no server for armv7l"))
					: Promise.resolve(),
		});
		neovims.warm("ssh:build-box" as RuntimeId);
		await settle();
		expect(conditions.at(-1)?.summary).toMatch(
			/ The devhub command on build-box cannot run, .*: no server for armv7l$/u,
		);
		fail = false;
		neovims.warm("ssh:build-box" as RuntimeId);
		await settle();
		expect(conditions.at(-1)?.summary).not.toMatch(/devhub command/u);
	});

	it("say a host without tmux as its condition's cause, not a Neovim one", async () => {
		const { neovims, conditions } = machines({
			adapter: () => Promise.reject(new Error("there is no tmux on ssh:nas")),
		});
		neovims.warm("ssh:nas" as RuntimeId);
		await settle();
		// The tmux failure is the machine's own condition elsewhere; nothing
		// about Neovim is raised before there are panes to put one in.
		expect(conditions).toEqual([]);
	});
});
