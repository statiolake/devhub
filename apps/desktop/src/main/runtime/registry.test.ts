/**
 * The one switch, and the fact that it is the only one.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	containerHostId,
	devContainerConfigPath,
	workspaceLocation,
	type ContainerTarget,
} from "../../model/domain.js";
import {
	containerHostFor,
	disposeContainerHost,
	disposeRuntime,
	editorHostMachine,
	forgetRuntimeProfile,
	liveContainerHosts,
	liveRuntimes,
	localRuntime,
	runtimeFor,
	runtimeMachine,
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
/** A folder on this Mac with its default definition. */
const TARGET: ContainerTarget = {
	location: workspaceLocation({ kind: "local", path: "/projects/api" }),
	configPath: devContainerConfigPath(
		"/projects/api/.devcontainer/devcontainer.json",
	),
};

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

	it("replaces a container host whose container was rebuilt", async () => {
		// The other half of the rebuild invariant: a host that has seen its
		// container replaced refuses everything afterwards, so unless *something*
		// throws it away the refusal is permanent and a rebuilt container never
		// comes back. That something is this function, because the target has
		// not changed — keying on the folder and the definition is what makes a
		// rebuild cost an instance and not an editor.
		const first = containerHostFor(TARGET);
		expect(containerHostFor(TARGET)).toBe(first);
		// Stand in for what `#noteContainer` does when the id underneath it
		// changes; `container.test.ts` drives that through the real docker calls.
		Object.defineProperty(first, "replaced", { get: () => true });
		const second = containerHostFor(TARGET);
		expect(second).not.toBe(first);
		expect(second.id).toBe(first.id);
		await disposeContainerHost(second.id);
	});

	it("keeps one host per definition, not per folder", async () => {
		// A folder with two definitions has a container for each, and they are
		// two things to reach.
		const other: ContainerTarget = {
			...TARGET,
			configPath: devContainerConfigPath(
				"/projects/api/.devcontainer/python/devcontainer.json",
			),
		};
		expect(containerHostFor(other)).not.toBe(containerHostFor(TARGET));
		await disposeContainerHost(containerHostId(other));
		await disposeContainerHost(containerHostId(TARGET));
		expect(liveContainerHosts()).toHaveLength(0);
	});

	it("reaches a container on a host through that host, as a container of its own", async () => {
		// The same folder path on a host is a different folder, and so a
		// different container: the host is part of which container this is.
		const onHost: ContainerTarget = {
			location: workspaceLocation({
				kind: "ssh",
				host: "build",
				path: "/projects/api",
			}),
			configPath: TARGET.configPath,
		};
		const host = containerHostFor(onHost);
		expect(host).not.toBe(containerHostFor(TARGET));
		expect(host.id).not.toBe(containerHostId(TARGET));
		expect(host.where).toBe(" in the dev container for /projects/api on build");
		await disposeContainerHost(host.id);
		await disposeContainerHost(containerHostId(TARGET));
		await disposeRuntime("ssh:build");
	});

	it("never hands a container out as a Workspace's machine", () => {
		// Nothing a Workspace owns runs in a container, so no runtime id names
		// one; the resolver's name for it is a separate spelling that only the
		// editor path accepts.
		const id = containerHostId(TARGET);
		expect(() => runtimeMachine(id)).toThrow(/does not name a machine/u);
		expect(editorHostMachine(id)).toBe(id);
		expect(editorHostMachine("ssh:build")).toBe("ssh:build");
		expect(() => editorHostMachine("local")).toThrow();
		expect(liveRuntimes()).not.toContain(containerHostFor(TARGET));
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
