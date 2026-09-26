/**
 * A dev container as an editor's far end, against a `docker` that is a
 * function.
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
import {
	devContainerConfigPath,
	workspaceLocation,
	type ContainerTarget,
} from "../../model/domain.js";
import type { CommandOutput } from "../terminal/command.js";
import { PortFailure } from "../terminal/ports.js";
import {
	CONFIG_FILE_LABEL,
	ContainerHost,
	containerName,
	devContainerConfigsIn,
	LOCAL_FOLDER_LABEL,
	parseUpOutcome,
	type DevContainerCli,
	type DockerCli,
} from "./container.js";

const FOLDER = "/src/api";
const CONFIG = "/src/api/.devcontainer/devcontainer.json";

function target(configPath = CONFIG): ContainerTarget {
	return {
		location: workspaceLocation({ kind: "local", path: FOLDER }),
		configPath: devContainerConfigPath(configPath),
	};
}

/** What `devcontainer up` answers with when it succeeds. */
function upSucceeded(containerId: string): Promise<CommandOutput> {
	return output(
		0,
		JSON.stringify({
			outcome: "success",
			containerId,
			remoteUser: "vscode",
			remoteWorkspaceFolder: "/workspaces/api",
		}),
	);
}

function output(
	code: number,
	stdout = "",
	stderr = "",
): Promise<CommandOutput> {
	return Promise.resolve({
		success: code === 0,
		code,
		signal: null,
		stdout: Buffer.from(stdout, "utf8"),
		stderr: Buffer.from(stderr, "utf8"),
	});
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
	configPath = CONFIG,
): ContainerHost {
	return new ContainerHost({
		target: target(configPath),
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
	it("asks docker by the labels the devcontainer CLI itself stamps", async () => {
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
		// And by the definition: a folder with two has a container for each, and
		// the folder alone would name both.
		expect(docker.calls[0]).toContain(`label=${CONFIG_FILE_LABEL}=${CONFIG}`);
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
		// one that is not installed, so it names the binary it ran — and it
		// names the remedy, because a condition has nowhere to put a button.
		// What docker itself said goes to the log, not into the sentence.
		await expect(runtime.containerState()).rejects.toThrow(
			/\/fake\/docker.*Start Docker/su,
		);
	});
});

describe("one Workspace, one container", () => {
	// Two callers asking for the same folder at once — a restored Workspace's
	// window resolving and the picker opening it — ran `devcontainer up` twice,
	// 260 ms apart, and each created a container carrying the same label.
	it("brings a folder up once however many callers ask at the same moment", async () => {
		let started = false;
		const docker = () =>
			fakeDocker((args) => {
				if (args[0] === "ps") {
					return output(0, started ? psLine("c".repeat(64), "running") : "");
				}
				if (args[0] === "inspect") return output(0, "");
				return containerShell(args.at(-1) ?? "") ?? output(0, "/home/vscode");
			});
		const waiting: (() => void)[] = [];
		const release = () => {
			started = true;
			for (const resolve of waiting) resolve();
		};
		const devcontainer = fakeDevcontainer(async () => {
			await new Promise<void>((resolve) => waiting.push(resolve));
			return output(
				0,
				JSON.stringify({
					outcome: "success",
					containerId: "c".repeat(64),
					remoteUser: "vscode",
					remoteWorkspaceFolder: "/workspaces/api",
				}),
			);
		});
		const first = runtimeWith(docker(), devcontainer);
		const second = runtimeWith(docker(), devcontainer);
		const both = Promise.all([
			first.ensureUp({ build: true }),
			first.ensureUp({ build: true }),
			second.ensureUp({ build: true }),
		]);
		await new Promise((resolve) => setTimeout(resolve, 10));
		release();
		await both;
		expect(devcontainer.calls.filter((call) => call[0] === "up")).toHaveLength(
			1,
		);
		expect(await first.home()).toBe("/home/vscode");
		expect(await second.home()).toBe("/home/vscode");
	});

	it("refuses to pick when two containers carry the definition's labels", async () => {
		const runtime = runtimeWith(
			fakeDocker(() =>
				output(
					0,
					psLine("a".repeat(64), "running") + psLine("b".repeat(64), "running"),
				),
			),
			fakeDevcontainer(() => output(0)),
		);
		await expect(runtime.containerState()).rejects.toThrow(
			new RegExp(`${"a".repeat(64)}.*${"b".repeat(64)}`, "su"),
		);
		await expect(runtime.containerState()).rejects.toThrow(FOLDER);
	});
});

describe("a container that is not running is a condition, not a restart", () => {
	it("refuses a command rather than starting the container behind the person", async () => {
		// Every command comes through this path, including the reconcile round
		// that runs on a cadence tick. A `devcontainer up` here would restart the
		// container within seconds of somebody running `docker stop`, every
		// time, so they could never keep it stopped — and `up` is the call that
		// may rebuild an image, so a background round could start a minutes-long
		// build nobody asked for.
		const devcontainer = fakeDevcontainer(() =>
			Promise.reject(new Error("up must not run on the command path")),
		);
		const runtime = runtimeWith(
			fakeDocker((args) =>
				args[0] === "ps" ? output(0, psLine("abc", "exited")) : output(0, ""),
			),
			devcontainer,
		);
		await expect(runtime.home()).rejects.toThrow(/is not running/u);
		expect(devcontainer.calls).toHaveLength(0);
	});

	it("names the command in the sentence, because a condition has no button", async () => {
		// `machineConditions.ts` publishes a summary string and nothing else —
		// there is nowhere on a condition for an action. So the sentence has to
		// be the action, with this Workspace's folder already in it.
		const runtime = runtimeWith(
			fakeDocker((args) =>
				args[0] === "ps" ? output(0, psLine("abc", "exited")) : output(0, ""),
			),
			fakeDevcontainer(() => output(0)),
		);
		const failure = await runtime.home().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(PortFailure);
		expect((failure as PortFailure).detail).toContain(
			`devcontainer up --workspace-folder '${FOLDER}' --config '${CONFIG}'`,
		);
	});

	it("tells a container that was never built from one that is stopped", async () => {
		const runtime = runtimeWith(
			fakeDocker((args) => (args[0] === "ps" ? output(0, "") : output(0, ""))),
			fakeDevcontainer(() => output(0)),
		);
		await expect(runtime.home()).rejects.toThrow(/has not been built yet/u);
	});

	it("carries a PortFailure, which is what makes the sentence reach a person", async () => {
		// `portRefusal` carries a `detail` through only from a `PortFailure`;
		// anything else arrives as the bare "DevHub is not getting an answer
		// from container:…", which names the machine and nothing to do about it.
		const runtime = runtimeWith(
			fakeDocker(() =>
				output(1, "", "Cannot connect to the Docker daemon at unix:///x.sock"),
			),
			fakeDevcontainer(() => output(0)),
		);
		const failure = await runtime.containerState().catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(PortFailure);
		// DevHub's own words, not docker's — the rule `PortFailure.detail` states.
		expect((failure as PortFailure).detail).toContain("Start Docker");
		expect((failure as PortFailure).detail).not.toContain("unix:///x.sock");
	});

	it("starts the container when somebody actually asks", async () => {
		let started = false;
		const devcontainer = fakeDevcontainer(() => {
			started = true;
			return output(
				0,
				JSON.stringify({
					outcome: "success",
					containerId: "c".repeat(64),
					remoteUser: "vscode",
					remoteWorkspaceFolder: "/workspaces/api",
				}),
			);
		});
		const runtime = runtimeWith(
			fakeDocker((args) => {
				if (args[0] === "ps") {
					return output(0, started ? psLine("c".repeat(64), "running") : "");
				}
				if (args[0] === "inspect") return output(0, "");
				return containerShell(args.at(-1) ?? "") ?? output(0, "/home/vscode");
			}),
			devcontainer,
		);
		expect(await runtime.ensureUp({ build: true })).toEqual({
			containerId: "c".repeat(64),
			started: true,
		});
		expect(devcontainer.calls[0]?.[0]).toBe("up");
		// And the container it just brought up is the one commands now go to.
		expect(await runtime.home()).toBe("/home/vscode");
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
		// `ensureUp` and not `home()`: starting a container is an explicit act,
		// and no path a timer can reach may do it.
		await runtime.ensureUp({ build: true });
		expect(await runtime.home()).toBe("/home/vscode");
		// `--config` always: which definition is part of which container.
		expect(devcontainer.calls[0]).toEqual([
			"up",
			"--workspace-folder",
			FOLDER,
			"--config",
			CONFIG,
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
		const runtime = runtimeWith(
			fakeDocker((args) =>
				args[0] === "ps"
					? output(0, "")
					: (containerShell(args.at(-1) ?? "") ?? output(0, "/root")),
			),
			devcontainer,
			"/src/api/.devcontainer/alt.json",
		);
		await runtime.ensureUp({ build: true });
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

	it("asks docker for untruncated ids, so a restart is not a rebuild", async () => {
		// Found by running it. `docker ps --format {{.ID}}` gives the short
		// twelve-character id and `devcontainer up` answers with the full
		// sixty-four, so without `--no-trunc` the two ways this runtime learns
		// an id spell the same container differently — and every `docker stop`
		// followed by a restart was reported to the person as "the dev container
		// has been rebuilt".
		const full = "a".repeat(64);
		const docker = fakeDocker((args) => {
			if (args[0] === "ps") return output(0, psLine(full, "running"));
			if (args[0] === "inspect") return output(0, "");
			return containerShell(args.at(-1) ?? "") ?? output(0, "/home/vscode");
		});
		const runtime = runtimeWith(
			docker,
			fakeDevcontainer(() => output(0)),
		);
		await runtime.home();
		expect(docker.calls[0]).toContain("--no-trunc");
		expect(await runtime.containerState()).toMatchObject({ id: full });
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
		expect(
			parseUpOutcome(JSON.stringify({ outcome: "maybe" })),
		).toBeUndefined();
		expect(
			parseUpOutcome(JSON.stringify({ outcome: "success" })),
		).toBeUndefined();
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
		await expect(runtime.readTextFile("/etc/hostname", 4096)).rejects.toThrow(
			/is not running/u,
		);
		runtime.resumed();
		running = true;
		expect(await runtime.home()).toBe("/home/vscode");
		// The cached container was dropped, so docker was asked again rather
		// than the runtime reusing an id it had been told was gone.
		expect(psCalls).toBeGreaterThan(before);
	});
});

describe("opening a window starts a container and never builds one", () => {
	it("starts a stopped container, and says it was this call that started it", async () => {
		let running = false;
		const devcontainer = fakeDevcontainer(() => {
			running = true;
			return upSucceeded("c".repeat(64));
		});
		const runtime = runtimeWith(
			fakeDocker((args) => {
				if (args[0] === "ps") {
					return output(
						0,
						psLine("c".repeat(64), running ? "running" : "exited"),
					);
				}
				if (args[0] === "inspect") return output(0, "");
				return containerShell(args.at(-1) ?? "") ?? output(0, "/home/vscode");
			}),
			devcontainer,
		);
		await runtime.prepare();
		expect(devcontainer.calls[0]?.[0]).toBe("up");
		// A second window, or a resolve that comes again, finds it running and
		// did not start anything.
		expect(await runtime.ensureUp({ build: false })).toEqual({
			containerId: "c".repeat(64),
			started: false,
		});
	});

	it("refuses to build one that was never built, in a sentence that names the command", async () => {
		// Restoring the editors DevHub had at launch is the person's standing
		// choice to have this one in its container — enough to start a
		// container that exists, not enough to spend minutes building an image.
		const devcontainer = fakeDevcontainer(() =>
			Promise.reject(new Error("up must not run to build on a window open")),
		);
		const runtime = runtimeWith(
			fakeDocker(() => output(0, "")),
			devcontainer,
		);
		const failure = await runtime.prepare().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(PortFailure);
		expect((failure as PortFailure).detail).toMatch(
			/has not been built yet\. Build it with: devcontainer up/u,
		);
		expect(devcontainer.calls).toHaveLength(0);
	});
});

describe("nothing a Workspace owns runs in a container", () => {
	it("refuses a pseudo-terminal, as the bug it would be", () => {
		const runtime = runtimeWith(
			fakeDocker(() => output(0, "")),
			fakeDevcontainer(() => output(0)),
		);
		expect(() => runtime.spawnPty()).toThrow(/only its editor is attached/u);
	});

	it("refuses a stream before asking the container anything", () => {
		const docker = fakeDocker(() => output(0, psLine("abc", "running")));
		const runtime = runtimeWith(
			docker,
			fakeDevcontainer(() => output(0)),
		);
		expect(() => runtime.spawnStream()).toThrow(/only its editor is attached/u);
		expect(docker.calls).toHaveLength(0);
	});

	it("refuses to look for an Agent's program or for tmux in it", async () => {
		const runtime = runtimeWith(
			fakeDocker(() => output(0, psLine("abc", "running"))),
			fakeDevcontainer(() => output(0)),
		);
		await expect(runtime.resolveProgram()).rejects.toThrow(
			/only its editor is attached/u,
		);
		await expect(runtime.tmuxProgram()).rejects.toThrow(
			/only its editor is attached/u,
		);
	});
});

describe("what a container is called", () => {
	it("is its folder, and its definition when that is not the folder's default", () => {
		expect(containerName(FOLDER, CONFIG)).toBe(
			"the dev container for /src/api",
		);
		expect(containerName(FOLDER, "/src/api/.devcontainer.json")).toBe(
			"the dev container for /src/api",
		);
		expect(
			containerName(FOLDER, "/src/api/.devcontainer/python/devcontainer.json"),
		).toBe("the dev container for /src/api (python)");
		expect(containerName(FOLDER, "/src/api/tools/dev.json")).toBe(
			"the dev container for /src/api (tools/dev.json)",
		);
	});
});

describe("letting go of a container DevHub started", () => {
	function stopping(options: {
		readonly state: string;
		readonly configuration: Record<string, unknown>;
		readonly project?: string;
	}) {
		const docker = fakeDocker((args) => {
			if (args[0] === "ps") return output(0, psLine("c1", options.state));
			if (args[0] === "inspect") return output(0, `${options.project ?? ""}\n`);
			return output(0, "");
		});
		const devcontainer = fakeDevcontainer((args) =>
			args[0] === "read-configuration"
				? output(0, JSON.stringify({ configuration: options.configuration }))
				: Promise.reject(new Error(`${args[0] ?? ""} must not run here`)),
		);
		return { runtime: runtimeWith(docker, devcontainer), docker, devcontainer };
	}

	it("stops an image container by default, the spec's stopContainer", async () => {
		const { runtime, docker } = stopping({
			state: "running",
			configuration: { image: "alpine" },
		});
		expect(await runtime.stopIfStarted("c1")).toMatch(/^Stopped /u);
		expect(docker.calls.at(-1)).toEqual(["stop", "c1"]);
	});

	it("stops a Compose definition's whole project by default, the spec's stopCompose", async () => {
		const { runtime, docker } = stopping({
			state: "running",
			configuration: { dockerComposeFile: "compose.yml", service: "app" },
			project: "api_devcontainer",
		});
		await runtime.stopIfStarted("c1");
		expect(docker.calls.at(-1)).toEqual([
			"compose",
			"--project-name",
			"api_devcontainer",
			"stop",
		]);
	});

	it("leaves it running when the definition says none", async () => {
		const { runtime, docker } = stopping({
			state: "running",
			configuration: { image: "alpine", shutdownAction: "none" },
		});
		expect(await runtime.stopIfStarted("c1")).toBeUndefined();
		expect(docker.calls.some((call) => call[0] === "stop")).toBe(false);
	});

	it("leaves a container DevHub did not start alone, whatever the definition says", async () => {
		// One that was running when DevHub found it, or one somebody rebuilt
		// since: stopping it is not DevHub's to decide.
		const { runtime, docker, devcontainer } = stopping({
			state: "running",
			configuration: { image: "alpine" },
		});
		expect(await runtime.stopIfStarted("someone-elses")).toBeUndefined();
		expect(docker.calls.some((call) => call[0] === "stop")).toBe(false);
		expect(devcontainer.calls).toHaveLength(0);
	});

	it("refuses a shutdownAction the spec does not have, rather than guessing", async () => {
		const { runtime } = stopping({
			state: "running",
			configuration: { image: "alpine", shutdownAction: "stopEverything" },
		});
		await expect(runtime.stopIfStarted("c1")).rejects.toThrow(
			/not none, stopContainer or stopCompose/u,
		);
	});

	it("says when docker would not stop it, in docker's words", async () => {
		const docker = fakeDocker((args) => {
			if (args[0] === "ps") return output(0, psLine("c1", "running"));
			if (args[0] === "stop") return output(1, "", "permission denied");
			return output(0, "");
		});
		const runtime = runtimeWith(
			docker,
			fakeDevcontainer(() =>
				output(0, JSON.stringify({ configuration: { image: "a" } })),
			),
		);
		await expect(runtime.stopIfStarted("c1")).rejects.toThrow(
			/could not stop .*permission denied/u,
		);
	});
});

describe("hearing that a container was started", () => {
	it("tells the listener only when a bring-up started it", async () => {
		const heard: string[] = [];
		let running = false;
		const make = () =>
			new ContainerHost({
				target: target(),
				docker: fakeDocker((args) => {
					if (args[0] === "ps") {
						return output(0, running ? psLine("c".repeat(64), "running") : "");
					}
					if (args[0] === "inspect") return output(0, "");
					return containerShell(args.at(-1) ?? "") ?? output(0, "/home/vscode");
				}),
				devcontainer: fakeDevcontainer(() => {
					running = true;
					return upSucceeded("c".repeat(64));
				}),
				onStarted: (_host, id) => heard.push(id),
			});
		await make().ensureUp({ build: true });
		await make().ensureUp({ build: true });
		expect(heard).toEqual(["c".repeat(64)]);
	});
});

describe("the definitions a folder has", () => {
	it("lists the defaults, then the named ones by name", async () => {
		const files = new Set([
			"/src/api/.devcontainer/devcontainer.json",
			"/src/api/.devcontainer.json",
			"/src/api/.devcontainer/python/devcontainer.json",
			"/src/api/.devcontainer/go/devcontainer.json",
		]);
		const found = await devContainerConfigsIn(
			{
				stat: (path) =>
					Promise.resolve(
						files.has(path)
							? "file"
							: path === "/src/api/.devcontainer"
								? "directory"
								: "absent",
					),
				readdir: () =>
					Promise.resolve([
						{ name: "python", directory: true },
						{ name: "go", directory: true },
						{ name: "empty", directory: true },
						{ name: "notes.md", directory: false },
					]),
			},
			"/src/api",
		);
		expect(found).toEqual([
			"/src/api/.devcontainer/devcontainer.json",
			"/src/api/.devcontainer.json",
			"/src/api/.devcontainer/go/devcontainer.json",
			"/src/api/.devcontainer/python/devcontainer.json",
		]);
	});

	it("is nothing for a folder with none", async () => {
		expect(
			await devContainerConfigsIn(
				{
					stat: () => Promise.resolve("absent"),
					readdir: () => Promise.reject(new Error("not asked")),
				},
				"/src/api",
			),
		).toEqual([]);
	});
});
