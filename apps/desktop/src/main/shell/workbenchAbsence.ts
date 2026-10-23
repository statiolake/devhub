/**
 * How long each workbench was off screen, told to it when it comes back.
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
 * The workbench decides what to do with the number (`devhubTidy` in the
 * overlay hides its panel and side bars after `devhub.workbench.
 * tidyAfterAwayMinutes`), and main closes a workbench away for longer than
 * `general.workbench_hibernate_minutes` (`workbenchHibernation.ts`).
 *
 * A workbench that has never been on screen is away from when it was first
 * seen, but has nothing to come back from: its first showing is not reported.
 */
export class WorkbenchAbsence<View extends object> {
	/** `"shown"`, or since when it has been off screen and whether it was ever shown. */
	private readonly state = new Map<
		View,
		"shown" | { readonly since: number; readonly returns: boolean }
	>();

	/**
	 * Note which of `views` are on screen now, and answer the ones that have
	 * just come back with how long, in milliseconds, they were away. Views no
	 * longer in `views` are forgotten.
	 */
	observe(
		views: Iterable<View>,
		isShown: (view: View) => boolean,
		now: number,
	): { readonly view: View; readonly awayMs: number }[] {
		const returned: { view: View; awayMs: number }[] = [];
		const seen = new Set<View>();
		for (const view of views) {
			seen.add(view);
			const was = this.state.get(view);
			if (isShown(view)) {
				if (typeof was === "object" && was.returns) {
					returned.push({ view, awayMs: Math.max(0, now - was.since) });
				}
				this.state.set(view, "shown");
			} else if (was === undefined || was === "shown") {
				this.state.set(view, { since: now, returns: was === "shown" });
			}
		}
		for (const view of [...this.state.keys()]) {
			if (!seen.has(view)) this.state.delete(view);
		}
		return returned;
	}

	/** How long `view` has been off screen, or nothing while it is on screen or unknown. */
	awayMs(view: View, now: number): number | undefined {
		const was = this.state.get(view);
		return typeof was === "object" ? Math.max(0, now - was.since) : undefined;
	}
}

/**
 * The workbench command main raises, over `vscode:runAction`, on a workbench
 * that has just come back on screen. Its one argument is `{ awayMs }`.
 * Registered by `devhubTidy.contribution.ts` in the overlay.
 */
export const WORKBENCH_RETURNED_COMMAND = "_devhub.workbench.returned";
