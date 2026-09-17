/**
 * The one switch, and the fact that it is the only one.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceLocation } from "../../model/domain.js";
import {
	disposeRuntime,
	forgetRuntimeProfile,
	gitRuntimeFor,
	liveRuntimes,
	localRuntime,
	runtimeFor,
	setRuntimeProfile,
} from "./registry.js";
import type { RehDelivery } from "./remoteServer.js";
import type { DevContainerCli, DockerCli } from "./container.js";
import { tmuxInstallDirectory, type TmuxDelivery } from "./tmuxDelivery.js";

/**
 * A tmux nobody asks for.
 *
 * Nothing in this file reaches a host, so nothing installs a tmux — and a
 * delivery that refuses is how a test that started to would say so instead of
 * quietly downloading two megabytes.
 */
const NO_TMUX: TmuxDelivery = {
	version: "0",
	directory: tmuxInstallDirectory(".devhub-server"),
	tarball: () => Promise.reject(new Error("no tarball in this test")),
};

/** A remote extension host nobody asks for, for the same reason. */
const NO_REH: RehDelivery = {
	commit: undefined,
	dataFolderName: ".devhub-server",
	applicationName: "devhub-server",
	tarball: () => Promise.reject(new Error("no tarball in this test")),
};

/**
 * A docker and a devcontainer CLI nobody runs, for the same reason: a test
 * that asked the registry which runtime a location is on must not reach the
 * daemon on whatever machine happens to be running it.
 */
const NO_DOCKER: DockerCli = {
	path: "/nonexistent/docker",
	run: () => Promise.reject(new Error("no docker in this test")),
};

const NO_DEVCONTAINER: DevContainerCli = {
	path: "/nonexistent/devcontainer",
	run: () => Promise.reject(new Error("no devcontainer CLI in this test")),
};

/**
 * Short on purpose: a control socket has to fit in 104 bytes, and macOS puts
 * `TMPDIR` fifty characters deep. Naming the profile's two directories is the
 * point of the seam — a test gets the real arithmetic, not a stub of it.
 */
let userDataDirectory: string;

beforeAll(async () => {
	userDataDirectory = await mkdtemp("/tmp/devhub-profile-");
	setRuntimeProfile({
		userDataDirectory,
		home: homedir(),
		tmux: NO_TMUX,
		reh: NO_REH,
		docker: NO_DOCKER,
		devcontainer: NO_DEVCONTAINER,
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
			reh: NO_REH,
			docker: NO_DOCKER,
			devcontainer: NO_DEVCONTAINER,
		});
	});

	it("refuses to be told twice, because a socket that moved is unreachable", () => {
		expect(() =>
			setRuntimeProfile({
				userDataDirectory,
				home: homedir(),
				tmux: NO_TMUX,
				reh: NO_REH,
				docker: NO_DOCKER,
				devcontainer: NO_DEVCONTAINER,
			}),
		).toThrow(/already been set/u);
	});

	it("replaces a container runtime whose container was rebuilt", async () => {
		// The other half of the rebuild invariant, and the half that was
		// missing: a runtime that has seen its container replaced refuses
		// everything afterwards, so unless *something* throws it away the
		// refusal is permanent and a rebuilt container never comes back. That
		// something is this function, because the Workspace has not changed —
		// keying the machine on the host folder is what makes a rebuild cost an
		// instance and not a row.
		const location = workspaceLocation({
			kind: "container",
			workspaceFolder: "/src/api",
			path: "/workspaces/api",
		});
		const first = runtimeFor(location);
		expect(runtimeFor(location)).toBe(first);
		// Stand in for what `#noteContainer` does when the id underneath it
		// changes; `container.test.ts` drives that through the real docker calls.
		Object.defineProperty(first, "replaced", { get: () => true });
		const second = runtimeFor(location);
		expect(second).not.toBe(first);
		// And the machine is the same machine, which is the whole point.
		expect(second.id).toBe(first.id);
	});

	it("runs a dev container's git on this Mac, in the folder on this Mac", () => {
		// The bug this is holding down was visible the first time a container
		// Workspace drew a row: git ran *in* the container against
		// `/workspaces/repo`, and the row said it could not read the repository.
		// Both halves were wrong — the machine and the path — which is why they
		// come from one call.
		const location = workspaceLocation({
			kind: "container",
			workspaceFolder: "/projects/api",
			path: "/workspaces/api",
		});
		const git = gitRuntimeFor(location);
		expect(git.runtime).toBe(localRuntime());
		expect(git.root).toBe("/projects/api");
		// And the work still happens in the container: terminals and Agents go
		// through `runtimeFor`, which is the other answer and the right one for
		// them.
		expect(runtimeFor(location)).not.toBe(localRuntime());
	});

	it("leaves the other two kinds exactly where they were", () => {
		const local = workspaceLocation({ kind: "local", path: "/projects/api" });
		expect(gitRuntimeFor(local).runtime).toBe(localRuntime());
		expect(gitRuntimeFor(local).root).toBe("/projects/api");
		const ssh = workspaceLocation({
			kind: "ssh",
			host: "build",
			path: "/srv/api",
		});
		// A host's git runs on the host, in the folder that is on it — the same
		// runtime everything else about that Workspace uses.
		expect(gitRuntimeFor(ssh).runtime).toBe(runtimeFor(ssh));
		expect(gitRuntimeFor(ssh).root).toBe("/srv/api");
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
