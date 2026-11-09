/**
 * The one switch, and the fact that it is the only one.
 */

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeSocketDir } from "../../model/testScratch.js";
import { workspaceLocation } from "../../model/domain.js";
import {
	disposeRuntime,
	forgetRuntimeProfile,
	liveRuntimes,
	localRuntime,
	runtimeFor,
	setRuntimeProfile,
} from "./registry.js";
import { toolInstallDirectory, type ToolDelivery } from "./toolDelivery.js";

/**
 * A tmux nobody asks for.
 *
 * Nothing in this file reaches a host, so nothing installs a tmux — and a
 * delivery that refuses is how a test that started to would say so instead of
 * quietly downloading two megabytes.
 */
const NO_TMUX: ToolDelivery = {
	tool: "tmux",
	version: "0",
	directory: toolInstallDirectory(".devhub-server", "tmux"),
	tarball: () => Promise.reject(new Error("no tarball in this test")),
};

const NO_BASH: ToolDelivery = {
	...NO_TMUX,
	tool: "bash",
	directory: toolInstallDirectory(".devhub-server", "bash"),
};

const NO_NODE: ToolDelivery = {
	...NO_TMUX,
	tool: "node",
	directory: toolInstallDirectory(".devhub-server", "node"),
};

const NO_NVIM: ToolDelivery = {
	...NO_TMUX,
	tool: "nvim",
	directory: toolInstallDirectory(".devhub-server", "nvim"),
};

/**
 * A socket directory, because the profile puts control sockets under it.
 * Naming the profile's two directories is the point of the seam — a test gets
 * the real arithmetic, not a stub of it.
 */
let userDataDirectory: string;

beforeAll(async () => {
	userDataDirectory = makeSocketDir("profile");
	setRuntimeProfile({
		userDataDirectory,
		home: homedir(),
		tmux: NO_TMUX,
		bash: NO_BASH,
		node: NO_NODE,
		nvim: NO_NVIM,
	});
});
afterAll(async () => {
	forgetRuntimeProfile();
	await rm(userDataDirectory, { recursive: true, force: true });
});

describe("runtimeFor", () => {
	it("gives every local Workspace the one local runtime", () => {
		const one = runtimeFor(workspaceLocation({ kind: "local", path: "/a" }));
		const two = runtimeFor(workspaceLocation({ kind: "local", path: "/b" }));
		expect(one).toBe(two);
		expect(one).toBe(localRuntime());
		expect(one.id).toBe("local");
		expect(one.where).toBe("");
	});

	it("gives every Workspace on one host the same runtime", () => {
		// Not an optimisation: a second runtime for one host would be a second
		// multiplexed connection, a second `$HOME` and a `devhub --metrics` that
		// reported half the truth twice.
		const one = runtimeFor(
			workspaceLocation({ kind: "ssh", host: "build-box", path: "/srv/a" }),
		);
		const two = runtimeFor(
			workspaceLocation({ kind: "ssh", host: "build-box", path: "/srv/b" }),
		);
		const other = runtimeFor(
			workspaceLocation({ kind: "ssh", host: "other-box", path: "/srv/a" }),
		);
		expect(one).toBe(two);
		expect(one).not.toBe(other);
		expect(one.id).toBe("ssh:build-box");
		expect(one.where).toBe(" on build-box");
	});

	it("refuses a remote Workspace before it has been told which profile", () => {
		// The local arm never waits for one — this machine is where main is
		// running. The remote arm does, and a control socket under a directory
		// nobody chose is a master a second DevHub would find and adopt.
		forgetRuntimeProfile();
		expect(() =>
			runtimeFor(
				workspaceLocation({ kind: "ssh", host: "build-box", path: "/srv/a" }),
			),
		).toThrow(/before the runtime profile was set/u);
		setRuntimeProfile({
			userDataDirectory,
			home: homedir(),
			tmux: NO_TMUX,
			bash: NO_BASH,
			node: NO_NODE,
			nvim: NO_NVIM,
		});
	});

	it("refuses to be told twice, because a socket that moved is unreachable", () => {
		expect(() =>
			setRuntimeProfile({
				userDataDirectory,
				home: homedir(),
				tmux: NO_TMUX,
				bash: NO_BASH,
				node: NO_NODE,
				nvim: NO_NVIM,
			}),
		).toThrow(/already been set/u);
	});

	it("runs a Workspace's git where its folder is", () => {
		const local = workspaceLocation({ kind: "local", path: "/projects/api" });
		expect(runtimeFor(local)).toBe(localRuntime());
		const ssh = workspaceLocation({
			kind: "ssh",
			host: "build",
			path: "/srv/api",
		});
		expect(runtimeFor(ssh)).not.toBe(localRuntime());
	});

	it("lists the runtimes that are live, for a reading", async () => {
		expect(liveRuntimes()).toContain(localRuntime());
		expect(liveRuntimes()[0]).toBe(localRuntime());
	});

	it("forgets a host nothing is on any more", async () => {
		const before = runtimeFor(
			workspaceLocation({ kind: "ssh", host: "gone-box", path: "/srv/a" }),
		);
		expect(liveRuntimes()).toContain(before);
		await disposeRuntime(before.id);
		expect(liveRuntimes()).not.toContain(before);
	});
});
