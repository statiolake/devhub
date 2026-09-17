/**
 * A Dev Container as a machine DevHub shells into.
 *
 * The claim this file rests on, and the reason it is a fifth of the size of
 * `ssh.ts`: **a container is not a new kind of runtime, it is `SshRuntime` with
 * `docker exec` where `ssh` is.** Both are "run a POSIX `sh` on another
 * machine, over a connection this Mac holds". Everything that was about
 * *shells* rather than about *ssh* already moved into `RemoteShellRuntime` —
 * the login-environment probe, the `sh`-based file operations, the git-refs
 * digest, the terminal launcher, the tmux install — so what is left here is the
 * four members that base class asks for, plus the two things docker does
 * differently from ssh and cannot be given for free.
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
 * **Git is not here.** It runs on this Mac, against the bind-mounted folder;
 * `gitPlaceOf` in `model/domain.ts` is that decision and its reasons. This
 * runtime is what terminals and Agents run on, which is the whole point of a
 * dev container.
 *
 * **The container id is not the identity.** A rebuild is routine — it is what
 * dev containers are *for* — and it produces a new container with a new
 * filesystem and none of what DevHub installed. So the machine is the folder on
 * this Mac (`containerMachine`), and this runtime notices when the container
 * underneath it has been replaced and says so; `registry.ts` disposes it and
 * builds another, because every "installed once per machine" cache in the base
 * class is keyed on the instance.
 */

import { Buffer } from "node:buffer";
import { createServer, connect, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { posix } from "node:path";
import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import { RollingTally } from "../diagnostics/rollingTally.js";
import {
	OperationDeadline,
	runBounded,
	type CommandOutput,
} from "../terminal/command.js";
import { CancellationToken, portFailure } from "../terminal/ports.js";
import { openPty, type Pty, type PtyFactory } from "../terminal/pty.js";
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
import type {
	ExecRequest,
	ExecResult,
	PtyRequest,
	RuntimeCadence,
	RuntimeId,
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

/** How this build runs `devcontainer`. */
export interface DevContainerCli {
	readonly path: string;
	readonly run?: (args: readonly string[]) => Promise<CommandOutput>;
}

export interface ContainerRuntimeOptions {
	/** The folder on this Mac, which is this machine's identity. */
	readonly workspaceFolder: string;
	/** The definition, when the person chose one other than the default. */
	readonly configPath?: string | undefined;
	readonly docker: DockerCli;
	readonly devcontainer: DevContainerCli;
	readonly tmux?: TmuxDelivery | undefined;
	readonly ptyFactory?: PtyFactory;
	readonly localEnvironment?: Readonly<Record<string, string | undefined>>;
	/** For tests: how a local port for the bridge is picked. */
	readonly listen?: (onConnection: (socket: Socket) => void) => Promise<{
		port: number;
		close: () => void;
	}>;
}

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

/** Where the relay is written inside the container. */
function relayPath(home: string): string {
	return posix.join(home, ".devhub-server", "relay.cjs");
}

export class ContainerRuntime
	extends RemoteShellRuntime
	implements RemoteServerHost
{
	readonly id: RuntimeId;
	readonly where: string;

	readonly #workspaceFolder: string;
	readonly #configPath: string | undefined;
	readonly #docker: DockerCli;
	readonly #devcontainer: DevContainerCli;
	readonly #tmuxDelivery: TmuxDelivery | undefined;
	readonly #ptyFactory: PtyFactory;
	readonly #localEnvironment: Readonly<Record<string, string | undefined>>;
	readonly #listen: ContainerRuntimeOptions["listen"];

	readonly #recentExecs = new RollingTally(A_MINUTE);
	#connected = false;
	/** The container every command in flight is going to. */
	#container: Promise<UpResult> | undefined;
	/** The id `#container` last resolved to, for noticing a rebuild. */
	#containerId: string | undefined;
	#remoteUser: string | undefined;
	#server: Promise<RemoteServerEndpoint> | undefined;
	#bridge: { readonly port: number; readonly close: () => void } | undefined;
	#controlRelay: { readonly stop: () => void } | undefined;
	/** Set once the container id changed underneath this runtime. */
	#replaced = false;

	constructor(options: ContainerRuntimeOptions) {
		super();
		this.#workspaceFolder = options.workspaceFolder;
		this.id = `container:${options.workspaceFolder}`;
		this.where = ` in the dev container for ${options.workspaceFolder}`;
		this.#configPath = options.configPath;
		this.#docker = options.docker;
		this.#devcontainer = options.devcontainer;
		this.#tmuxDelivery = options.tmux;
		this.#ptyFactory = options.ptyFactory ?? openPty;
		this.#localEnvironment = options.localEnvironment ?? process.env;
		this.#listen = options.listen;
	}

	protected override get machineName(): string {
		return `the dev container for ${this.#workspaceFolder}`;
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

	protected override delivery(): TmuxDelivery {
		const delivery = this.#tmuxDelivery;
		if (delivery === undefined) {
			throw new Error(
				`the runtime for ${this.machineName} was built without a tmux ` +
					`delivery, which is a bug in DevHub and not a fact about that ` +
					`container`,
			);
		}
		return delivery;
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
			"--filter",
			`label=${LOCAL_FOLDER_LABEL}=${this.#workspaceFolder}`,
			"--format",
			"{{.ID}}\t{{.State}}\t{{.Image}}",
		]);
		if (listed.code !== 0) {
			throw dockerUnreachable(
				this.#docker.path,
				lastLine(listed.stderr.toString("utf8")),
			);
		}
		for (const line of listed.stdout.toString("utf8").split("\n")) {
			const [id = "", state = "", image = ""] = line.split("\t");
			if (id.length === 0) continue;
			// `removing` is a container on its way out; the CLI's own lookup drops
			// those too, and adopting one would be adopting a filesystem that is
			// being deleted underneath every command sent to it.
			if (state === "removing") continue;
			return state === "running"
				? { kind: "running", id, image }
				: { kind: "stopped", id };
		}
		return { kind: "absent" };
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
		if (this.#replaced) throw containerReplaced(this.#workspaceFolder);
		const state = await this.containerState();
		if (state.kind === "running") {
			const adopted = await this.#adopt(state.id);
			if (adopted) return adopted;
		}
		// Absent, stopped, or running but not answering. `devcontainer up` is the
		// one thing that knows how to build an image, create a container and run
		// the lifecycle commands the definition asks for, and DevHub does not
		// have a second opinion about any of that.
		const up = await this.#up();
		this.#noteContainer(up.containerId);
		this.#remoteUser = up.remoteUser;
		return up;
	}

	/** An already-running container, if `$HOME` can still be read in it. */
	async #adopt(id: string): Promise<UpResult | undefined> {
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
		this.#noteContainer(id);
		this.#remoteUser = user;
		return {
			containerId: id,
			remoteUser: user ?? "",
			// The path inside is the Workspace's, which the location already
			// carries; adoption does not need to rediscover it.
			remoteWorkspaceFolder: "",
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
			"{{index .Config.Labels \"devcontainer.metadata\"}}",
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
		const args = [
			"up",
			"--workspace-folder",
			this.#workspaceFolder,
			...(this.#configPath === undefined
				? []
				: ["--config", this.#configPath]),
		];
		const custom = this.#devcontainer.run;
		const result = custom
			? await custom(args)
			: await runBounded(
					{
						file: this.#devcontainer.path,
						args,
						cwd: undefined,
						env: this.#localEnvironment,
					},
					// Building an image is not a probe: a first `up` pulls a base
					// image and runs whatever the definition's `postCreateCommand`
					// is, and a minute is not unusual.
					OperationDeadline.in(UP_TIMEOUT_MS),
					new CancellationToken(),
					{ ...PROBE_LIMITS, stdoutBytes: 1024 * 1024 },
					undefined,
				);
		const stdout = result.stdout.toString("utf8");
		// The CLI prints its log on stderr and exactly one JSON object on stdout,
		// which is the contract this parses. An unrecognised shape is a hard
		// failure naming the CLI, not something to work around: the alternative
		// is carrying on with a container id that is actually an error message.
		const parsed = parseUpOutcome(stdout);
		if (parsed === undefined) {
			throw new Error(
				`devcontainer up did not answer with an outcome DevHub understands ` +
					`for ${this.#workspaceFolder}. ${describeCliFailure(result, stdout)}`,
			);
		}
		if (parsed.outcome !== "success") {
			throw new Error(
				`The dev container for ${this.#workspaceFolder} could not be ` +
					`started: ${parsed.message}`,
			);
		}
		return parsed.result;
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
		}
		this.#containerId = id;
	}

	/** Whether the container this runtime was built for has been replaced. */
	get replaced(): boolean {
		return this.#replaced;
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
			throw new Error(
				`The dev container for ${this.#workspaceFolder} is no longer ` +
					`running: ${this.lastFailure}`,
			);
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
	 * A pseudo-terminal in the container.
	 *
	 * `docker exec -it` where ssh has `-tt`, and for the same reason: the far
	 * side needs a real tty or tmux refuses to attach. Everything above `Pty` —
	 * resize, data, exit — is the same three events it was.
	 */
	spawnPty(request: PtyRequest): Pty {
		const login = this.login;
		const id = this.#containerId;
		if (login === undefined || id === undefined) {
			throw new Error(
				`a pseudo-terminal was asked for in ${this.machineName} before ` +
					`DevHub had reached it, so the program in it would run without ` +
					`the PATH the container's own shell has`,
			);
		}
		const script = remoteScript({
			argv: [request.file, ...request.args],
			cwd: request.cwd,
			env: { ...login, ...request.env },
		});
		const user = this.#remoteUser;
		return this.#ptyFactory({
			file: this.#docker.path,
			args: [
				"exec",
				...(user === undefined ? [] : ["-u", user]),
				"-it",
				id,
				"/bin/sh",
				"-c",
				script,
			],
			// The docker client runs here; the `cd` is in the script.
			cwd: homedir(),
			cols: request.cols,
			rows: request.rows,
			pixelWidth: request.pixelWidth,
			pixelHeight: request.pixelHeight,
			env: this.#localEnvironment,
		});
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
		const server = this.#serverInstall;
		if (server === undefined) {
			throw new Error(
				"the remote extension host has not been installed in this container " +
					"yet, so there is no node in it to run DevHub's relay",
			);
		}
		return { node: posix.join(server, "node"), relay };
	}

	/** Where the server was installed, once it has been. */
	#serverInstall: string | undefined;

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
			if (endpoint !== undefined && this.#bridge !== undefined) {
				const container = await this.#currentContainer().catch(() => undefined);
				if (container !== undefined) return endpoint;
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

	async #openRemoteServer(
		delivery: RehDelivery,
	): Promise<RemoteServerEndpoint> {
		const commit = delivery.commit;
		if (commit === undefined) {
			throw permanent(new Error(sourceBuildRefusal(this.machineName)));
		}
		const container = await this.#currentContainer();
		const { home, platform, architecture } = await this.describeRemote();
		const paths = remoteServerPaths({
			home,
			dataFolderName: delivery.dataFolderName,
			applicationName: delivery.applicationName,
			commit,
		});
		await this.#installServer(delivery, paths, platform, architecture);
		this.#serverInstall = paths.install;
		const started = await this.sh(startServerScript(paths), {
			stdin: Buffer.from(newConnectionToken(), "utf8"),
		});
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
function looksLikeContainerGone(result: CommandOutput): boolean {
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
 * It names the binary it ran, because the two things that produce this are a
 * Docker that is not started and a Docker that is not installed, and the person
 * can tell which from the sentence docker itself printed.
 */
export function dockerUnreachable(path: string, said: string): Error {
	return new Error(
		`DevHub could not reach the Docker daemon with ${path}` +
			(said.length === 0 ? "" : `: ${said}`),
	);
}

/** The container this runtime was built for has been rebuilt. */
export function containerReplaced(workspaceFolder: string): Error {
	return new Error(
		`The dev container for ${workspaceFolder} has been rebuilt, so this ` +
			`connection to the old one cannot be used`,
	);
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
 * Imported lazily so that this module can be loaded — and its parsing tested —
 * in a process with no `child_process`, which is the same reason `registry.ts`
 * takes its profile rather than reading Electron's.
 */
function spawnRelay(
	file: string,
	args: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): RelayExec | undefined {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { spawn } = require("node:child_process") as typeof import("node:child_process");
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
