/**
 * Where a `--wait` open came from, so that closing it can go back there.
 *
 * `devhub --wait <file>` is a modal editing session. Something — usually `git
 * commit` from a DevHub terminal — hands the person a file, they deal with it,
 * they close it, and the thing that was interrupted carries on. Everything
 * about that is already true except the last step: the open moved the
 * selection to the workspace holding the file, and closing the editor left it
 * there, so a commit written from workspace A's terminal ended with the person
 * looking at workspace B and no way back but the sidebar.
 *
 * So the open pushes and the close pops, and this is the stack. It is keyed by
 * the wait marker because the marker *is* the session: it is made before the
 * open, named in the open, deleted by the workbench when the editor closes,
 * and it is what the CLI is watching. One marker, one push, one pop.
 *
 * # What is pushed
 *
 * Two selections, not one: the selection *before* the open, which is where the
 * pop wants to go, and the selection the open *produced*, which is what makes
 * the pop safe. A selection is a `NavigationContext` and a presentation, and
 * that is the whole of what DevHub's model knows about "where you are" — which
 * tab a workbench has open is the workbench's business and it keeps it across
 * a selection change on its own.
 *
 * # When it is popped
 *
 * When the CLI's wait ends, and only then. The CLI already owns the question
 * "is this wait over?" — it polls the marker (see `wait.ts`) — so it tells the
 * app rather than the app growing a second watcher that could answer the same
 * question differently. A wait that ends because DevHub itself went away pops
 * nothing, because there is no app left to pop in.
 *
 * # The exact-record rule
 *
 * The pop restores the earlier selection **only if the selection right now is
 * still exactly the one the open produced.** If the person has since clicked
 * another workspace, opened an Agent, or run a second `devhub`, then where
 * they are is where they chose to be, and yanking them back to a workspace
 * they left on purpose is worse than not going back at all. A record whose
 * produced selection no longer stands is dropped, silently and by design: the
 * wait is over either way, and nothing is owed.
 *
 * That check is here. The other half — whether the workspace or Agent being
 * returned *to* still exists — is asked of the model by the caller, because
 * only the model can answer it. When it is gone, nothing is restored: the
 * model already moved the selection by its own rule when the thing was removed
 * (see `AppModel.closeWorkspace`), and a second rule for this one case would
 * be a rule nobody else follows.
 *
 * # What "where you are" includes
 *
 * The whole arrangement, because that is what a `NavigationSelection` is: the
 * context and the presentation, and the presentation is the split. So a
 * `--wait` from an Agent's pane — which puts the file in that Workspace's
 * editor *beside* the Agent (see `route.ts`) — pushes and pops by exactly the
 * rule above, with no second thing to record and no second thing to check. An
 * open that was already in that arrangement recorded a `before` equal to its
 * `produced`, and restores nothing.
 *
 * # Waits inside waits
 *
 * A restore must never undo an arrangement a *later* wait set. So a record
 * whose wait began before one that is still in flight restores nothing: the
 * arrangement on screen belongs to the later wait, and the exact-record check
 * alone cannot see that — two waits from the same Agent's pane produce the
 * same selection, and the earlier one would recognise the later one's window
 * as its own and take it away. Ending them in the order they began is
 * therefore a no-op for all but the last, and ending them innermost-first —
 * which is what nesting does — restores each in turn.
 *
 * # Restarts
 *
 * Nothing here is persisted, deliberately, and consistently with `wait.ts`:
 * a wait cannot survive a restart at all. The CLI ends a wait with a failure
 * the moment DevHub stops answering its socket, so there is no `--wait` in
 * flight across a restart whose selection could be restored — only a stale one
 * that a restored app would jump to for no reason anybody could see.
 */

import {
	sameSelection,
	type NavigationSelection,
} from "../../model/appModel.js";

interface WaitSelectionRecord {
	/** Where the person was when the `--wait` open arrived. */
	readonly before: NavigationSelection;
	/** Where the open put them, and what the pop is checked against. */
	readonly produced: NavigationSelection;
}

export class WaitSelectionReturns {
	private readonly records = new Map<string, WaitSelectionRecord>();

	/**
	 * Remember where a `--wait` open came from, and where it went.
	 *
	 * Every `--wait` is recorded, including one that arranged nothing — a
	 * `devhub --wait` from an Agent whose window is already the split it would
	 * have made. It restores nothing when it ends, but it is a wait in flight
	 * while it lasts, and the rule below counts them.
	 */
	push(
		markerPath: string,
		before: NavigationSelection,
		produced: NavigationSelection,
	): void {
		this.records.set(markerPath, { before, produced });
	}

	/**
	 * The selection to go back to now that this wait has ended, or nothing.
	 *
	 * Nothing, when this marker was never recorded — a wait that changed no
	 * selection, or one from a DevHub that has since restarted — and nothing
	 * when the selection has moved on since the open, which is the exact-record
	 * rule above. The record is dropped whichever answer it gives: the wait is
	 * over, and a record kept past its wait would fire on somebody else's.
	 */
	take(
		markerPath: string,
		current: NavigationSelection,
	): NavigationSelection | undefined {
		const record = this.records.get(markerPath);
		if (record === undefined) return undefined;
		// A `Map` keeps the order things were put into it, so "a wait that began
		// after this one and has not ended" is a question this can answer
		// without a second structure that could disagree about the order.
		const inFlight = [...this.records.keys()];
		const laterWaitStands = inFlight.indexOf(markerPath) < inFlight.length - 1;
		this.records.delete(markerPath);
		// A wait that arranged nothing has nothing to put back. Asked here
		// rather than refused at `push`, so that it is still a wait in flight
		// for the rule above while it lasts.
		if (sameSelection(record.before, record.produced)) return undefined;
		if (laterWaitStands) return undefined;
		return sameSelection(record.produced, current) ? record.before : undefined;
	}

	/** How many waits are being remembered. For tests, and for nothing else. */
	get size(): number {
		return this.records.size;
	}
}
