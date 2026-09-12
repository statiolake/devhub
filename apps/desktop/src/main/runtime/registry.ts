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
	sshHost,
	workspaceRoot,
	type WorkspaceLocation,
} from "../../model/domain.js";
import { LocalRuntime } from "./local.js";
import type { Runtime, RuntimeId } from "./runtime.js";
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
	if (raw === "local" || raw.startsWith("ssh:")) return raw as RuntimeId;
	throw new Error(`${raw} does not name a machine DevHub knows`);
}

export function runtimeById(id: RuntimeId): Runtime {
	if (id === "local") return LOCAL;
	return runtimeFor({
		kind: "ssh",
		host: sshHost(id.slice("ssh:".length)),
		// The path is not part of which machine this is, and `runtimeFor` does
		// not read it: one runtime per host, whatever folder is being asked about.
		path: workspaceRoot("/"),
	});
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
