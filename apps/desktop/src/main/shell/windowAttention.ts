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
 * So the signal moves out of the window's contents and onto the window. macOS
 * already has one way to say this, and it is the way every other application
 * says it:
 *
 * - **A Dock badge** while anything is waiting. It is a standing mark, visible
 *   whether or not DevHub is the front application and whether or not its
 *   window is on screen at all — which the DOM glow never was.
 * - **A critical Dock bounce** while anything is waiting *and* the window is
 *   not focused. `NSCriticalRequest` bounces until the application is
 *   activated, which is the same "until you look" lifetime the breathing had,
 *   and it is cancelled the moment the reason goes. It is deliberately not
 *   raised while the window already has focus: the person is looking at DevHub,
 *   and the badge is enough.
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

/** As much of macOS's Dock as this needs, so a test can be the other half. */
export interface AttentionDock {
	setBadge(text: string): void;
	bounce(type: "critical" | "informational"): number;
	cancelBounce(id: number): void;
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
 * `ModalOverlay.reposition` has, and for the same reason: an attention signal
 * raised by an event and retracted by a different event is two rules that can
 * disagree, and the one that survives a disagreement is the one that leaves
 * the Dock bouncing at nothing.
 */
export class WindowAttention {
	private wanted = false;
	private focused = false;
	private bouncing: number | undefined;
	private badged = false;

	constructor(private readonly dock: AttentionDock) {}

	/** The projection moved: something may now be waiting, or may not be. */
	observe(snapshot: AppSnapshotWire): void {
		this.wanted = wantsAttention(snapshot);
		this.apply();
	}

	/** The window came forward or went away. */
	windowFocusChanged(focused: boolean): void {
		this.focused = focused;
		this.apply();
	}

	private apply(): void {
		if (this.wanted !== this.badged) {
			this.dock.setBadge(this.wanted ? BADGE : "");
			this.badged = this.wanted;
		}
		// Bouncing at somebody who is already looking at the window is noise,
		// and it is noise macOS will not stop on its own: a critical request
		// bounces until the *application* is activated, and DevHub is already
		// the active application.
		const shouldBounce = this.wanted && !this.focused;
		if (shouldBounce && this.bouncing === undefined) {
			this.bouncing = this.dock.bounce("critical");
			return;
		}
		if (!shouldBounce && this.bouncing !== undefined) {
			this.dock.cancelBounce(this.bouncing);
			this.bouncing = undefined;
		}
	}
}

/**
 * The real Dock, where there is one.
 *
 * `app.dock` is macOS only. On every other platform there is nothing here to
 * talk to, and the honest answer is a signal that does nothing rather than a
 * second implementation of it — DevHub is a Mac application, and this is the
 * one place that is allowed to be true.
 */
export function platformDock(): AttentionDock {
	const dock = electron.app.dock;
	if (!dock) {
		return {
			setBadge: () => undefined,
			bounce: () => -1,
			cancelBounce: () => undefined,
		};
	}
	return {
		setBadge: (text) => dock.setBadge(text),
		bounce: (type) => dock.bounce(type),
		cancelBounce: (id) => {
			if (id >= 0) dock.cancelBounce(id);
		},
	};
}
