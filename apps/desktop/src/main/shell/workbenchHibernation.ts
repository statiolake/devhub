/**
 * Closing a workbench that has been away a long time, to give its memory back.
 *
 * A workbench off screen (`workbenchAbsence.ts`) for longer than
 * `general.workbench_hibernate_minutes` is unloaded the way VS Code closes a
 * window — its storage written, its extensions shut down — and its view
 * destroyed, which ends its renderer, extension host and language servers.
 * Nothing else about the Workspace changes: its Agents, its tmux sessions and
 * its row stay. Showing its editor again opens it through the ordinary open
 * path, and VS Code restores its editors and layout from workspace storage.
 *
 * A workbench that would lose something stays up: unsaved editors, a process
 * running in one of its own terminals (DevHub's terminal is tmux and survives),
 * a debug session. It says so itself (`readKeepAwake`); no answer is a reason.
 */

/** Checked this often; a workbench sleeps within a minute of its threshold. */
export const HIBERNATE_CHECK_MS = 60_000;

/** One away workbench, as the hibernation step needs it. */
export interface Hibernating {
	/** Still off screen for at least the threshold. */
	away(): boolean;
	/** Why it must stay up; empty when nothing would be lost. */
	keepAwake(): Promise<readonly string[]>;
	/** VS Code's own unload; true when something vetoed it. */
	unload(): Promise<boolean>;
	/** Destroy the view and remember the folder as asleep. */
	sleep(): void;
}

/** Close one workbench if it may be; true when it went to sleep. */
export async function hibernate(workbench: Hibernating): Promise<boolean> {
	if (!workbench.away()) return false;
	const reasons = await workbench
		.keepAwake()
		.catch((): readonly string[] => ["no answer"]);
	// Asking takes a moment, in which the person may have come back.
	if (reasons.length > 0 || !workbench.away()) return false;
	if (await workbench.unload()) return false;
	// Unloaded is gone, even if it was shown again meanwhile: that showing
	// opens it anew.
	workbench.sleep();
	return true;
}
