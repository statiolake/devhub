/**
 * "Over here" — said by the window, not by a page inside it.
 *
 * An Agent that has said something the person has not read is worth an
 * interruption, and the interruption has to be visible from across a desk and
 * from outside the app. DevHub used to draw it: a `position: fixed` element
 * over the whole App Shell page, breathing a thick blue edge into the window's
 * inset. That worked for exactly as long as the page was the window.
 *
 * It is not. A `WebContentsView` paints above the window's own document, so a
 * glow drawn in the page is behind every workbench — hidden precisely when
 * there is an editor on screen, which is most of a session. The obvious repair
 * is a transparent view of its own above all the others, and the owner ruled
 * that out: a permanently present child view is a permanent renderer and,
 * worse, a rectangle that takes clicks (Electron 42 has no per-view
 * `setIgnoreMouseEvents`, measured — see `toastsView.ts`).
 *
 * So the signal moves out of the window's contents and onto the window, as
 * the one standing mark every other application uses:
 *
 * - **A Dock badge** while anything is waiting. It is visible whether or not
 *   DevHub is the front application and whether or not its window is on
 *   screen at all — which the DOM glow never was. On Linux it is the launcher
 *   count (`app.setBadgeCount`), where the desktop shows one.
 *
 * Nothing moves or flashes. A critical Dock bounce while the window was not
 * focused used to go with the badge; the person found it too noisy for an
 * Agent that has simply finished, and it is gone. There is no Linux urgency
 * hint (`flashFrame`) either, for the same reason. The event itself — a
 * notification and a sound — is `agentNotifications.ts`.
 *
 * The retract rule is unchanged and is still one rule computed in one place:
 * the signal holds while some Agent is unread and the selection is not that
 * Agent. Opening it reads it, which clears the flag, which takes the signal
 * away — so there is nothing to keep in step and no way for it to outlive its
 * reason.
 */

import { electron } from "../electron.js";
import type { AppSnapshotWire } from "../../ipc/appShell.js";

/**
 * Whether anything is waiting for the person, and is not what they are looking
 * at.
 *
 * The rule the App Shell page used to compute for its glow, moved whole. It is
 * a pure function of the projection, so main and a test can both ask it.
 */
export function wantsAttention(snapshot: AppSnapshotWire): boolean {
	const selection = snapshot.selection.context;
	const selectedAgentId =
		selection.kind === "agent" ? selection.agentId : undefined;
	return snapshot.workspaces.some((workspace) =>
		workspace.agents.some(
			(agent) => agent.unread && agent.id !== selectedAgentId,
		),
	);
}

/** As much of the Dock as this needs, so a test can be the other half. */
export interface AttentionDock {
	setBadge(text: string): void;
}

/**
 * The mark on the Dock icon.
 *
 * A bullet rather than a count. A number would have to mean something — unread
 * Agents? unread messages? — and DevHub knows only that at least one Agent has
 * something the person has not read, which is exactly one fact and is what the
 * glow said too.
 */
const BADGE = "●";

/**
 * The signal, as a state rather than as a pair of events.
 *
 * Told everything that can change the answer, and idempotent, so nothing has
 * to work out whether it is the call that turns it on. That is the same shape
 * `PickerView.reposition` has, and for the same reason: an attention signal
 * raised by an event and retracted by a different event is two rules that can
 * disagree, and the one that survives a disagreement is the one that leaves
 * a badge on nothing.
 */
export class WindowAttention {
	private wanted = false;
	private badged = false;

	constructor(private readonly dock: AttentionDock) {}

	/** The projection moved: something may now be waiting, or may not be. */
	observe(snapshot: AppSnapshotWire): void {
		this.wanted = wantsAttention(snapshot);
		this.apply();
	}

	private apply(): void {
		if (this.wanted === this.badged) return;
		this.dock.setBadge(this.wanted ? BADGE : "");
		this.badged = this.wanted;
	}
}

/**
 * The real Dock, or the Linux launcher's count.
 *
 * `app.dock` is macOS only, and takes the bullet. Elsewhere the badge is a
 * count, and Electron sets it where the desktop has a launcher that shows one
 * (Unity's protocol); one Agent or more waiting is `1`, as the bullet is one
 * fact. Nothing here bounces or flashes the window.
 */
export function platformDock(): AttentionDock {
	const dock = electron.app.dock;
	if (dock) return { setBadge: (text) => dock.setBadge(text) };
	return {
		setBadge: (text) => {
			electron.app.setBadgeCount(text === "" ? 0 : 1);
		},
	};
}
