/**
 * A Dev Container as the far end of a Workspace's editor.
 *
 * A container is where an editor may be attached, and nothing else: the
 * Workspace's terminals and Agents run where its folder is, and so does its
 * git. What runs in here is the remote extension host (and with it the
 * workbench's language servers and tasks), and the `devhub` command, which
 * reaches DevHub back through a relay.
 *
 * DevHub still reaches it the way it reaches a host — POSIX `sh` over a
 * connection this Mac holds — so this is a `RemoteShellRuntime` for the half
 * that is about shells (the `sh`-based file operations, `$HOME`, the server
 * install, the `devhub` command), and it refuses the half that is about
 * running a Workspace's processes (a pty, a stream, tmux) as the invariant
 * breach it would be. Two things docker does differently from ssh cannot be
 * given for free:
 *
 * Those two are worth naming up front, because they are the whole design:
 *
 * **There is no port forward, so there is a relay.** `ssh -L` turns a socket on
 * a host into a port here, and docker has nothing of the kind: a container's
 * ports must be published when it is *created*, which is the `devcontainer.json`'s
 * business and not DevHub's, and an existing container cannot gain one without
 * being destroyed. So DevHub makes its own: a TCP listener on this Mac whose
 * every accepted connection gets a `docker exec -i` of its own, running a
 * twenty-line relay against the server's unix socket in there, with the two
 * stdio streams piped to the socket. It is what `ssh -W` is, written out.
 *
 * **There is no reverse forward either**, so the control socket is relayed the
 * same way in the other direction: one long-lived `docker exec` running a
 * listener inside the container, every connection to which is carried back out
 * to DevHub's real socket here. That keeps everything above the socket exactly
 * as `docs/remote-ssh.md` describes it — one control protocol, one answering
 * side, the `devhub` shim in a tagged bin directory — and re-targets nothing
 * but the transport.
 *
 * **The container id is not the identity.** A rebuild is routine — it is what
 * dev containers are *for* — and it produces a new container with a new
 * filesystem and none of what DevHub installed. So a container is addressed by
 * its `ContainerTarget` — the folder, its machine and its definition — and
 * this host notices when the container underneath it has been replaced and
 * says so; `registry.ts` disposes it and builds another, because every
 * "installed once" cache in the base class is keyed on the instance.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createServer, connect, type Server, type Socket } from "node:net";
import { posix } from "node:path";
import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import { RollingTally } from "../diagnostics/rollingTally.js";
import {
	OperationDeadline,
	runBounded,
	type CommandOutput,
} from "../terminal/command.js";
import { CancellationToken, portFailure } from "../terminal/ports.js";
import type { Pty } from "../terminal/pty.js";
import type { StreamLaunch } from "./byteStream.js";
import { LOCAL_CADENCE } from "./local.js";
import { shellQuote } from "./quote.js";
import {
	describeFailure,
	lastLine,
	platformName,
	PROBE_LIMITS,
	PROBE_TIMEOUT_MS,
	RemoteShellRuntime,
	remoteScript,
	SCRIPT_MARKER,
} from "./remoteShellRuntime.js";
import {
	newConnectionToken,
	parseStartedServer,
	permanent,
	remoteServerPaths,
	sourceBuildRefusal,
	startServerScript,
	unpackServerScript,
	type RehDelivery,
	type RemoteServerEndpoint,
	type RemoteServerHost,
} from "./remoteServer.js";
import {
	containerHostId,
	devContainerConfigLabel,
	devContainerConfigPath,
	workspaceRoot,
	type ContainerHostId,
	type ContainerTarget,
	type DevContainerConfigPath,
} from "../../model/domain.js";
import type {
	ByteStream,
	ExecRequest,
	ExecResult,
	TerminalLauncher,
	TerminalLauncherSpec,
	RuntimeCadence,
	Runtime,
	RuntimeReading,
} from "./runtime.js";
import type { TmuxDelivery } from "./tmuxDelivery.js";

const A_MINUTE = 60 * 1000;

/**
 * The docker labels `@devcontainers/cli` stamps on every container it creates.
 *
 * `devcontainer.local_folder` is the host folder and
 * `devcontainer.config_file` the definition it was built from. They are the
 * CLI's published contract with itself — its own `findDevContainer` looks
 * containers up by exactly these — which is what lets DevHub answer "is this
 * Workspace's container up?" with one `docker ps` and never spawn the 1.7 MB
 * Node CLI on the happy path.
 */
export const LOCAL_FOLDER_LABEL = "devcontainer.local_folder";

/**
 * The bring-up in flight for each container, and whether it may build: see
 * `ContainerHost.ensureUp`.
 */
const BRINGING_UP = new Map<
	string,
	Promise<{
		readonly result: UpResult;
		readonly remoteUser: string | undefined;
		readonly started: boolean;
	}>
>();
export const CONFIG_FILE_LABEL = "devcontainer.config_file";

/** How this build runs `docker`. */
export interface DockerCli {
	/** The binary, absolute or on `PATH`. */
	readonly path: string;
	/** For tests: how a docker command is run. */
	readonly run?: (
		args: readonly string[],
		stdin?: Uint8Array,
	) => Promise<CommandOutput>;
}

/**
 * One `docker` command on this Mac, bounded like a probe, for callers that
 * have no container host — the state migration, above all.
 */
export function dockerOutput(
	docker: DockerCli,
	args: readonly string[],
	environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CommandOutput> {
	const custom = docker.run;
	if (custom) return custom(args);
	return runBounded(
		{ file: docker.path, args: [...args], cwd: undefined, env: environment },
		OperationDeadline.in(PROBE_TIMEOUT_MS),
		new CancellationToken(),
		PROBE_LIMITS,
		undefined,
	);
}

/** How this build runs `devcontainer`. */
export interface DevContainerCli {
	readonly path: string;
	readonly run?: (args: readonly string[]) => Promise<CommandOutput>;
}

export interface ContainerHostOptions {
	/** Which container: the folder, its machine, and the definition. */
	readonly target: ContainerTarget;
	readonly docker: DockerCli;
	readonly devcontainer: DevContainerCli;
	/**
	 * Where the remote extension host comes from.
	 *
	 * Held on the host and not only passed to `remoteServer`, because the
	 * `devhub` command needs the server's `node` too — it is the only node a
	 * dev container image reliably has. `#ensureServerInstalled` is the one
	 * place that installs it.
	 */
	readonly reh?: RehDelivery | undefined;
	readonly localEnvironment?: Readonly<Record<string, string | undefined>>;
	/** For tests: how a local port for the bridge is picked. */
	readonly listen?: (onConnection: (socket: Socket) => void) => Promise<{
		port: number;
		close: () => void;
	}>;
	/**
	 * Told whenever a bring-up of this host's started the container — whoever
	 * asked for it — so that "DevHub started this one" is known wherever the
	 * container is later let go of. See `stopIfStarted`.
	 */
	readonly onStarted?: (host: ContainerHostId, containerId: string) => void;
}

/** The spec's `shutdownAction`. See `ContainerHost.shutdownAction`. */
export type ShutdownAction = "none" | "stopContainer" | "stopCompose";

/**
 * What `docker ps` said about this Workspace's container.
 *
 * Three states and not two, because "there is no container" and "there is one
 * and it is stopped" are different sentences with different remedies, and a
 * design that folded them together would offer to build an image that is
 * already built.
 */
export type ContainerState =
	| { readonly kind: "absent" }
	| { readonly kind: "stopped"; readonly id: string }
	| {
			readonly kind: "running";
			readonly id: string;
			readonly image: string;
	  };

/** What `devcontainer up` answers with, as far as DevHub reads it. */
interface UpResult {
	readonly containerId: string;
	readonly remoteUser: string;
	readonly remoteWorkspaceFolder: string;
}

/**
 * The relay that runs *inside* the container.
 *
 * Node and not `socat`, because `socat` is in approximately no dev container
 * image and node is in every one DevHub has already put a remote extension host
 * into — the server's own `node`, at a path this file knows. Installing a
 * package into somebody's container to move bytes would be DevHub changing the
 * thing it was asked to connect to.
 *
 * Two directions, one script, chosen by argv: `connect` carries a fresh
 * `docker exec`'s stdio into a socket in the container (the remote extension
 * host), and `listen` accepts on a socket in the container and carries each
 * connection out over the one long-lived exec that started it (DevHub's control
 * socket). They are one file because they are one idea, and two files would be
 * two places to fix the day the framing changes.
 *
 * The `listen` half multiplexes, and that is the only clever thing in here: one
 * exec's stdio has to carry many connections, so each is given a number and
 * every chunk is prefixed with `[id, length]`. `connect` needs none of that —
 * it has an exec to itself.
 */
export const RELAY_SOURCE = `"use strict";
const net = require("node:net");
const mode = process.argv[2];
const target = process.argv[3];
if (mode === "connect") {
  const s = net.connect(target);
  s.on("error", (e) => { process.stderr.write("devhub-relay: " + e.message + "\\n"); process.exit(1); });
  process.stdin.pipe(s);
  s.pipe(process.stdout);
  s.on("close", () => process.exit(0));
  process.stdin.on("end", () => s.end());
} else if (mode === "listen") {
  const HEADER = 8;
  const conns = new Map();
  let next = 1;
  const frame = (id, chunk) => {
    const head = Buffer.alloc(HEADER);
    head.writeUInt32BE(id, 0);
    head.writeUInt32BE(chunk.length, 4);
    process.stdout.write(Buffer.concat([head, chunk]));
  };
  const server = net.createServer((socket) => {
    const id = next++;
    conns.set(id, socket);
    socket.on("data", (chunk) => frame(id, chunk));
    socket.on("close", () => { conns.delete(id); frame(id, Buffer.alloc(0)); });
    socket.on("error", () => {});
  });
  try { require("node:fs").unlinkSync(target); } catch {}
  server.listen(target, () => { try { require("node:fs").chmodSync(target, 0o600); } catch {} });
  let buffered = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < HEADER) return;
      const id = buffered.readUInt32BE(0);
      const length = buffered.readUInt32BE(4);
      if (buffered.length < HEADER + length) return;
      const body = buffered.subarray(HEADER, HEADER + length);
      buffered = buffered.subarray(HEADER + length);
      const socket = conns.get(id);
      if (!socket) continue;
      if (length === 0) socket.end(); else socket.write(Buffer.from(body));
    }
  });
  process.stdin.on("end", () => { server.close(); process.exit(0); });
} else {
  process.stderr.write("devhub-relay: unknown mode\\n");
  process.exit(2);
}
`;

/**
 * The two names a default Dev Container definition may have, in the order the
 * CLI looks for them when it is told none.
 *
 * `.devcontainer/devcontainer.json` first, because it is the one the tooling
 * writes and the one a folder with features and a Dockerfile will have; the
 * single-file `.devcontainer.json` second, for a folder that wanted one line
 * of configuration and no directory.
 */
export const DEV_CONTAINER_CONFIGS = [
	".devcontainer/devcontainer.json",
	".devcontainer.json",
] as const;

/**
 * Every definition a folder has, in the order the spec lists them.
 *
 * The two default names first (`DEV_CONTAINER_CONFIGS`), then the spec's
 * layout for a folder with several — `.devcontainer/<name>/devcontainer.json`,
 * one level deep, by name. Asked every time rather than cached: a definition
 * written since DevHub started is one that can be opened now, and the person
 * who just wrote one would not think to restart.
 *
 * It takes a `Runtime` rather than reading the disk directly because the
 * folder is on whichever machine its Workspace is — this Mac, or a host.
 */
export async function devContainerConfigsIn(
	runtime: Pick<Runtime, "stat" | "readdir">,
	workspaceFolder: string,
): Promise<readonly string[]> {
	const found: string[] = [];
	for (const candidate of DEV_CONTAINER_CONFIGS) {
		const path = posix.join(workspaceFolder, candidate);
		if ((await runtime.stat(path)) === "file") found.push(path);
	}
	const directory = posix.join(workspaceFolder, ".devcontainer");
	if ((await runtime.stat(directory)) !== "directory") return found;
	const named = (await runtime.readdir(directory))
		.filter((entry) => entry.directory)
		.map((entry) => entry.name)
		.sort();
	for (const name of named) {
		const path = posix.join(directory, name, "devcontainer.json");
		if ((await runtime.stat(path)) === "file") found.push(path);
	}
	return found;
}

/** Where the relay is written inside the container. */
function relayPath(home: string): string {
	return posix.join(home, ".devhub-server", "relay.cjs");
}

export class ContainerHost
	extends RemoteShellRuntime
	implements RemoteServerHost
{
	readonly id: ContainerHostId;
	readonly where: string;

	readonly #workspaceFolder: string;
	readonly #configPath: DevContainerConfigPath;
	readonly #docker: DockerCli;
	readonly #devcontainer: DevContainerCli;
	readonly #rehDelivery: RehDelivery | undefined;
	readonly #localEnvironment: Readonly<Record<string, string | undefined>>;
	readonly #listen: ContainerHostOptions["listen"];
	readonly #onStarted: ContainerHostOptions["onStarted"];

	readonly #recentExecs = new RollingTally(A_MINUTE);
	#connected = false;
	/** The container every command in flight is going to. */
	#container: Promise<UpResult> | undefined;
	/** The id `#container` last resolved to, for noticing a rebuild. */
	#containerId: string | undefined;
	#server: Promise<RemoteServerEndpoint> | undefined;
	#bridge: { readonly port: number; readonly close: () => void } | undefined;
	#controlRelay: { readonly stop: () => void } | undefined;
	/** Set once the container id changed underneath this host. */
	#replaced = false;

	constructor(options: ContainerHostOptions) {
		super();
		this.#workspaceFolder = options.target.location.path;
		this.id = containerHostId(options.target);
		this.#configPath = options.target.configPath;
		this.where = ` in ${containerName(this.#workspaceFolder, this.#configPath)}`;
		this.#docker = options.docker;
		this.#devcontainer = options.devcontainer;
		this.#rehDelivery = options.reh;
		this.#localEnvironment = options.localEnvironment ?? process.env;
		this.#listen = options.listen;
		this.#onStarted = options.onStarted;
	}

	protected override get machineName(): string {
		return containerName(this.#workspaceFolder, this.#configPath);
	}

	/**
	 * A container on this Mac is microseconds away, so it is paced like this
	 * machine and not like a host across an ocean.
	 *
	 * `LOCAL_CADENCE` rather than the ssh arithmetic, because the round-trip
	 * that arithmetic exists to respect is a network one and there is no network
	 * here — the docker socket is a unix socket a few hundred microseconds away.
	 * A container reached through a *remote* docker context would need the ssh
	 * treatment, and DevHub does not support one: see `docs/remote-containers.md`.
	 */
	get cadence(): RuntimeCadence {
		return LOCAL_CADENCE;
	}

	/**
	 * No tmux goes into a container: a Workspace's terminals run where its
	 * folder is. Something asking for one is DevHub routing a Workspace's
	 * process to its editor's far end, which is the bug this refuses.
	 */
	protected override delivery(): TmuxDelivery {
		throw notAWorkspaceMachine(this.machineName, "tmux");
	}

	/** One `docker`, with its output bounded like every other command. */
	#docker_(
		args: readonly string[],
		request?: Pick<ExecRequest, "deadline" | "cancel" | "limits" | "stdin">,
	): Promise<CommandOutput> {
		const custom = this.#docker.run;
		if (custom) return custom(args, request?.stdin);
		return runBounded(
			{
				file: this.#docker.path,
				args: [...args],
				cwd: undefined,
				env: this.#localEnvironment,
			},
			request?.deadline ?? OperationDeadline.in(PROBE_TIMEOUT_MS),
			request?.cancel ?? new CancellationToken(),
			request?.limits ?? PROBE_LIMITS,
			request?.stdin,
		);
	}

	/**
	 * What `docker ps` says about this Workspace's container, without the CLI.
	 *
	 * One `docker ps -a` filtered on the label the CLI itself looks containers
	 * up by. This is the poll path — it runs on every reconcile — so it must not
	 * spawn `devcontainer`, which is a 1.7 MB Node bundle and a hundred
	 * milliseconds. `devcontainer up` is for when the answer here is "absent" or
	 * "stopped", and nothing else.
	 */
	async containerState(): Promise<ContainerState> {
		const listed = await this.#docker_([
			"ps",
			"-a",
			// `--no-trunc`, and it is load-bearing rather than tidy. Without it
			// `{{.ID}}` is the *short* twelve-character id, while `devcontainer
			// up` answers with the full sixty-four — so the two ways this runtime
			// learns a container's id spell the same container differently, and
			// the comparison that decides "has this been rebuilt?" reads every
			// restart as a rebuild. One canonical spelling, asked for here.
			"--no-trunc",
			// Both labels, which is how the CLI itself finds its container: a
			// folder with two definitions has a container for each, and the
			// folder alone would name both.
			"--filter",
			`label=${LOCAL_FOLDER_LABEL}=${this.#workspaceFolder}`,
			"--filter",
			`label=${CONFIG_FILE_LABEL}=${this.#configPath}`,
			"--format",
			"{{.ID}}\t{{.State}}\t{{.Image}}",
		]);
		if (listed.code !== 0) {
			throw dockerUnreachable(
				this.#docker.path,
				lastLine(listed.stderr.toString("utf8")),
			);
		}
		const found: { id: string; state: string; image: string }[] = [];
		for (const line of listed.stdout.toString("utf8").split("\n")) {
			const [id = "", state = "", image = ""] = line.split("\t");
			if (id.length === 0) continue;
			// `removing` is a container on its way out; the CLI's own lookup drops
			// those too, and adopting one would be adopting a filesystem that is
			// being deleted underneath every command sent to it.
			if (state === "removing") continue;
			found.push({ id, state, image });
		}
		// The labels are how the CLI and DevHub both find a definition's
		// container, so two of them is a definition with two answers. Taking the
		// first would run every command in one and leave the other going
		// unnoticed — which is how a second container made by a concurrent `up`
		// went on running.
		if (found.length > 1) {
			throw new Error(
				`${String(found.length)} containers carry the labels ` +
					`${LOCAL_FOLDER_LABEL}=${this.#workspaceFolder} and ` +
					`${CONFIG_FILE_LABEL}=${this.#configPath} ` +
					`(${found.map((one) => one.id).join(", ")}), so DevHub cannot ` +
					`tell which is this editor's. Remove the ones that are not ` +
					`with docker rm -f <id>.`,
			);
		}
		const [only] = found;
		if (only === undefined) return { kind: "absent" };
		return only.state === "running"
			? { kind: "running", id: only.id, image: only.image }
			: { kind: "stopped", id: only.id };
	}

	/**
	 * The container this Workspace's commands go to, started if it is not.
	 *
	 * The order is the whole of it, and it is the cheap question first: `docker
	 * ps` on every call, `devcontainer up` only when that says there is nothing
	 * running. `up` is idempotent and would have been correct on its own — it
	 * finds the container by the same labels — but it costs a Node process and a
	 * second of wall clock, on a path that runs every few seconds.
	 *
	 * A container whose id is not the one this runtime has been talking to is a
	 * **rebuild**, and this runtime cannot continue: everything the base class
	 * believes it installed — tmux, the launcher, the server — is in a
	 * filesystem that no longer exists. It says so rather than carrying on, and
	 * the registry builds a new runtime. See `#replaced`.
	 */
	#currentContainer(): Promise<UpResult> {
		const held = this.#container;
		if (held) return held;
		const pending = this.#openContainer();
		pending.catch(() => {
			if (this.#container === pending) this.#container = undefined;
		});
		this.#container = pending;
		return pending;
	}

	async #openContainer(): Promise<UpResult> {
		if (this.#replaced) throw containerReplaced(this.machineName);
		const state = await this.containerState();
		if (state.kind === "running") {
			const adopted = await this.#adopt(state.id);
			if (adopted !== undefined) {
				this.#noteContainer(adopted.result.containerId);
				return adopted.result;
			}
		}
		// Not running, and this is not the path that starts it. Every command
		// DevHub sends the container comes through here, including a resolver
		// retrying a window that lost its connection — so a `devcontainer up`
		// here would restart a container within seconds of a person running
		// `docker stop`, every time, and they could never keep it stopped.
		// Worse, `up` is the call that may rebuild an image, so a retry could
		// start a minutes-long build nobody asked for.
		//
		// So this refuses, in a sentence that names the command. Starting a
		// container is an explicit act and lives in `ensureUp`.
		throw state.kind === "absent"
			? containerNotBuilt(this.#workspaceFolder, this.#configPath)
			: containerNotRunning(this.#workspaceFolder, this.#configPath);
	}

	/**
	 * Start this container if it is stopped, and never build one.
	 *
	 * What a window opening asks for — at launch, when DevHub restores the
	 * editors it had, and on a workbench's first resolve. Those are the
	 * person's standing choice to have this editor in its container, which is
	 * enough to start a container that exists; it is not enough to spend
	 * minutes building an image nobody asked for this time. A container that
	 * was never built refuses, in a sentence that names the command.
	 */
	async prepare(): Promise<void> {
		await this.ensureUp({ build: false });
	}

	/**
	 * Build or start this container, because somebody asked.
	 *
	 * The one place `devcontainer up` is run, and it is deliberately not on any
	 * path a timer can reach. `build: true` is a person saying "reopen this in
	 * its container"; `build: false` is `prepare`.
	 *
	 * Idempotent: a container that is already running is adopted, which costs
	 * the one `docker ps` that `#openContainer` would have cost anyway. It says
	 * whether it was this call that started the container, because a container
	 * DevHub started is one DevHub may stop again (`shutdownAction`), and one it
	 * found running is not.
	 */
	async ensureUp(options: {
		readonly build: boolean;
	}): Promise<{ readonly containerId: string; readonly started: boolean }> {
		if (this.#replaced) throw containerReplaced(this.machineName);
		// One bring-up per container at a time, and every later caller joins it:
		// two `devcontainer up`s started together each create a container, and
		// both carry the same labels. Keyed on the target rather than on this
		// instance, because a host replaced after a rebuild and its replacement
		// are two instances for one target; and on whether it may build, because
		// a start-only caller must not be handed a build it did not ask for, nor
		// a build-allowed one a refusal meant for somebody else. Only the build
		// can create a container, so the two never make one each.
		const key = `${this.id}\0${options.build ? "build" : "start"}`;
		let bringUp = BRINGING_UP.get(key);
		if (bringUp === undefined) {
			const started = this.#bringUp(options.build);
			bringUp = started;
			BRINGING_UP.set(key, started);
			const done = () => {
				if (BRINGING_UP.get(key) === started) BRINGING_UP.delete(key);
			};
			started.then(done, done);
		}
		const { result, started } = await bringUp;
		this.#noteContainer(result.containerId);
		if (started) this.#onStarted?.(this.id, result.containerId);
		this.#container = Promise.resolve(result);
		return { containerId: result.containerId, started };
	}

	/** The running container adopted, or `devcontainer up`'s. */
	async #bringUp(build: boolean): Promise<{
		readonly result: UpResult;
		readonly remoteUser: string | undefined;
		readonly started: boolean;
	}> {
		const state = await this.containerState();
		if (state.kind === "running") {
			const adopted = await this.#adopt(state.id);
			if (adopted !== undefined) return { ...adopted, started: false };
		}
		if (state.kind === "absent" && !build) {
			throw containerNotBuilt(this.#workspaceFolder, this.#configPath);
		}
		// `devcontainer up` is the one thing that knows how to build an image,
		// create a container and run the lifecycle commands the definition asks
		// for, and DevHub has no second opinion about any of that.
		const up = await this.#up();
		return { result: up, remoteUser: up.remoteUser, started: true };
	}

	/** An already-running container, if `$HOME` can still be read in it. */
	async #adopt(
		id: string,
	): Promise<
		| { readonly result: UpResult; readonly remoteUser: string | undefined }
		| undefined
	> {
		const user = await this.#inspectRemoteUser(id);
		const probe = await this.#docker_([
			"exec",
			...(user === undefined ? [] : ["-u", user]),
			"-i",
			id,
			"/bin/sh",
			"-c",
			'printf %s "$HOME"',
		]);
		if (probe.code !== 0) return undefined;
		return {
			result: {
				containerId: id,
				remoteUser: user ?? "",
				// The path inside is the Workspace's, which the location already
				// carries; adoption does not need to rediscover it.
				remoteWorkspaceFolder: "",
			},
			remoteUser: user,
		};
	}

	/**
	 * Which user the definition says commands run as.
	 *
	 * From the container's own metadata label rather than from `devcontainer
	 * read-configuration`, because this runs on the adopt path and the point of
	 * the adopt path is that it costs one `docker` call. A container with
	 * nothing to say leaves it `undefined`, and `docker exec` then uses the
	 * image's own default user — which is what the image author chose.
	 */
	async #inspectRemoteUser(id: string): Promise<string | undefined> {
		const inspected = await this.#docker_([
			"inspect",
			"-f",
			'{{index .Config.Labels "devcontainer.metadata"}}',
			id,
		]);
		if (inspected.code !== 0) return undefined;
		const raw = inspected.stdout.toString("utf8").trim();
		if (raw.length === 0) return undefined;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) return undefined;
			// The metadata is a list of merged fragments and the *last* one that
			// states a `remoteUser` wins, which is the order the CLI merges them
			// in. Reading the first would silently ignore the definition's own
			// override of a feature's default.
			let user: string | undefined;
			for (const entry of parsed) {
				if (typeof entry !== "object" || entry === null) continue;
				const candidate = (entry as { remoteUser?: unknown }).remoteUser;
				if (typeof candidate === "string" && candidate.length > 0) {
					user = candidate;
				}
			}
			return user;
		} catch {
			// A label DevHub cannot parse is a label DevHub has no opinion from,
			// not a failure: the image's default user is a perfectly good answer.
			return undefined;
		}
	}

	/** `devcontainer up`, and its JSON read strictly. */
	async #up(): Promise<UpResult> {
		// `--config` always: the definition is part of which container this
		// is, and leaving the choice to the CLI would let the next `up` answer a
		// folder with several definitions differently from this one.
		// Building an image is not a probe: a first `up` pulls a base image and
		// runs whatever the definition's `postCreateCommand` is, and a minute is
		// not unusual.
		const result = await this.#devcontainerCommand("up", UP_TIMEOUT_MS);
		const stdout = result.stdout.toString("utf8");
		// The CLI prints its log on stderr and exactly one JSON object on stdout,
		// which is the contract this parses. An unrecognised shape is a hard
		// failure naming the CLI, not something to work around: the alternative
		// is carrying on with a container id that is actually an error message.
		const parsed = parseUpOutcome(stdout);
		if (parsed === undefined) {
			throw new Error(
				`devcontainer up did not answer with an outcome DevHub understands ` +
					`for ${this.machineName}. ${describeCliFailure(result, stdout)}`,
			);
		}
		if (parsed.outcome !== "success") {
			throw new Error(
				`${capitalised(this.machineName)} could not be started: ${parsed.message}`,
			);
		}
		return parsed.result;
	}

	/** One `devcontainer <verb>` against this folder and definition. */
	#devcontainerCommand(
		verb: string,
		timeoutMs: number,
	): Promise<CommandOutput> {
		const args = [
			verb,
			"--workspace-folder",
			this.#workspaceFolder,
			"--config",
			this.#configPath,
		];
		const custom = this.#devcontainer.run;
		return custom
			? custom(args)
			: runBounded(
					{
						file: this.#devcontainer.path,
						args,
						cwd: undefined,
						env: this.#localEnvironment,
					},
					OperationDeadline.in(timeoutMs),
					new CancellationToken(),
					{ ...PROBE_LIMITS, stdoutBytes: 1024 * 1024 },
					undefined,
				);
	}

	/**
	 * What the definition says to do with its container when the tool window
	 * that used it closes.
	 *
	 * The spec's `shutdownAction`: `none`, `stopContainer` or `stopCompose`,
	 * defaulting to `stopContainer` for an image or Dockerfile definition and
	 * `stopCompose` for a Docker Compose one. Read with the CLI's own reader
	 * (`read-configuration`) rather than from the JSON, because the default
	 * depends on which kind of definition it is and a definition can extend
	 * others; the CLI is what knows the answer.
	 */
	async shutdownAction(): Promise<ShutdownAction> {
		const result = await this.#devcontainerCommand(
			"read-configuration",
			PROBE_TIMEOUT_MS,
		);
		const stdout = result.stdout.toString("utf8");
		const configuration = parseReadConfiguration(stdout);
		if (configuration === undefined) {
			throw new Error(
				`devcontainer read-configuration did not answer with a configuration ` +
					`DevHub understands for ${this.machineName}. ${describeCliFailure(result, stdout)}`,
			);
		}
		const stated = configuration["shutdownAction"];
		if (stated === undefined) {
			return configuration["dockerComposeFile"] === undefined
				? "stopContainer"
				: "stopCompose";
		}
		if (
			stated === "none" ||
			stated === "stopContainer" ||
			stated === "stopCompose"
		) {
			return stated;
		}
		throw new Error(
			`${capitalised(this.machineName)}'s definition says shutdownAction ` +
				`${JSON.stringify(stated)}, which is not none, stopContainer or stopCompose.`,
		);
	}

	/**
	 * Stop the container if DevHub started it, the way its definition says to.
	 *
	 * `startedContainerId` is the container DevHub's own bring-up started. A
	 * container that is not that one — rebuilt since by somebody else, or one
	 * DevHub only found running — is left alone: stopping what somebody else
	 * started is not DevHub's to decide. So is one that is already stopped.
	 *
	 * Answers what it did, in a sentence, or nothing when there was nothing to
	 * do; a stop that fails throws with Docker's own last line.
	 */
	async stopIfStarted(startedContainerId: string): Promise<string | undefined> {
		const state = await this.containerState();
		if (state.kind !== "running" || state.id !== startedContainerId) {
			return undefined;
		}
		const action = await this.shutdownAction();
		switch (action) {
			case "none":
				return undefined;
			case "stopContainer": {
				const stopped = await this.#docker_(["stop", state.id], {
					deadline: OperationDeadline.in(STOP_TIMEOUT_MS),
					cancel: new CancellationToken(),
					limits: PROBE_LIMITS,
				});
				if (stopped.code !== 0) {
					throw new Error(
						`DevHub could not stop ${this.machineName}: ${lastLine(stopped.stderr.toString("utf8"))}`,
					);
				}
				return `Stopped ${this.machineName}.`;
			}
			case "stopCompose": {
				const project = await this.#docker_([
					"inspect",
					"-f",
					'{{index .Config.Labels "com.docker.compose.project"}}',
					state.id,
				]);
				const name = project.stdout.toString("utf8").trim();
				if (project.code !== 0 || name.length === 0) {
					throw new Error(
						`DevHub could not tell which Compose project ${this.machineName} ` +
							`belongs to, so it did not stop it.`,
					);
				}
				const stopped = await this.#docker_(
					["compose", "--project-name", name, "stop"],
					{
						deadline: OperationDeadline.in(STOP_TIMEOUT_MS),
						cancel: new CancellationToken(),
						limits: PROBE_LIMITS,
					},
				);
				if (stopped.code !== 0) {
					throw new Error(
						`DevHub could not stop the Compose project ${name} of ` +
							`${this.machineName}: ${lastLine(stopped.stderr.toString("utf8"))}`,
					);
				}
				return `Stopped the Compose project ${name} of ${this.machineName}.`;
			}
		}
	}

	/**
	 * Notice a rebuild, once.
	 *
	 * The flag is set and never cleared, and the runtime refuses everything
	 * afterwards, because there is nothing this instance could do that would be
	 * right: its caches describe a filesystem that has been deleted. The
	 * registry's answer is to throw the instance away, which is the only answer
	 * that restores every invariant at once.
	 */
	#noteContainer(id: string): void {
		if (this.#containerId !== undefined && this.#containerId !== id) {
			this.#replaced = true;
			// Thrown here, at the moment the invariant breaks, and not left for
			// the next call to notice. A runtime that answered this one command
			// and refused the next would have done it against a container whose
			// filesystem has none of what this instance believes it installed —
			// and the failure that produced would surface somewhere else
			// entirely, as a missing tmux or a launcher that is not there.
			throw containerReplaced(this.machineName);
		}
		this.#containerId = id;
	}

	/** Whether the container this host was built for has been replaced. */
	get replaced(): boolean {
		return this.#replaced;
	}

	/**
	 * Where this Workspace's folder is mounted inside the container.
	 *
	 * `devcontainer up` says so, and a container that was adopted rather than
	 * started did not — so the mount is read back from the container itself,
	 * which is the answer that is true either way. `docker inspect`'s `Mounts`
	 * is where the bind that carries this folder is written down, and its
	 * `Destination` is the path a workbench opens.
	 *
	 * The fallback is the spec's own default, `/workspaces/<folder name>`,
	 * which is what the CLI uses when the definition names no
	 * `workspaceFolder`. Guessing is worth it here only because the guess is
	 * upstream's documented one and a wrong answer is visible immediately — the
	 * window opens on a folder that is not there — rather than being the kind
	 * of silent wrongness this codebase refuses.
	 */
	async workspacePath(): Promise<string> {
		const workspaceFolder = this.#workspaceFolder;
		const container = await this.#currentContainer();
		if (container.remoteWorkspaceFolder.length > 0) {
			return container.remoteWorkspaceFolder;
		}
		const mounts = await this.#docker_([
			"inspect",
			"-f",
			"{{range .Mounts}}{{.Source}}\t{{.Destination}}\n{{end}}",
			container.containerId,
		]);
		if (mounts.code === 0) {
			for (const line of mounts.stdout.toString("utf8").split("\n")) {
				const [source = "", destination = ""] = line.split("\t");
				if (source === workspaceFolder && destination.length > 0) {
					return destination;
				}
			}
		}
		return posix.join("/workspaces", basenameOf(workspaceFolder));
	}

	protected override async run(request: ExecRequest): Promise<ExecResult> {
		const container = await this.#currentContainer();
		const script = remoteScript(request);
		activityCounters.record(
			COUNTER.process(`${this.id}/${basenameOf(request.argv[0] ?? "")}`),
		);
		this.#recentExecs.record();
		let result: CommandOutput;
		try {
			result = await this.#docker_(
				[
					"exec",
					...(container.remoteUser.length === 0
						? []
						: ["-u", container.remoteUser]),
					"-i",
					container.containerId,
					"/bin/sh",
					"-c",
					script,
				],
				request,
			);
		} catch (failure: unknown) {
			this.#connected = false;
			this.lastFailure = describeFailure(failure);
			throw failure;
		}
		// A container that went away between `docker ps` and `docker exec` is
		// not a command that failed, it is a machine that is no longer there —
		// and the next call must ask again rather than reusing this one.
		if (result.code !== 0 && looksLikeContainerGone(result)) {
			this.#container = undefined;
			this.#connected = false;
			this.lastFailure = lastLine(result.stderr.toString("utf8"));
			console.warn(`[devhub] ${this.id}: ${this.lastFailure}`);
			throw containerNotRunning(this.#workspaceFolder, this.#configPath);
		}
		this.#connected = true;
		if (result.code === 127) {
			const stderr = result.stderr.toString("utf8");
			if (stderr.includes(SCRIPT_MARKER)) {
				throw portFailure("unavailable", { detail: lastLine(stderr) });
			}
		}
		return result;
	}

	/**
	 * No long-lived Workspace process runs in a container: an Agent's stream
	 * runs where its Workspace's folder is. Refused before anything is asked
	 * of the container, not after its login environment has been read. See
	 * `delivery`.
	 */
	override spawnStream(): ByteStream {
		throw notAWorkspaceMachine(this.machineName, "a stream");
	}

	protected override streamLaunch(): Promise<StreamLaunch> {
		return Promise.reject(notAWorkspaceMachine(this.machineName, "a stream"));
	}

	/** No terminal runs in a container either. See `delivery`. */
	spawnPty(): Pty {
		throw notAWorkspaceMachine(this.machineName, "a pseudo-terminal");
	}

	/** Nor is an Agent's program looked for in one. See `delivery`. */
	override resolveProgram(): Promise<never> {
		return Promise.reject(
			notAWorkspaceMachine(this.machineName, "an Agent's program"),
		);
	}

	/** Nor tmux. See `delivery`. */
	override tmuxProgram(): Promise<never> {
		return Promise.reject(notAWorkspaceMachine(this.machineName, "tmux"));
	}

	/**
	 * DevHub's control socket, made answerable inside the container.
	 *
	 * The mirror of the transport bridge and sharing its relay: one long-lived
	 * `docker exec` runs the relay in `listen` mode on a socket in there, and
	 * every connection it accepts is carried out over that exec's stdio and
	 * connected to DevHub's real socket here. That is what makes the `devhub`
	 * shim, `--wait` and the terminal launcher work from a pane in the container
	 * without a single line of them knowing they are in one.
	 *
	 * It answers with a sentence rather than throwing, because the launcher and
	 * the shim are written either way: run from in there they then say what is
	 * wrong in the place the person is actually looking.
	 */
	protected override async publishControlSocket(
		remoteSocketPath: string,
		localSocketPath: string,
	): Promise<string | undefined> {
		this.#controlRelay?.stop();
		this.#controlRelay = undefined;
		let node: string;
		let relay: string;
		try {
			({ node, relay } = await this.#relayPaths());
		} catch (failure: unknown) {
			return (
				`DevHub's control socket could not be published in ${this.machineName}: ` +
				describeFailure(failure)
			);
		}
		const container = await this.#currentContainer();
		const child = this.#spawnRelayExec(container, [
			node,
			relay,
			"listen",
			remoteSocketPath,
		]);
		if (child === undefined) {
			return (
				`DevHub's control socket could not be published in ` +
				`${this.machineName}: the relay could not be started`
			);
		}
		this.#controlRelay = child;
		// Verified, not assumed — the same rule `#forwardControlSocket` learned
		// the hard way about `ssh -O forward`: a relay that started and then
		// failed to bind would leave a shim that hangs, which is the failure
		// with no message.
		const bound = await this.#waitForSocket(remoteSocketPath);
		if (!bound) {
			child.stop();
			this.#controlRelay = undefined;
			return (
				`DevHub started a relay in ${this.machineName} but nothing is ` +
				`listening on ${remoteSocketPath}, so the devhub command in there ` +
				`has nothing to talk to`
			);
		}
		child.connectTo(localSocketPath);
		return undefined;
	}

	/** Whether a socket exists in the container yet. */
	async #waitForSocket(path: string): Promise<boolean> {
		for (let attempt = 0; attempt < SOCKET_ATTEMPTS; attempt++) {
			const probe = await this.sh(`test -S ${shellQuote(path)}`);
			if (probe.code === 0) return true;
			await delay(SOCKET_ATTEMPT_MS);
		}
		return false;
	}

	/**
	 * The relay script and the node that runs it, both in the container.
	 *
	 * The node is the remote extension host's own, which is the same sentence
	 * `terminalLauncher` says about ssh: whoever installed the server owns that
	 * path, and a dev container image is even less likely to have a node on
	 * `PATH` than a NAS is. The script is written with the base class's own
	 * `writeTextFile`, so it travels on stdin like everything else and needs no
	 * `docker cp`.
	 */
	async #relayPaths(): Promise<{ node: string; relay: string }> {
		const home = await this.home();
		const relay = relayPath(home);
		await this.writeTextFile(relay, RELAY_SOURCE, 0o600);
		return {
			node: posix.join(await this.#ensureServerInstalled(), "node"),
			relay,
		};
	}

	/**
	 * The server unpacked in the container, however we got here — and the
	 * install directory, which is where its `node` is.
	 *
	 * Both the resolver and the terminal launcher need this, and they arrive in
	 * either order: the launcher is built when the Workspace's row appears,
	 * which can be well before any window resolves. So it is one idempotent
	 * step that either of them may be the first to take, rather than an
	 * ordering between two callers that nothing enforces.
	 */
	async #ensureServerInstalled(): Promise<string> {
		const held = this.#serverInstall;
		if (held !== undefined) return held;
		const delivery = this.#rehDelivery;
		if (delivery === undefined) {
			throw new Error(
				`the runtime for ${this.machineName} was built without a remote ` +
					`extension host delivery, which is a bug in DevHub and not a fact ` +
					`about that container`,
			);
		}
		const commit = delivery.commit;
		if (commit === undefined) {
			throw permanent(new Error(sourceBuildRefusal(this.machineName)));
		}
		const { home, platform, architecture } = await this.describeRemote();
		const paths = remoteServerPaths({
			home,
			dataFolderName: delivery.dataFolderName,
			applicationName: delivery.applicationName,
			commit,
		});
		await this.#installServer(delivery, paths, platform, architecture);
		this.#serverInstall = paths.install;
		return paths.install;
	}

	/** Where the server was installed, once it has been. */
	#serverInstall: string | undefined;
	/** Where DevHub's `devhub` command is in the container, once installed. */
	#binDirectory: string | undefined;

	/**
	 * The `devhub` command in the container, and the relay it reaches DevHub
	 * through — the same install every machine DevHub shells into gets. The
	 * directory is remembered so the remote extension host is started with it
	 * on its PATH: there is no DevHub tmux in a container to put it there.
	 */
	override async terminalLauncher(
		spec: TerminalLauncherSpec,
	): Promise<TerminalLauncher> {
		const installed = await super.terminalLauncher(spec);
		this.#binDirectory = installed.binDirectory;
		return installed;
	}
	/** The socket it is listening on in there, once it has been started. */
	#serverSocket: string | undefined;

	/**
	 * The remote extension host in this container, and a local port that
	 * reaches it.
	 *
	 * The same four steps as ssh's, with the fourth replaced: install if it is
	 * not there, start it (or adopt the running one) and read its token back out
	 * of its own file, and then — where ssh forwards a socket to a port — stand
	 * up a TCP listener here whose connections are relayed in.
	 *
	 * Cached and verified, for the reason ssh's is: VS Code calls `resolve()`
	 * again on every reconnect, and a lid closed and reopened must not restart
	 * the extension host and every language server with it.
	 */
	async remoteServer(delivery: RehDelivery): Promise<RemoteServerEndpoint> {
		const held = this.#server;
		if (held !== undefined) {
			const endpoint = await held.catch(() => undefined);
			// Verified, not merely remembered — the same rule ssh's `remoteServer`
			// follows, and for a sharper reason here. A `docker stop` and `docker
			// start` leaves this runtime with a bridge that still listens and a
			// container that is running again, so every cheap question says yes
			// while the server inside is gone. The only honest question is
			// whether the endpoint still answers.
			if (endpoint !== undefined && (await this.#endpointAnswers())) {
				return endpoint;
			}
			this.#closeBridge();
			this.#server = undefined;
		}
		const pending = this.#openRemoteServer(delivery);
		pending.catch(() => {
			if (this.#server === pending) this.#server = undefined;
		});
		this.#server = pending;
		return pending;
	}

	/**
	 * Whether the server's socket *inside the container* still accepts.
	 *
	 * The one honest question, and it has to be asked in there. Probing the
	 * bridge's local port proves nothing: the bridge is a `net.Server` on this
	 * Mac that accepts every connection and only then spawns the exec that may
	 * fail — so it answers yes for a container that has been stopped, restarted
	 * and emptied of its server, which is exactly the case this exists to
	 * catch. Connecting to the unix socket is the only thing that distinguishes
	 * "a server is listening" from "a socket file was left behind", and the
	 * `node` to do it with is the server's own.
	 */
	async #socketAccepts(socketPath: string, node: string): Promise<boolean> {
		const probe = await this.sh(
			`exec ${shellQuote(node)} -e 'const s=require("net").connect(process.argv[1]);s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));' ${shellQuote(socketPath)}`,
		);
		return probe.code === 0;
	}

	/** The endpoint this runtime handed out, still good. */
	async #endpointAnswers(): Promise<boolean> {
		const held = this.#serverSocket;
		const install = this.#serverInstall;
		if (this.#bridge === undefined || held === undefined) return false;
		if (install === undefined) return false;
		if ((await this.#currentContainer().catch(() => undefined)) === undefined) {
			return false;
		}
		return this.#socketAccepts(held, posix.join(install, "node"));
	}

	/**
	 * Take away a socket file whose server is gone.
	 *
	 * `startServerScript` decides a server is already running from a socket file
	 * plus a live pid, which is right on a host and not reliable here: a
	 * container restart keeps its filesystem, so both files survive, and pids in
	 * a container's own namespace are small enough that the one in that file is
	 * very likely to belong to something else by then. So the socket is asked
	 * directly, and one that refuses is removed along with the pid file — which
	 * puts the start script back on its "there is nothing here" path.
	 */
	async #clearDeadServer(
		paths: ReturnType<typeof remoteServerPaths>,
		node: string,
	): Promise<void> {
		const present = await this.sh(`test -S ${shellQuote(paths.socket)}`);
		if (present.code !== 0) return;
		if (await this.#socketAccepts(paths.socket, node)) return;
		await this.sh(
			`rm -f -- ${shellQuote(paths.socket)} ${shellQuote(paths.pid)}`,
		);
	}

	async #openRemoteServer(
		delivery: RehDelivery,
	): Promise<RemoteServerEndpoint> {
		const commit = delivery.commit;
		if (commit === undefined) {
			throw permanent(new Error(sourceBuildRefusal(this.machineName)));
		}
		const container = await this.#currentContainer();
		const { home } = await this.describeRemote();
		const paths = remoteServerPaths({
			home,
			dataFolderName: delivery.dataFolderName,
			applicationName: delivery.applicationName,
			commit,
		});
		await this.#ensureServerInstalled();
		await this.#clearDeadServer(paths, posix.join(paths.install, "node"));
		const started = await this.sh(
			startServerScript(paths, this.#binDirectory),
			{
				stdin: Buffer.from(newConnectionToken(), "utf8"),
			},
		);
		if (started.code !== 0) {
			throw new Error(
				`DevHub could not start the remote extension host in ` +
					`${this.machineName}: ${lastLine(started.stderr.toString("utf8"))}`,
			);
		}
		const answer = parseStartedServer(started.stdout.toString("utf8"));
		if (answer === undefined) {
			throw new Error(
				`DevHub started the remote extension host in ${this.machineName} but ` +
					`could not read the socket and token back from it, so there is ` +
					`nothing to connect to`,
			);
		}
		const node = posix.join(paths.install, "node");
		const relay = relayPath(home);
		await this.writeTextFile(relay, RELAY_SOURCE, 0o600);
		this.#serverSocket = answer.socket;
		const port = await this.#openBridge(container, node, relay, answer.socket);
		return {
			port,
			connectionToken: answer.token,
			// Nothing to add. There is no agent to forward into a container:
			// `SSH_AUTH_SOCK` on this Mac names a socket the container cannot
			// reach, and stating it would point the extension host at a path that
			// is not there — a failure that reads as "the agent is broken".
			extensionHostEnv: undefined,
		};
	}

	/** The tarball, fetched here and unpacked there — once. */
	async #installServer(
		delivery: RehDelivery,
		paths: ReturnType<typeof remoteServerPaths>,
		platform: string,
		architecture: string,
	): Promise<void> {
		const present = await this.sh(`test -x ${shellQuote(paths.server)}`);
		if (present.code === 0) return;
		const target = `${platformName(platform)}-${architecture}`;
		const tarball = await delivery.tarball(target);
		const unpacked = await this.sh(
			unpackServerScript(paths, tarball.topLevelDirectory),
			{ stdin: tarball.bytes },
		);
		if (unpacked.code !== 0) {
			throw new Error(
				`DevHub could not unpack the remote extension host in ` +
					`${this.machineName}: ${lastLine(unpacked.stderr.toString("utf8"))}`,
			);
		}
	}

	/**
	 * A TCP port on this Mac that speaks to the socket in the container.
	 *
	 * One `docker exec` per accepted connection, which sounds extravagant and is
	 * not: a workbench opens a handful — the management connection, the
	 * extension host, one per terminal — and a `docker exec` is a few tens of
	 * milliseconds against a local daemon. The alternative, multiplexing them all
	 * down one exec, is the framing the `listen` half of the relay has to do, and
	 * it buys nothing here because nothing needs it.
	 */
	async #openBridge(
		container: UpResult,
		node: string,
		relay: string,
		socketPath: string,
	): Promise<number> {
		this.#closeBridge();
		const onConnection = (socket: Socket): void => {
			const child = this.#spawnRelayExec(container, [
				node,
				relay,
				"connect",
				socketPath,
			]);
			if (child === undefined) {
				socket.destroy();
				return;
			}
			child.pipe(socket);
		};
		const listener = this.#listen
			? await this.#listen(onConnection)
			: await listenOnLoopback(onConnection);
		this.#bridge = listener;
		return listener.port;
	}

	#closeBridge(): void {
		this.#bridge?.close();
		this.#bridge = undefined;
	}

	/**
	 * One `docker exec -i` running the relay, as a pair of streams.
	 *
	 * Returned as a small object rather than a `ChildProcess` because there are
	 * two callers with two shapes — one pipes it straight at a socket, the other
	 * multiplexes many sockets over it — and a raw child would have both of them
	 * reaching into the same three streams in different ways.
	 */
	#spawnRelayExec(
		container: UpResult,
		argv: readonly string[],
	): RelayExec | undefined {
		return spawnRelay(
			this.#docker.path,
			[
				"exec",
				...(container.remoteUser.length === 0
					? []
					: ["-u", container.remoteUser]),
				"-i",
				container.containerId,
				...argv,
			],
			this.#localEnvironment,
		);
	}

	reading(): RuntimeReading {
		return {
			id: this.id,
			connected: this.#connected,
			// No ControlMaster and nothing to multiplex: the docker daemon is a
			// local socket with no per-connection session limit, so the three
			// numbers that exist to explain sshd's limit are zero here, and that
			// is a fact about the transport rather than a gap in the reading.
			masterPid: undefined,
			medianRoundTripMs: 0,
			reconcileIntervalMs: this.cadence.reconcileIntervalMs,
			execsLastMinute: this.#recentExecs.count(),
			muxSessionsHeld: 0,
			muxSessionsWaiting: 0,
			muxFallbacks: 0,
			loginEnvironmentNames: Object.keys(this.login ?? {}).sort(),
			lastFailure: this.lastFailure,
		};
	}

	/**
	 * This Mac woke up, and Docker may not have.
	 *
	 * There is no master to drop, but there is a container that may have been
	 * stopped under a sleeping Mac — by Docker Desktop shutting down, or by the
	 * person. So the cached answer is dropped and the next command asks `docker
	 * ps` again, which is cheap and is the only thing that could have changed.
	 * The bridge and the control relay go with it: both are `docker exec`
	 * processes against a container that may no longer be running, and a relay
	 * held open against a corpse is what makes a reconnect hang instead of
	 * failing.
	 */
	resumed(): void {
		this.#container = undefined;
		this.forgetRemote();
		this.#closeBridge();
		this.#controlRelay?.stop();
		this.#controlRelay = undefined;
		this.#server = undefined;
	}

	async dispose(): Promise<void> {
		this.#closeBridge();
		this.#controlRelay?.stop();
		this.#controlRelay = undefined;
		this.#container = undefined;
		this.#server = undefined;
	}
}

/** How long `devcontainer up` is given: an image pull plus post-create. */
const UP_TIMEOUT_MS = 10 * 60 * 1000;
/** `docker stop` waits ten seconds for a container before it kills it. */
const STOP_TIMEOUT_MS = 60 * 1000;
const SOCKET_ATTEMPTS = 30;
const SOCKET_ATTEMPT_MS = 200;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function basenameOf(path: string): string {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Whether docker said the container is gone rather than that the command
 * failed.
 *
 * Matched on docker's own words, which is a thing to be uneasy about — but the
 * alternative is treating every non-zero exit as a machine that vanished, which
 * would throw away the cached container on every failing `git` command. The
 * exit code does not distinguish them: `docker exec` returns the command's code
 * when it ran and 1 or 125 when it could not, and 1 is also what half of the
 * commands DevHub runs return for ordinary reasons.
 */
function looksLikeContainerGone(result: { readonly stderr: Buffer }): boolean {
	const stderr = result.stderr.toString("utf8");
	return (
		stderr.includes("is not running") ||
		stderr.includes("No such container") ||
		stderr.includes("no such container")
	);
}

/**
 * The docker daemon is not answering, said once and by name.
 *
 * A `PortFailure` and not a bare `Error`, because that is what decides whether
 * the sentence reaches the person at all: a machine-wide reconcile round that
 * throws becomes a machine condition, and `portRefusal` carries a `detail`
 * through only from a `PortFailure`. Anything else arrives as the bare "DevHub
 * is not getting an answer from container:…", which names the machine and
 * nothing to do about it.
 *
 * The detail is DevHub's own sentence and never docker's output — the rule
 * `PortFailure.detail` states. So it names the binary that was run, because the
 * two things that produce this are a Docker that is not started and a Docker
 * that is not installed, and it names the remedy. What docker itself said goes
 * to the log, where a second reason is worth having and a condition is not the
 * place for it.
 */
export function dockerUnreachable(path: string, said: string): Error {
	if (said.length > 0) {
		console.warn(`[devhub] ${path}: ${said}`);
	}
	return portFailure("unavailable", {
		detail:
			`DevHub could not reach the Docker daemon with ${path}. ` +
			`Start Docker and it will reconnect by itself.`,
	});
}

/**
 * The container is there and not running, with the command that starts it.
 *
 * A condition carries a sentence and no action — `machineConditions.ts`
 * publishes a summary string, and there is nowhere on it for a button. So the
 * sentence has to be the action: it names the exact command, with this
 * Workspace's folder already in it, so that the remedy is something to copy
 * rather than something to work out.
 */
export function containerNotRunning(
	workspaceFolder: string,
	configPath: string,
): Error {
	return portFailure("unavailable", {
		detail:
			`${capitalised(containerName(workspaceFolder, configPath))} is not running. ` +
			`Start it with: ${upCommand(workspaceFolder, configPath)}`,
	});
}

/**
 * There is no container for this folder yet, with the command that makes one.
 *
 * Separate from "not running" because they are different sentences with
 * different remedies, and folding them together would offer to build an image
 * that is already built — or, worse, tell somebody to start a container that
 * does not exist.
 */
export function containerNotBuilt(
	workspaceFolder: string,
	configPath: string,
): Error {
	return portFailure("unavailable", {
		detail:
			`${capitalised(containerName(workspaceFolder, configPath))} has not been built yet. ` +
			`Build it with: ${upCommand(workspaceFolder, configPath)}`,
	});
}

/** The command a person runs to bring this container up, spelled whole. */
function upCommand(workspaceFolder: string, configPath: string): string {
	return `devcontainer up --workspace-folder ${shellQuote(workspaceFolder)} --config ${shellQuote(configPath)}`;
}

/** The container this host was built for has been rebuilt. */
export function containerReplaced(machineName: string): Error {
	return portFailure("unavailable", {
		detail:
			`${capitalised(machineName)} has been rebuilt, so this connection to ` +
			`the old one cannot be used. DevHub will reconnect to the new one.`,
	});
}

/**
 * What to call a container in a sentence.
 *
 * The folder, which is the name the person chose; and the definition when it
 * is not the folder's default one, because a folder with two definitions has
 * two containers and a sentence about "the dev container for api" would not
 * say which.
 */
export function containerName(
	workspaceFolder: string,
	configPath: string,
): string {
	const label = devContainerConfigLabel(
		workspaceRoot(workspaceFolder),
		devContainerConfigPath(configPath),
	);
	return label === undefined
		? `the dev container for ${workspaceFolder}`
		: `the dev container for ${workspaceFolder} (${label})`;
}

function capitalised(sentence: string): string {
	return sentence.length === 0
		? sentence
		: `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}`;
}

/**
 * A Workspace's process routed to its editor's container: the invariant this
 * whole model rests on, broken. Thrown, never answered, because a terminal or
 * an Agent that quietly ran in the container would be running somewhere other
 * than the machine every other part of DevHub says it is on.
 */
function notAWorkspaceMachine(machineName: string, what: string): Error {
	return new Error(
		`DevHub asked for ${what} in ${machineName}, and nothing a Workspace ` +
			`owns runs in a dev container — only its editor is attached there. ` +
			`This is a bug in DevHub.`,
	);
}

/**
 * `devcontainer read-configuration`'s `configuration` object, or `undefined`
 * for anything else. The CLI prints one JSON object on stdout, as `up` does.
 */
export function parseReadConfiguration(
	stdout: string,
): Record<string, unknown> | undefined {
	const line = stdout.trim().split("\n").at(-1) ?? "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const configuration = (parsed as { configuration?: unknown }).configuration;
	return typeof configuration === "object" &&
		configuration !== null &&
		!Array.isArray(configuration)
		? (configuration as Record<string, unknown>)
		: undefined;
}

/** `devcontainer up`'s answer, as far as DevHub reads it. */
export function parseUpOutcome(
	stdout: string,
):
	| { outcome: "success"; result: UpResult }
	| { outcome: "error"; message: string }
	| undefined {
	// The CLI prints its log on stderr and one JSON object on stdout, but a
	// stray line before it is cheap to survive and expensive to be wrong about,
	// so the *last* non-empty line is the one read.
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const last = lines.at(-1);
	if (last === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(last);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const object = parsed as Record<string, unknown>;
	const outcome = object["outcome"];
	if (outcome === "error") {
		const message = object["message"];
		const description = object["description"];
		return {
			outcome: "error",
			message:
				typeof description === "string" && description.length > 0
					? description
					: typeof message === "string" && message.length > 0
						? message
						: "the devcontainer CLI gave no reason",
		};
	}
	if (outcome !== "success") return undefined;
	const containerId = object["containerId"];
	if (typeof containerId !== "string" || containerId.length === 0) {
		return undefined;
	}
	const remoteUser = object["remoteUser"];
	const remoteWorkspaceFolder = object["remoteWorkspaceFolder"];
	return {
		outcome: "success",
		result: {
			containerId,
			remoteUser: typeof remoteUser === "string" ? remoteUser : "",
			remoteWorkspaceFolder:
				typeof remoteWorkspaceFolder === "string" ? remoteWorkspaceFolder : "",
		},
	};
}

/** What to say about a CLI that answered with something unreadable. */
function describeCliFailure(result: CommandOutput, stdout: string): string {
	const stderr = lastLine(result.stderr.toString("utf8"));
	if (stderr.length > 0) return stderr;
	const said = lastLine(stdout);
	return said.length > 0 ? said : `it exited ${String(result.code)}`;
}

/** One `docker exec` running the relay, as streams. */
export interface RelayExec {
	/** Carry this exec's stdio straight to a socket, both ways. */
	pipe(socket: Socket): void;
	/**
	 * Carry every connection this exec's `listen` relay accepts to a unix
	 * socket on this Mac.
	 */
	connectTo(localSocketPath: string): void;
	stop(): void;
}

/**
 * A `docker exec -i` whose stdio is the wire.
 *
 * `spawn` is imported at the top and not reached for lazily. The packaged main
 * process is one esbuild ESM bundle, and a `require()` inside one is a
 * `Dynamic require of "node:child_process" is not supported` at the moment the
 * first workbench connects — which is to say in the packaged app only, and
 * never in a test.
 */
function spawnRelay(
	file: string,
	args: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): RelayExec | undefined {
	const child = spawn(file, [...args], {
		stdio: ["pipe", "pipe", "pipe"],
		env: env as NodeJS.ProcessEnv,
	});
	if (child.stdin === null || child.stdout === null) return undefined;
	const stdin = child.stdin;
	const stdout = child.stdout;
	let stopped = false;
	child.stderr?.on("data", (chunk: Buffer) => {
		console.warn(`[devhub] container relay: ${chunk.toString("utf8").trim()}`);
	});
	return {
		pipe(socket: Socket): void {
			socket.pipe(stdin);
			stdout.pipe(socket);
			socket.on("error", () => child.kill());
			child.on("exit", () => socket.destroy());
		},
		connectTo(localSocketPath: string): void {
			const HEADER = 8;
			const open = new Map<number, Socket>();
			let buffered = Buffer.alloc(0);
			const frame = (id: number, chunk: Buffer): void => {
				const head = Buffer.alloc(HEADER);
				head.writeUInt32BE(id, 0);
				head.writeUInt32BE(chunk.length, 4);
				stdin.write(Buffer.concat([head, chunk]));
			};
			stdout.on("data", (chunk: Buffer) => {
				buffered = Buffer.concat([buffered, chunk]);
				for (;;) {
					if (buffered.length < HEADER) return;
					const id = buffered.readUInt32BE(0);
					const length = buffered.readUInt32BE(4);
					if (buffered.length < HEADER + length) return;
					const body = buffered.subarray(HEADER, HEADER + length);
					buffered = buffered.subarray(HEADER + length);
					let socket = open.get(id);
					if (socket === undefined) {
						if (length === 0) continue;
						socket = connect(localSocketPath);
						open.set(id, socket);
						socket.on("data", (out: Buffer) => frame(id, out));
						socket.on("close", () => {
							open.delete(id);
							frame(id, Buffer.alloc(0));
						});
						socket.on("error", () => {});
					}
					if (length === 0) socket.end();
					else socket.write(Buffer.from(body));
				}
			});
		},
		stop(): void {
			if (stopped) return;
			stopped = true;
			child.kill();
		},
	};
}

/** A listener on 127.0.0.1 on a port the OS picked. */
function listenOnLoopback(
	onConnection: (socket: Socket) => void,
): Promise<{ port: number; close: () => void }> {
	return new Promise((resolve, reject) => {
		const server: Server = createServer(onConnection);
		server.on("error", reject);
		// Loopback and never `0.0.0.0`: the connection token is the only thing
		// between this port and an extension host, and a port bound to every
		// interface is that token on the network.
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("the container bridge did not get a port"));
				return;
			}
			resolve({ port: address.port, close: () => server.close() });
		});
	});
}
