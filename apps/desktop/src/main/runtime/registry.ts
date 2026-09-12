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

import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkspaceLocation } from "../../model/domain.js";
import { LocalRuntime } from "./local.js";
import type { Runtime, RuntimeId } from "./runtime.js";
import { chooseControlDirectory, SshRuntime } from "./ssh.js";

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
 * The DevHub profile's directory, as far as the control socket cares.
 *
 * `app` is Electron's, and outside Electron — the tests, and the CLI — there is
 * no profile directory to ask about. `~/.devhub` is not a silent default in
 * that case; it is DevHub's own directory, the same one `chooseControlDirectory`
 * names as the short fallback, said out loud in the one place that has no `app`
 * to ask.
 */
function profileDirectory(): string {
	return app?.getPath?.("userData") ?? join(homedir(), ".devhub");
}

/**
 * The runtime a Workspace's folder lives on.
 *
 * This is the switch — the only one in `main/` — and both arms now return a
 * runtime, which is what the whole module was arranged for: a caller that runs
 * `git` writes the same line for both machines, and the difference between them
 * lives in `ssh.ts` where it can be named.
 */
export function runtimeFor(location: WorkspaceLocation): Runtime {
	switch (location.kind) {
		case "local":
			return LOCAL;
		case "ssh": {
			const existing = SSH.get(location.host);
			if (existing) return existing;
			const runtime = new SshRuntime({
				host: location.host,
				controlDirectory: chooseControlDirectory(profileDirectory()),
			});
			SSH.set(location.host, runtime);
			return runtime;
		}
	}
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
