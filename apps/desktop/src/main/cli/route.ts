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
 * An origin says which *pane* as well as which window, and when that pane is
 * an Agent's the first clause says one thing more: the file is shown **beside
 * that Agent**, in the split the person would have made by hand. That is not a
 * second rule about where an open lands — it lands in the same window either
 * way — it is the arrangement the window is put into, and it is here because
 * the fact it is read from is the origin and nothing else knows it.
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
 * Four fields, because four is what the rule reads. Deliberately not the
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
	/**
	 * The Agents running in it, by id.
	 *
	 * Read for the same reason the Workspace list is read at all: an origin
	 * names something that may have gone away since the pane was made. A pane
	 * outlives its Agent — an Agent that exited leaves its tmux session behind
	 * for a moment, and a person can run `devhub` in it — so "beside that
	 * Agent" has to be checked against what is running and not believed.
	 */
	readonly agents: readonly string[];
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
	/**
	 * The request came from an Agent's own pane, and that Agent is running.
	 *
	 * The same window as `origin` — an Agent belongs to a Workspace — with one
	 * thing more said about how it is shown: the file goes into that
	 * Workspace's editor **beside that Agent**, because the thing that asked
	 * for it is the thing the person is looking at, and an editor that covers
	 * it has taken away the half of the screen the request came from.
	 */
	| "origin-agent"
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
			readonly kind: "workspace";
			readonly workspace: RoutableWorkspace;
			readonly reason: "origin-agent";
			/** The Agent the editor is put beside. Running, and in `workspace`. */
			readonly agentId: string;
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
function parseOrigin(origin: string | undefined):
	| {
			readonly machine: string;
			readonly workspaceId: string;
			readonly agentId: string;
	  }
	| undefined {
	if (origin === undefined) return undefined;
	const fields = origin.split("\t");
	if (fields.length !== 3) return undefined;
	const [machine, workspaceId, agentId] = fields;
	if (!machine || !workspaceId || !agentId) return undefined;
	return { machine, workspaceId, agentId };
}

/**
 * The Workspace field of an origin written by the tmux anchor session, which
 * belongs to no Workspace. Such a pane's opens go to Scratch.
 */
const SCRATCH_ORIGIN = "scratch";

/**
 * The Agent field of an origin that is not an Agent's pane.
 *
 * Every origin carries the field, and a Workspace's own terminal says `none`
 * rather than leaving it out: a variable whose shape depends on what wrote it
 * is a variable every reader has to branch on, and the branch is where one of
 * the two shapes stops being read.
 */
const NO_AGENT_ORIGIN = "none";

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
			// An Agent's pane asks for one thing more than its Workspace's
			// terminal does, and it asks for it by being an Agent's pane: the
			// file beside the Agent rather than over it. Checked against the
			// Agents that are running for the same reason the window is — an
			// origin is a fact about the moment the session was made, and the
			// Agent in it can be gone. A stale Agent leaves an open that is
			// still right about the window, so it falls through to `origin`
			// rather than to the containing rule.
			if (
				asked.agentId !== NO_AGENT_ORIGIN &&
				window.agents.includes(asked.agentId)
			) {
				return {
					kind: "workspace",
					workspace: window,
					reason: "origin-agent",
					agentId: asked.agentId,
				};
			}
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
