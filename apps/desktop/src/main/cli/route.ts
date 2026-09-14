/**
 * Which workbench an `open` lands in. One rule, and this is the only place it
 * is written.
 *
 * DevHub deliberately does not do what `code` does. `code <file>` opens the
 * file in the *last focused window*, so the same command lands somewhere
 * different depending on where you happened to click a minute ago. DevHub
 * answers from facts the request carries:
 *
 * > An open lands in the workbench the request came from. If the request did
 * > not say, it lands in the Workspace **on the machine the path is on** whose
 * > root contains it; if none does, in Scratch.
 *
 * The first clause is not "the last window you clicked" coming back. It is the
 * thing `code` from an integrated terminal actually does: the window is
 * *carried* by the terminal, because the window is what made the terminal.
 * DevHub carries it on the tmux session (`DEVHUB_ORIGIN`, see
 * `../terminal/tmux.ts`), so a `devhub` run from a pane says which workbench
 * is asking and a `devhub` run from a login shell says nothing — which is the
 * honest unknown, and the second clause is what answers for it.
 *
 * The machine is half the second clause and not a refinement of it. A path is a path on
 * one computer: `/srv/app` on this Mac and `/srv/app` on a host are two
 * folders, and a matcher handed both roots answers one of them with the
 * other's Workspace. That is not a near miss — it is a window showing
 * somebody's server being sent a file off this disk, and nothing about it
 * looks wrong from either end.
 *
 * It is here rather than inside `AppController` because a rule that decides
 * where every open goes has to be something a test can ask, and a rule buried
 * in five thousand lines of window and coordinator wiring is a rule that is
 * only ever exercised by running the app. Everything here is pure: canonical
 * paths in, a destination out.
 */

import { workspaceRootFor, type CanonicalPath } from "./resolve.js";

/**
 * An open Workspace, as the routing rule sees one.
 *
 * Three fields, because three is what the rule reads. Deliberately not the
 * model's `Workspace`: this module must stay something a test can build by
 * hand, and a rule that took the whole class would drag the model, the
 * coordinator and the runtimes in behind it.
 */
export interface RoutableWorkspace {
	readonly workspaceId: string;
	/** Canonical, and a path on `machine`. */
	readonly root: CanonicalPath;
	/** A `RuntimeId`: `local`, or `ssh:<host>`. */
	readonly machine: string;
}

/**
 * Which of the three clauses answered.
 *
 * Carried out of the rule rather than reconstructed by the caller, because the
 * sentence the CLI prints has to say which one happened: a misrouted open is
 * only visible if the answer says *why* it went where it went, in the terminal
 * that asked.
 */
export type OpenReason =
	/** The request said which workbench it came from, and that window is open. */
	| "origin"
	/** No origin, or a stale one; this Workspace's root contains the path. */
	| "containing"
	/** No origin, and no open Workspace on that machine contains the path. */
	| "no-containing-workspace";

/** Where an open goes, and — for the sentence the CLI prints — why. */
export type OpenDestination =
	| {
			readonly kind: "workspace";
			readonly workspace: RoutableWorkspace;
			readonly reason: "origin" | "containing";
	  }
	| {
			readonly kind: "scratch";
			readonly reason: "origin" | "no-containing-workspace";
	  };

/**
 * The value of a pane's `DEVHUB_ORIGIN`, read.
 *
 * Anything that is not the two-field shape DevHub writes is treated as no
 * origin at all. Not a silent repair: an origin is a fact DevHub itself stated
 * on the session, so a malformed one means the variable came from somewhere
 * else — a person's own export, a stale shell — and the honest reading of
 * something DevHub did not write is that it says nothing about DevHub.
 */
function parseOrigin(
	origin: string | undefined,
): { readonly machine: string; readonly workspaceId: string } | undefined {
	if (origin === undefined) return undefined;
	const fields = origin.split("\t");
	if (fields.length !== 2) return undefined;
	const [machine, workspaceId] = fields;
	if (!machine || !workspaceId) return undefined;
	return { machine, workspaceId };
}

/** The workbench named by `scratch` in an origin. */
const SCRATCH_ORIGIN = "scratch";

export function routeOpen(
	path: CanonicalPath,
	machine: string,
	workspaces: readonly RoutableWorkspace[],
	origin?: string,
): OpenDestination {
	const asked = parseOrigin(origin);
	if (asked) {
		if (asked.workspaceId === SCRATCH_ORIGIN) {
			return { kind: "scratch", reason: "origin" };
		}
		// "Still open" is the whole of why this is a lookup and not a trust.
		// A tmux session outlives the window it was made for by design, so a
		// pane can name a Workspace that was closed an hour ago — and a
		// Workspace that is not open is not a window. The answer then has to
		// fall through to the rule below rather than fail, because the person
		// asked to open a file and there is still a right answer to that.
		const window = workspaces.find(
			(workspace) =>
				workspace.workspaceId === asked.workspaceId &&
				// The machine is checked too. An origin whose machine disagrees
				// with the Workspace's is not this Workspace's pane, whatever
				// the id says, and routing by half a match is how one fact
				// quietly becomes two.
				workspace.machine === asked.machine,
		);
		if (window) {
			return { kind: "workspace", workspace: window, reason: "origin" };
		}
	}

	const onMachine = workspaces.filter(
		(workspace) => workspace.machine === machine,
	);
	const root = workspaceRootFor(
		path,
		onMachine.map((workspace) => workspace.root),
	);
	if (root === undefined) {
		return { kind: "scratch", reason: "no-containing-workspace" };
	}
	const workspace = onMachine.find((candidate) => candidate.root === root);
	// `workspaceRootFor` answers with one of the roots it was given, so the
	// find cannot miss. If it ever did, the list it was given and the list it
	// answered from would have to be different lists — and continuing from
	// there would be routing an open by a rule nobody wrote.
	if (!workspace) {
		throw new Error(`no workspace is rooted at ${root} on ${machine}`);
	}
	return { kind: "workspace", workspace, reason: "containing" };
}
