/**
 * Who a refused operation is about, and what to call the refusal.
 *
 * Both halves of one rule — **a failure is shown at its subject** — kept
 * together and kept out of the controller, because both are decisions with
 * right and wrong answers that a test can pin, and neither needs an Electron
 * window to make.
 *
 * A failure about one Agent belongs in that Agent's own pane, where the thing
 * it is about is on screen. A failure about one workspace belongs in that
 * workspace's surface. Only a failure with nothing to stand on — the runtime
 * unreachable for everything, not for one pane — is the application speaking,
 * and only those are app-wide alerts. The controller used to publish
 * `agent_runtime_unavailable` for every refusal there was, so a missing
 * profile, a closed workspace and a wedged tmux all produced one banner across
 * the whole window, all three blaming a runtime and none of them naming what
 * they were about.
 */

import type { AppErrorCodeWire } from "../../ipc/appShell.js";
import type {
	AgentFailureCode,
	AgentId,
	DiagnosticCode,
	WorkspaceId,
} from "../../model/domain.js";
import { PortFailure } from "../terminal/ports.js";

/**
 * A refused operation, and the thing it is about.
 *
 * The subject is what decides where it is shown, and it is known at every
 * raising site — a start, an inject, a rename, a stop, an attach all name the
 * Agent they are for. Carrying it means the renderer never has to guess, and
 * the switch that routes it fails to compile when a fourth kind of subject
 * appears rather than quietly sending it to the app.
 *
 * Each subject carries its own vocabulary, because they are drawn by different
 * surfaces: an Agent's pane speaks `AgentFailureCode`, a workspace's speaks
 * the same `DiagnosticCode` its `unavailable` state already does, and only the
 * app-wide alert speaks `AppErrorCodeWire`. The subject is the discriminant,
 * so a code that does not belong to the surface it is being sent to is a type
 * error rather than a sentence nobody can draw.
 */
export type RefusedOperation =
	| {
			readonly subject: "agent";
			readonly id: AgentId;
			readonly code: AgentFailureCode;
			readonly detail?: string;
	  }
	| {
			readonly subject: "workspace";
			readonly id: WorkspaceId;
			readonly code: DiagnosticCode;
			readonly detail?: string;
	  }
	| {
			readonly subject: "app";
			readonly code: AppErrorCodeWire;
			readonly detail?: string;
	  };

/**
 * What the Agent port's refusal is called, kind for kind.
 *
 * Every one of these used to arrive as "the agent runtime is unavailable",
 * which sent the reader to look at a tmux that was working perfectly. They are
 * four different things to do next: the runtime cannot be reached at all, it
 * ran the command and refused it, it did not answer inside the bound, or the
 * session DevHub needs is not the session that is there.
 *
 * `detail` is only ever what `PortFailure` is allowed to carry — a sentence
 * DevHub composed about its *own* configuration, never provider output, so no
 * diagnostic can leak the inventory of a foreign tmux server. See
 * `PortFailure` in `main/terminal/ports.ts`.
 */
export function portRefusal(error: unknown): {
	readonly code: AgentFailureCode;
	readonly detail?: string;
} {
	if (!(error instanceof PortFailure)) {
		return { code: "tmux_command_failed" };
	}
	const detail = error.detail;
	const code: AgentFailureCode =
		error.code === "unavailable" || error.code === "incompatible"
			? "agent_runtime_unavailable"
			: error.code === "timed_out"
				? "tmux_command_timed_out"
				: error.code === "conflict"
					? "tmux_session_conflict"
					: error.code === "root_missing" || error.code === "root_inaccessible"
						? "workspace_unavailable"
						: "tmux_command_failed";
	return { code, ...(detail === undefined ? {} : { detail }) };
}

/**
 * Send a failure to the Agent it is about, or to the app when it is about all
 * of them.
 *
 * A reconcile is asked either for one Agent or for every Agent there is, and
 * that is exactly the line between the two surfaces: a sweep that could not run
 * is the runtime being unreachable for everything, which has no single pane to
 * stand in.
 */
export function agentSubject(
	agentId: AgentId | undefined,
	refusal: { readonly code: AgentFailureCode; readonly detail?: string },
): RefusedOperation {
	if (agentId === undefined) {
		return {
			subject: "app",
			code: "agent_runtime_unavailable",
			...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
		};
	}
	return { subject: "agent", id: agentId, ...refusal };
}
