/**
 * A dev container as a machine, against a `docker` that is a function.
 *
 * Every test here states what `docker` said and asserts what DevHub did about
 * it. That is the whole seam `DockerCli.run` exists for: the decisions worth
 * testing — which container to adopt, when to spawn the CLI, what a rebuild
 * means, which sentence a stopped daemon produces — are decisions about *an
 * answer*, and a test that needed a real daemon to make one would be a test
 * that does not run on a machine with Docker turned off.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { CommandOutput } from "../terminal/command.js";
import {
	ContainerRuntime,
	LOCAL_FOLDER_LABEL,
	parseUpOutcome,
	type DevContainerCli,
	type DockerCli,
} from "./container.js";

const FOLDER = "/src/api";

function output(
	code: number,
	stdout = "",
	stderr = "",
): Promise<CommandOutput> {
	return Promise.resolve({
		code,
		stdout: Buffer.from(stdout, "utf8"),
		stderr: Buffer.from(stderr, "utf8"),
		stdoutTruncated: false,
		stderrTruncated: false,
	} as CommandOutput);
}

/** A `docker` that answers from a script and records what it was asked. */
function fakeDocker(
	answer: (args: readonly string[]) => Promise<CommandOutput>,
): DockerCli & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		path: "/fake/docker",
		calls,
		run: (args) => {
			calls.push([...args]);
			return answer(args);
		},
	};
}

function fakeDevcontainer(
	answer: (args: readonly string[]) => Promise<CommandOutput>,
): DevContainerCli & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		path: "/fake/devcontainer",
		calls,
		run: (args) => {
			calls.push([...args]);
			return answer(args);
		},
	};
}

function runtimeWith(
	docker: DockerCli,
	devcontainer: DevContainerCli,
): ContainerRuntime {
	return new ContainerRuntime({
		workspaceFolder: FOLDER,
		docker,
		devcontainer,
	});
}

/** `docker ps` output for one container, in the format the runtime asks for. */
function psLine(id: string, state: string, image = "img"): string {
	return `${id}\t${state}\t${image}\n`;
}

/**
 * A container that answers the two questions the base class asks first.
 *
 * `describeRemote` probes `$HOME`, `uname -s`, `uname -m` and `$SHELL` in one
 * command and then reads the login environment out of a login shell. Every
 * test here has to get past both before it can assert anything of its own, so
 * the answers live in one place rather than in each of them.
 */
function containerShell(script: string): Promise<CommandOutput> | undefined {
	if (script.includes('"$HOME"') && script.includes("uname -s")) {
		return output(0, "/home/vscode\nLinux\naarch64\n/bin/bash\n");
	}
	if (script.includes("env -0")) {
		return output(0, "PATH=/usr/bin:/bin\0HOME=/home/vscode\0");
	}
	return undefined;
}

describe("finding the container", () => {
	it("asks docker by the label the devcontainer CLI itself stamps", async () => {
		const docker = fakeDocker(() => output(0, psLine("abc", "running")));
		const runtime = runtimeWith(
			docker,
			fakeDevcontainer(() => output(0)),
		);
		const state = await runtime.containerState();
		expect(state).toEqual({ kind: "running", id: "abc", image: "img" });
		// The filter is the CLI's own contract with itself; if this string ever
		// drifts, DevHub silently stops finding containers it created.
		expect(docker.calls[0]).toContain(`label=${LOCAL_FOLDER_LABEL}=${FOLDER}`);
	});

	it("tells a stopped container from one that is not there", async () => {
		const stopped = runtimeWith(
			fakeDocker(() => output(0, psLine("abc", "exited"))),
			fakeDevcontainer(() => output(0)),
		);
		expect(await stopped.containerState()).toEqual({
			kind: "stopped",
			id: "abc",
		});
		const absent = runtimeWith(
			fakeDocker(() => output(0, "")),
			fakeDevcontainer(() => output(0)),
		);
		expect(await absent.containerState()).toEqual({ kind: "absent" });
	});

	it("skips a container that is being removed", async () => {
		// Adopting one would be adopting a filesystem that is being deleted
		// underneath every command sent to it. The CLI's own lookup drops these.
		const runtime = runtimeWith(
			fakeDocker(() => output(0, psLine("dying", "removing"))),
			fakeDevcontainer(() => output(0)),
		);
		expect(await runtime.containerState()).toEqual({ kind: "absent" });
	});

	it("names the docker binary when the daemon is not answering", async () => {
		const runtime = runtimeWith(
			fakeDocker(() =>
				output(1, "", "Cannot connect to the Docker daemon at unix:///x.sock"),
			),
			fakeDevcontainer(() => output(0)),
		);
		// The two things that produce this are a Docker that is not started and
		// one that is not installed, and the sentence has to let a person tell
		// which. So it names the binary it ran and quotes what docker said.
		await expect(runtime.containerState()).rejects.toThrow(
			/\/fake\/docker.*Cannot connect to the Docker daemon/su,
		);
	});
});

describe("the happy path does not spawn the CLI", () => {
	it("adopts a running container without running devcontainer up", async () => {
		const docker = fakeDocker((args) => {
			if (args[0] === "ps") return output(0, psLine("abc", "running"));
			if (args[0] === "inspect") return output(0, "");
			// The adopt probe: `printf %s "$HOME"` proves it still answers.
			const script = args.at(-1) ?? "";
			return containerShell(script) ?? output(0, "/home/vscode");
		});
		const devcontainer = fakeDevcontainer(() =>
			Promise.reject(new Error("the CLI must not be spawned on this path")),
		);
		const runtime = runtimeWith(docker, devcontainer);
		expect(await runtime.home()).toBe("/home/vscode");
		// This is the reason `containerState` exists at all: `devcontainer up`
		// is idempotent and would have been correct, but it costs a Node process
		// and a second of wall clock on a path that runs every few seconds.
		expect(devcontainer.calls).toHaveLength(0);
	});

	it("runs devcontainer up when there is no container", async () => {
		let started = false;
		const docker = fakeDocker((args) => {
			if (args[0] === "ps") {
				return output(0, started ? psLine("new", "running") : "");
			}
			if (args[0] === "inspect") return output(0, "");
			return containerShell(args.at(-1) ?? "") ?? output(0, "/home/vscode");
		});
		const devcontainer = fakeDevcontainer(() => {
			started = true;
			return output(
				0,
				JSON.stringify({
					outcome: "success",
					containerId: "new",
					remoteUser: "vscode",
					remoteWorkspaceFolder: "/workspaces/api",
				}),
			);
		});
		const runtime = runtimeWith(docker, devcontainer);
		expect(await runtime.home()).toBe("/home/vscode");
		expect(devcontainer.calls[0]).toEqual([
			"up",
			"--workspace-folder",
			FOLDER,
		]);
	});

	it("passes a chosen config through to the CLI", async () => {
		const devcontainer = fakeDevcontainer(() =>
			output(
				0,
				JSON.stringify({
					outcome: "success",
					containerId: "c",
					remoteUser: "",
					remoteWorkspaceFolder: "/w",
				}),
			),
		);
		const runtime = new ContainerRuntime({
			workspaceFolder: FOLDER,
			configPath: "/src/api/.devcontainer/alt.json",
			docker: fakeDocker((args) =>
				args[0] === "ps"
					? output(0, "")
					: (containerShell(args.at(-1) ?? "") ?? output(0, "/root")),
			),
			devcontainer,
		});
		await runtime.home();
		expect(devcontainer.calls[0]).toEqual([
			"up",
			"--workspace-folder",
			FOLDER,
			"--config",
			"/src/api/.devcontainer/alt.json",
		]);
	});
});

describe("a rebuild is a different machine underneath the same one", () => {
	it("refuses to keep using a runtime whose container id changed", async () => {
		// Research risk 3, as a test. Every "installed once per machine" cache in
		// the base class — tmux, the launcher, the server — is keyed on the
		// runtime instance. A rebuilt container has none of it, so an instance
		// that carried on would believe it had installed things into a
		// filesystem that has been deleted, and every failure after that would
		// be about the wrong thing.
		let id = "first";
		const runtime = runtimeWith(
			fakeDocker((args) => {
				if (args[0] === "ps") return output(0, psLine(id, "running"));
				if (args[0] === "inspect") return output(0, "");
				return containerShell(args.at(-1) ?? "") ?? output(0, "/home/vscode");
			}),
			fakeDevcontainer(() => output(0)),
		);
		expect(await runtime.home()).toBe("/home/vscode");
		expect(runtime.replaced).toBe(false);

		// The container is rebuilt: a new id, and this Mac woke up to find it.
		id = "second";
		runtime.resumed();
		await expect(runtime.home()).rejects.toThrow(/has been rebuilt/u);
		expect(runtime.replaced).toBe(true);

		// And it stays refused. There is nothing this instance could do that
		// would be right, so it says so every time rather than recovering into a
		// state where half its caches describe a container that is gone.
		await expect(runtime.home()).rejects.toThrow(/has been rebuilt/u);
	});

	it("keeps working when the id is the same after a resume", async () => {
		const runtime = runtimeWith(
			fakeDocker((args) => {
				if (args[0] === "ps") return output(0, psLine("same", "running"));
				if (args[0] === "inspect") return output(0, "");
				return containerShell(args.at(-1) ?? "") ?? output(0, "/home/vscode");
			}),
			fakeDevcontainer(() => output(0)),
		);
		expect(await runtime.home()).toBe("/home/vscode");
		runtime.resumed();
		expect(await runtime.home()).toBe("/home/vscode");
		expect(runtime.replaced).toBe(false);
	});
});

describe("reading devcontainer up", () => {
	it("reads the fields the CLI documents on success", () => {
		expect(
			parseUpOutcome(
				JSON.stringify({
					outcome: "success",
					containerId: "abc",
					remoteUser: "vscode",
					remoteWorkspaceFolder: "/workspaces/api",
				}),
			),
		).toEqual({
			outcome: "success",
			result: {
				containerId: "abc",
				remoteUser: "vscode",
				remoteWorkspaceFolder: "/workspaces/api",
			},
		});
	});

	it("prefers the CLI's description over its message", () => {
		// `description` is the sentence written for a person; `message` is often
		// an exception's own words. When both are there the first is the one to
		// show.
		expect(
			parseUpOutcome(
				JSON.stringify({
					outcome: "error",
					message: "Error: spawn failed",
					description: "The image could not be built.",
				}),
			),
		).toEqual({ outcome: "error", message: "The image could not be built." });
	});

	it("reads the last line, so a stray log line does not break it", () => {
		expect(
			parseUpOutcome(
				`some noise\n${JSON.stringify({
					outcome: "success",
					containerId: "abc",
					remoteUser: "",
					remoteWorkspaceFolder: "",
				})}\n`,
			),
		).toMatchObject({ outcome: "success" });
	});

	it("treats an outcome it does not recognise as unreadable", () => {
		// Not as something to work around: an unrecognised shape means this
		// build and this CLI version disagree, and carrying on would mean using
		// whatever happened to be in `containerId` — which could be anything.
		expect(parseUpOutcome(JSON.stringify({ outcome: "maybe" }))).toBeUndefined();
		expect(parseUpOutcome(JSON.stringify({ outcome: "success" }))).toBeUndefined();
		expect(parseUpOutcome("not json at all")).toBeUndefined();
		expect(parseUpOutcome("")).toBeUndefined();
	});
});

describe("a container that goes away mid-command", () => {
	it("says the container is not running and asks again next time", async () => {
		let running = true;
		let psCalls = 0;
		const runtime = runtimeWith(
			fakeDocker((args) => {
				if (args[0] === "ps") {
					psCalls += 1;
					return output(0, psLine("abc", "running"));
				}
				if (args[0] === "inspect") return output(0, "");
				if (!running) {
					return output(1, "", "Error: Container abc is not running");
				}
				return containerShell(args.at(-1) ?? "") ?? output(0, "/home/vscode");
			}),
			fakeDevcontainer(() => output(0)),
		);
		expect(await runtime.home()).toBe("/home/vscode");
		const before = psCalls;
		running = false;
		// `home()` is cached, so reach for something that goes to the container
		// and watch it refuse in the container's own words.
		await expect(runtime.readTextFile("/etc/hostname")).rejects.toThrow(
			/is no longer running/u,
		);
		runtime.resumed();
		running = true;
		expect(await runtime.home()).toBe("/home/vscode");
		// The cached container was dropped, so docker was asked again rather
		// than the runtime reusing an id it had been told was gone.
		expect(psCalls).toBeGreaterThan(before);
	});
});
