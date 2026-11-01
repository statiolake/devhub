/**
 * How long each workbench has been off screen, for hibernation.
 *
 * "Off screen" is DevHub's own answer and nothing else: the workbench is not
 * the page `windowLayout()` draws — another Workspace is selected, or an Agent
 * fills the content area. The window being in the background, minimized or
 * covered by another app is not it, and neither is the keyboard being in the
 * Agent of a split: the editor is still in front of the person's eyes then.
 * That is why this is measured here, from the layout, and not in the
 * renderer — `document.visibilityState` and window blur answer the other
 * question.
 *
 * Main closes a workbench away for longer than
 * `general.workbench_hibernate_minutes` (`workbenchLifecycle.ts`). A
 * workbench that has never been on screen is away from when it was first
 * seen.
 */
export class WorkbenchAbsence<View extends object> {
	/** `"shown"`, or since when it has been off screen. */
	private readonly state = new Map<View, "shown" | number>();

	/**
	 * Note which of `views` are on screen now. Views no longer in `views` are
	 * forgotten.
	 */
	observe(
		views: Iterable<View>,
		isShown: (view: View) => boolean,
		now: number,
	): void {
		const seen = new Set<View>();
		for (const view of views) {
			seen.add(view);
			if (isShown(view)) this.state.set(view, "shown");
			else if (typeof this.state.get(view) !== "number") {
				this.state.set(view, now);
			}
		}
		for (const view of [...this.state.keys()]) {
			if (!seen.has(view)) this.state.delete(view);
		}
	}

	/** How long `view` has been off screen, or nothing while it is on screen or unknown. */
	awayMs(view: View, now: number): number | undefined {
		const since = this.state.get(view);
		return typeof since === "number" ? Math.max(0, now - since) : undefined;
	}
}
