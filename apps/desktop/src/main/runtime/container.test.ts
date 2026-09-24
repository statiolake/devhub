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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { describeHostLink } from "../agent/conversation/hostLink.test.js";
import type { CommandOutput } from "../terminal/command.js";
import { CancellationToken, PortFailure } from "../terminal/ports.js";
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
		// one that is not installed, so it names the binary it ran — and it
		// names the remedy, because a condition has nowhere to put a button.
		// What docker itself said goes to the log, not into the sentence.
		await expect(runtime.containerState()).rejects.toThrow(
			/\/fake\/docker.*Start Docker/su,
		);
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
			`devcontainer up --workspace-folder ${FOLDER}`,
		);
	});

	it("tells a container that was never built from one that is stopped", async () => {
		const runtime = runtimeWith(
			fakeDocker((args) => (args[0] === "ps" ? output(0, "") : output(0, ""))),
			fakeDevcontainer(() => output(0)),
		);
		await expect(runtime.home()).rejects.toThrow(
			/No dev container has been built/u,
		);
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
		await runtime.ensureUp();
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
		await runtime.ensureUp();
		expect(await runtime.home()).toBe("/home/vscode");
		expect(devcontainer.calls[0]).toEqual(["up", "--workspace-folder", FOLDER]);
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
		await runtime.ensureUp();
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

/**
 * A `docker` that is a program, for the one thing a function cannot stand in
 * for: a long-lived `docker exec -i` whose stdout is a pipe. It answers `ps`
 * and `inspect` the way the adopt path needs and runs every `exec` here, as
 * the fake ssh does, so the container is this machine and what is under test
 * is the argv DevHub composes and what it makes of the ending. While the file
 * `$DEVHUB_FAKE_DOCKER_GONE` exists, `exec` answers the way docker does for a
 * container that has stopped.
 */
const FAKE_DOCKER = `#!/bin/sh
case "$1" in
  ps) printf 'abc\\trunning\\timg\\n'; exit 0;;
  inspect) exit 0;;
  exec) shift;;
  *) echo "fake docker: $1 is not something it answers" >&2; exit 2;;
esac
while [ $# -gt 0 ]; do
  case "$1" in -u) shift 2;; -i) shift;; *) break;; esac
done
id=$1
shift
if [ -f "$DEVHUB_FAKE_DOCKER_GONE" ]; then
  echo "Error response from daemon: container $id is not running" >&2
  exit 1
fi
exec "$@"
`;

const dockerHome = mkdtempSync(
	join(
		(() => {
			const root = fileURLToPath(
				new URL("../../../../../.spike/", import.meta.url),
			);
			mkdirSync(root, { recursive: true });
			return root;
		})(),
		"devhub-fake-docker-",
	),
);
const dockerProgram = join(dockerHome, "docker");
const containerGone = join(dockerHome, "gone");
writeFileSync(dockerProgram, FAKE_DOCKER, { mode: 0o700 });
afterAll(() => {
	rmSync(dockerHome, { recursive: true, force: true });
});

/**
 * A container runtime whose `docker` really runs, here.
 *
 * `SHELL` is pinned for the reason `ssh.test.ts` pins it: the runtime reads
 * the login environment of the "container", which is this machine, and that
 * must not be whoever is running the suite's own shell profile.
 */
function streamingRuntime(): ContainerRuntime {
	return new ContainerRuntime({
		workspaceFolder: FOLDER,
		docker: { path: dockerProgram },
		devcontainer: fakeDevcontainer(() =>
			Promise.reject(new Error("the CLI must not be spawned on this path")),
		),
		localEnvironment: {
			...process.env,
			SHELL: "/bin/sh",
			DEVHUB_FAKE_DOCKER_GONE: containerGone,
		},
	});
}

async function streamed(stdout: AsyncIterable<Buffer>): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stdout) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

describe("a stream in the container", () => {
	it("runs through docker exec -i, with the environment it was given", async () => {
		const running = streamingRuntime().spawnStream({
			argv: ["/bin/sh", "-c", 'printf %s "$DEVHUB_STREAMED"; exit 4'],
			env: { DEVHUB_STREAMED: "in the container" },
			cancel: new CancellationToken(),
		});
		expect(await streamed(running.stdout)).toBe("in the container");
		expect((await running.ended).code).toBe(4);
	});

	it("says a program is unavailable in the words exec uses", async () => {
		const running = streamingRuntime().spawnStream({
			argv: ["devhub-no-such-program"],
			cancel: new CancellationToken(),
		});
		expect(await streamed(running.stdout)).toBe("");
		await expect(running.ended).rejects.toMatchObject({ code: "unavailable" });
	});

	it("says the container stopped, rather than that the program failed", async () => {
		const runtime = streamingRuntime();
		// Reached once, so the container is adopted; then it stops.
		await runtime.home();
		writeFileSync(containerGone, "");
		try {
			const running = runtime.spawnStream({
				argv: ["/bin/sh", "-c", "echo never"],
				cancel: new CancellationToken(),
			});
			expect(await streamed(running.stdout)).toBe("");
			const failure = await running.ended.then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(failure).toBeInstanceOf(PortFailure);
			expect((failure as PortFailure).message).toContain("is not running");
		} finally {
			rmSync(containerGone, { force: true });
		}
	});
});

describeHostLink("container", streamingRuntime);
