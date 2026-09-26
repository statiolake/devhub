/**
 * The one switch on where a Workspace's folder is.
 *
 * The rule the whole runtime module exists to make enforceable: **`kind ===
 * "ssh"` appears in exactly one place in `main/`, and it is `runtimeFor`.**
 * Nowhere else does a code path branch on which machine a folder is on. Local
 * is today's code behind the `Runtime` interface; remote will be one more
 * implementation of the same interface. If a feature works locally and not
 * remotely, the difference has to be nameable inside the remote runtime — not
 * scattered across the forty call sites that used to spawn directly.
 *
 * It is a function and not a lookup because a caller must not be able to hold
 * a runtime that no longer matches its Workspace: a Workspace can be relocated,
 * and a stored runtime would be a second answer to "which machine" with no way
 * to tell which of the two had gone stale.
 */

import {
	containerHostId,
	containerTargetFromHostId,
	remoteAuthorityOf,
	sshHost,
	workspaceRoot,
	type ContainerHostId,
	type ContainerTarget,
	type RequestedLocation,
	type WorkspaceLocation,
	type WorkspaceRoot,
} from "../../model/domain.js";
import {
	ContainerHost,
	type DevContainerCli,
	type DockerCli,
} from "./container.js";
import { LocalRuntime } from "./local.js";
import type { Runtime, RuntimeId } from "./runtime.js";
import type { RehDelivery, RemoteServerHost } from "./remoteServer.js";
import { chooseControlDirectory, SshRuntime } from "./ssh.js";
import type { TmuxDelivery } from "./tmuxDelivery.js";

/**
 * This machine. One instance, because there is one of it.
 *
 * Its counters and its latency window are per-instance, so a second one would
 * split the reading `devhub --metrics` prints in half.
 */
const LOCAL = new LocalRuntime();

/**
 * One runtime per host, because there is one connection per host.
 *
 * The cache is not an optimisation. An `SshRuntime` *owns* something — a
 * multiplexed connection, a `$HOME`, a window of round-trip times — and two of
 * them for one host would be two masters, two caches and a `devhub --metrics`
 * that reported half the truth twice.
 */
const SSH = new Map<string, SshRuntime>();

/**
 * One host per dev container DevHub has been asked to reach, keyed on its
 * `ContainerHostId` — the folder, its machine and its definition.
 *
 * Keyed on the target and not on the container id: a rebuild hands back a new
 * container and must not hand back a new key. The host behind the key is what
 * notices the container underneath it changed, and `containerHostFor` is how it
 * is replaced when it has — every "installed once" cache inside it (the
 * server, the relay, the `devhub` command) is keyed on the instance, so a
 * rebuilt container needs a new instance or it will go on believing it
 * installed things into a filesystem that no longer exists.
 *
 * These are not runtimes. Nothing a Workspace owns runs in a container — its
 * terminals and Agents run where its folder is — so no `RuntimeId` names one,
 * and `runtimeFor` never returns one.
 */
const CONTAINERS = new Map<ContainerHostId, ContainerHost>();

/**
 * Where this DevHub keeps its own files, told rather than discovered.
 *
 * The one thing a remote runtime needs that is not on the location: the
 * directory its control socket is bound under, which is a property of the
 * *profile* — every other resource DevHub keys on the profile, and a second
 * DevHub must not adopt the first one's connection.
 *
 * It is injected rather than read from `app.getPath("userData")` because this
 * module is imported by `pty.ts`'s callers and therefore by the PTY test
 * program, which runs without Electron's named exports: a module that needs
 * Electron *at import time* makes every importer of it need one too, and the
 * failure lands in a test program that has nothing to do with ssh. The
 * argument is also the seam the control-path arithmetic already wanted — a
 * test names two temp directories and gets the real answer for both.
 */
export interface RuntimeProfile {
	/** This profile's user-data directory. */
	readonly userDataDirectory: string;
	/** `$HOME` on this machine, for the short control-path fallback. */
	readonly home: string;
	/**
	 * Where the tmux DevHub installs on a host comes from.
	 *
	 * On the profile rather than on the location because the download is cached
	 * under this profile's own data directory, and because it is one statement
	 * of one product fact — the release the app was built against — rather than
	 * a thing each host could be given a different answer to.
	 */
	readonly tmux: TmuxDelivery;
	/**
	 * Where the remote extension host DevHub installs on a machine comes from.
	 *
	 * Beside `tmux` and for the same reasons: it is one statement of one product
	 * fact — the release this build was made against — cached under this
	 * profile's own data directory, and read here rather than in
	 * `main/runtime/` so that nothing under it needs Electron at import time.
	 */
	readonly reh: RehDelivery;
	/**
	 * How this DevHub runs `docker`, and how it runs `devcontainer`, on this
	 * Mac.
	 *
	 * On the profile beside `tmux` and `reh` and for the same reason: both are
	 * one statement of one product fact — which binary this build drives — made
	 * once, where a test can state a different one. They are separate because
	 * they are separately absent: a Mac can have Docker and no `devcontainer`
	 * CLI, and the two refusals name different things to install.
	 */
	readonly docker: DockerCli;
	readonly devcontainer: DevContainerCli;
}

let profile: RuntimeProfile | undefined;

/**
 * Say which profile is running, once, before anything asks for a runtime.
 *
 * `createAppController` calls it with the same `userDataPath` it files state
 * and settings under. Calling it twice is a bug rather than a reconfiguration:
 * a control socket that moved would leave a master nothing can reach and no
 * way to tell that had happened.
 */
export function setRuntimeProfile(next: RuntimeProfile): void {
	if (profile !== undefined) {
		throw new Error("the runtime profile has already been set");
	}
	profile = next;
	// This machine keeps its own short-lived files beside this profile's state,
	// for the same reason every other resource is keyed on the profile: two
	// DevHubs must not be able to pick each other's names.
	LOCAL.keepFilesUnder(next.userDataDirectory);
}

/** For tests, which need a second profile in the same process. */
export function forgetRuntimeProfile(): void {
	profile = undefined;
	SSH.clear();
	CONTAINERS.clear();
}

/**
 * The runtime a Workspace's folder lives on.
 *
 * This is the switch — the only one in `main/` — and both arms now return a
 * runtime, which is what the whole module was arranged for: a caller that runs
 * `git` writes the same line for both machines, and the difference between them
 * lives in `ssh.ts` where it can be named.
 *
 * The local arm needs no profile and never waits for one — this machine is
 * where `main` is running. The remote arm does, and refuses rather than
 * guessing: a control socket under a directory nobody chose is a master a
 * second DevHub would find and adopt.
 */
export function runtimeFor(location: WorkspaceLocation): Runtime {
	switch (location.kind) {
		case "local":
			return LOCAL;
		case "ssh": {
			const existing = SSH.get(location.host);
			if (existing) return existing;
			if (profile === undefined) {
				throw new Error(
					"a runtime was asked for before the runtime profile was set",
				);
			}
			const runtime = new SshRuntime({
				host: location.host,
				controlDirectory: chooseControlDirectory(
					profile.userDataDirectory,
					profile.home,
				),
				tmux: profile.tmux,
			});
			SSH.set(location.host, runtime);
			return runtime;
		}
	}
}

/**
 * The host a dev container is reached through.
 *
 * A host that has seen its container replaced refuses everything from that
 * moment on, because its caches describe a filesystem that has been deleted.
 * Replacing it is this function's job and nothing else's: the target is still
 * the same target — that is what keying on the folder and the definition
 * means — so a rebuild costs a host instance and never a Workspace. Without
 * this the refusal would be permanent and a rebuilt container would never
 * come back.
 */
export function containerHostFor(target: ContainerTarget): ContainerHost {
	const key = containerHostId(target);
	const existing = CONTAINERS.get(key);
	if (existing !== undefined && !existing.replaced) return existing;
	if (existing !== undefined) {
		CONTAINERS.delete(key);
		void existing.dispose();
	}
	if (profile === undefined) {
		throw new Error(
			"a dev container was asked for before the runtime profile was set",
		);
	}
	if (target.location.kind !== "local") {
		throw new Error(
			`a dev container on ${target.location.host} was asked for, and this ` +
				`DevHub brings dev containers up only on this Mac`,
		);
	}
	const host = new ContainerHost({
		target,
		docker: profile.docker,
		devcontainer: profile.devcontainer,
		reh: profile.reh,
	});
	CONTAINERS.set(key, host);
	return host;
}

/**
 * The runtime a path a person just typed would resolve on.
 *
 * The same switch as `runtimeFor`, read on a *request* rather than a location
 * — because the step that resolves a typed path is the one step where there is
 * no location yet, and building one out of `~/src` throws before anything can
 * catch it. It is here rather than at that call site because this file is the
 * only one that knows how a machine id is spelled.
 */
export function runtimeForRequested(requested: {
	readonly kind: RequestedLocation["kind"];
	readonly host?: string;
}): Runtime {
	switch (requested.kind) {
		case "local":
			return LOCAL;
		case "ssh":
			return runtimeById(`ssh:${requested.host ?? ""}`);
	}
}

/**
 * Which machine a location is on, without connecting to it.
 *
 * The same switch as `runtimeFor`, answering the half of the question that
 * costs nothing: a terminal target has to carry the machine, and building an
 * `SshRuntime` — a control directory, a connection waiting to happen — to read
 * a string off it would make naming a machine as expensive as reaching one.
 */
export function runtimeIdFor(location: WorkspaceLocation): RuntimeId {
	switch (location.kind) {
		case "local":
			return "local";
		case "ssh":
			return `ssh:${location.host}`;
	}
}

/**
 * A machine's name as it arrived from outside, checked.
 *
 * The `terminal-profile` request carries one, written into a launcher script
 * on the machine that runs it, and a request is not a place a type holds. A
 * name that is not one of the two shapes is a request DevHub cannot answer,
 * and it says so rather than falling back to this machine — which would open
 * a shell here for a terminal over there.
 */
/**
 * The machine an id names — the inverse of `Runtime.id`.
 *
 * It is here, beside `runtimeFor`, because it is the same switch read the
 * other way round and there must not be two places that know how an id is
 * spelled. Its callers are the ones that were handed a machine rather than a
 * location: a terminal target names the machine its session is on, and the
 * adapter for it is found from that name.
 */
export function runtimeMachine(raw: string): RuntimeId {
	if (raw === "local" || raw.startsWith("ssh:")) {
		return raw as RuntimeId;
	}
	throw new Error(`${raw} does not name a machine DevHub knows`);
}

/**
 * Where a remote workbench's extension host is, as the resolver names it: a
 * host, or a dev container.
 *
 * Beside `runtimeMachine` and not inside it, because a container is not a
 * machine a Workspace is on — only an editor's far end — and a caller that
 * wanted a runtime must not be handed one.
 */
export type EditorHostId = Exclude<RuntimeId, "local"> | ContainerHostId;

export function editorHostMachine(raw: string): EditorHostId {
	if (raw.startsWith("ssh:")) return raw as EditorHostId;
	if (containerTargetFromHostId(raw) !== undefined) {
		return raw as ContainerHostId;
	}
	throw new Error(
		`${raw} does not name a host or a dev container DevHub can open a workbench on`,
	);
}

/**
 * The remote authority a machine's workbench is opened on, or nothing for this
 * one.
 *
 * The same switch as `runtimeFor`, read a third way, and here for the same
 * reason the other two are: it is the one place that knows how a machine id is
 * spelled. `remoteAuthorityOf` composes the authority itself, so the string a
 * window is opened with and the string a file in that window is named with
 * come from one function and cannot drift apart.
 */
export function remoteAuthorityForMachine(id: RuntimeId): string | undefined {
	return remoteAuthorityOf(locationOnMachine(id, workspaceRoot("/")));
}

/**
 * A path on a machine, as a `WorkspaceLocation`.
 *
 * The inverse of `runtimeIdFor`, and the only one. A caller that was handed a
 * machine and a path — the `devhub` CLI on a host, above all — has to be able
 * to say where that is without spelling `kind: "ssh"` itself.
 */
export function locationOnMachine(
	id: RuntimeId,
	path: WorkspaceRoot,
): WorkspaceLocation {
	if (id === "local") return { kind: "local", path };
	return { kind: "ssh", host: sshHost(id.slice("ssh:".length)), path };
}

/**
 * The machine a remote workbench's endpoint is produced on, and the delivery
 * that stocks it.
 *
 * A fourth reading of the same switch, and it is here for the third time for
 * the same reason: this module is the only one that knows how a machine id is
 * spelled. It is separate from `runtimeById` because what it answers is not on
 * `Runtime` and must not be — `Runtime`'s own rule is that every method on it
 * is answerable on every machine, and "give me a local port that reaches your
 * remote extension host" is a question this Mac has no answer to. A window on
 * this Mac has no authority to resolve at all, so the refusal is a fact about
 * the design rather than a gap in it, and it says so in those words.
 */
export function remoteServerFor(id: EditorHostId): {
	readonly host: RemoteServerHost;
	readonly delivery: RehDelivery;
} {
	if (profile === undefined) {
		throw new Error(
			"a remote endpoint was asked for before the runtime profile was set",
		);
	}
	const target = containerTargetFromHostId(id);
	if (target !== undefined) {
		return { host: containerHostFor(target), delivery: profile.reh };
	}
	const runtime = runtimeById(runtimeMachine(id));
	if (!(runtime instanceof SshRuntime)) {
		throw new Error(
			`${id} does not name a machine DevHub can reach a server on`,
		);
	}
	return { host: runtime, delivery: profile.reh };
}

export function runtimeById(id: RuntimeId): Runtime {
	if (id === "local") return LOCAL;
	// The path is not part of which machine this is, and `runtimeFor` does not
	// read it: one runtime per host, whatever folder is being asked about.
	return runtimeFor(locationOnMachine(id, workspaceRoot("/")));
}

/**
 * Let go of a machine no Workspace is on any more.
 *
 * Separate from `runtimeFor` because only the model knows when the last
 * Workspace on a host has gone, and a runtime that disposed itself on an idle
 * timer would be closing a connection the next reconcile round is about to
 * reopen. Disposing something that is not there is not a failure: it is the
 * state this call exists to reach.
 */
export async function disposeRuntime(id: RuntimeId): Promise<void> {
	for (const [host, runtime] of SSH) {
		if (runtime.id !== id) continue;
		SSH.delete(host);
		await runtime.dispose();
		return;
	}
}

/**
 * Let go of a dev container no Workspace's editor is attached to any more.
 *
 * The container itself is untouched: what goes is DevHub's forward into it
 * and its relay, the same things a closed window would have let go of.
 */
export async function disposeContainerHost(id: ContainerHostId): Promise<void> {
	const host = CONTAINERS.get(id);
	if (host === undefined) return;
	CONTAINERS.delete(id);
	await host.dispose();
}

/**
 * This machine, for the sites that have no Workspace to ask about.
 *
 * `devhub --metrics` is one; so is a folder probe on a path a person has just
 * typed, which belongs to no Workspace yet. Neither is a way around
 * `runtimeFor`: a caller that *has* a location must use it, because a caller
 * that reaches for this one instead is a caller that will keep working when
 * the folder moves to another machine, and will be wrong.
 */
export function localRuntime(): Runtime {
	return LOCAL;
}

/**
 * Every runtime that is live right now, for a reading and for shutdown.
 *
 * This machine first, then one per host DevHub has been asked about, in the
 * order it was asked — so `devhub --metrics` prints the same list in the same
 * order twice running, which is what makes two readings comparable.
 */
export function liveRuntimes(): readonly Runtime[] {
	return [LOCAL, ...SSH.values()];
}

/** Every dev container DevHub is holding a forward into right now. */
export function liveContainerHosts(): readonly ContainerHost[] {
	return [...CONTAINERS.values()];
}
