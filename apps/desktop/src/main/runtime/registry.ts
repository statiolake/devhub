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

import type { WorkspaceLocation } from "../../model/domain.js";
import { errorWireAt, TypedFailure, withSummary } from "../../model/wire.js";
import { LocalRuntime } from "./local.js";
import type { Runtime } from "./runtime.js";

/**
 * This machine. One instance, because there is one of it.
 *
 * Its counters and its latency window are per-instance, so a second one would
 * split the reading `devhub --metrics` prints in half.
 */
const LOCAL = new LocalRuntime();

/**
 * The runtime a Workspace's folder lives on.
 *
 * An ssh location throws here, at the moment the runtime is asked for, rather
 * than returning something that answers some calls and not others. A runtime
 * that half-works is the failure mode this seam was built to remove: it would
 * put the "not on this machine" branch back into every caller, one silent
 * `catch` at a time. The throw is loud, it is typed, and it is at the one place
 * that will stop throwing when the remote runtime exists.
 */
export function runtimeFor(location: WorkspaceLocation): Runtime {
	switch (location.kind) {
		case "local":
			return LOCAL;
		case "ssh":
			throw new TypedFailure(
				withSummary(
					errorWireAt("workspace_unavailable"),
					`DevHub cannot run anything on ${location.host} yet: its SSH runtime is not implemented.`,
				),
			);
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
 * There is one. When there are per-host ones they are cached here and this
 * lists them, which is why `devhub --metrics` reads a list today rather than
 * gaining one later.
 */
export function liveRuntimes(): readonly Runtime[] {
	return [LOCAL];
}
