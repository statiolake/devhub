/**
 * Which workbench an `open` lands in. One rule, and this is the only place it
 * is written.
 *
 * DevHub deliberately does not do what `code` does. `code <file>` opens the
 * file in the *last focused window*, so the same command lands somewhere
 * different depending on where you happened to click a minute ago. DevHub
 * answers from facts the request carries:
 *
 * > An open lands in the Workspace **on the machine the path is on** whose
 * > root contains it; if none does, in Scratch.
 *
 * The machine is half the rule and not a refinement of it. A path is a path on
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

/** Where an open goes, and — for the sentence the CLI prints — why. */
export type OpenDestination =
	| {
			readonly kind: "workspace";
			readonly workspace: RoutableWorkspace;
	  }
	| { readonly kind: "scratch" };

export function routeOpen(
	path: CanonicalPath,
	machine: string,
	workspaces: readonly RoutableWorkspace[],
): OpenDestination {
	const onMachine = workspaces.filter(
		(workspace) => workspace.machine === machine,
	);
	const root = workspaceRootFor(
		path,
		onMachine.map((workspace) => workspace.root),
	);
	if (root === undefined) return { kind: "scratch" };
	const workspace = onMachine.find((candidate) => candidate.root === root);
	// `workspaceRootFor` answers with one of the roots it was given, so the
	// find cannot miss. If it ever did, the list it was given and the list it
	// answered from would have to be different lists — and continuing from
	// there would be routing an open by a rule nobody wrote.
	if (!workspace) {
		throw new Error(`no workspace is rooted at ${root} on ${machine}`);
	}
	return { kind: "workspace", workspace };
}
