/**
 * Closing a workbench that has been away, to give its memory back.
 *
 * A workbench off screen (`workbenchAbsence.ts`) for longer than
 * `general.workbench_hibernate_minutes`, or the least recently shown one past
 * `general.workbench_awake_max`, is unloaded the way VS Code unloads a window
 * on quit — storage written, extensions shut down, unsaved editors backed up
 * by hot exit — and its view destroyed, which ends its renderer, extension
 * host and language servers. Nothing else about the Workspace changes: its
 * Agents, its tmux sessions and its row stay. Showing its editor again opens
 * it through the ordinary open path, and VS Code restores its editors, layout
 * and backups for that folder. Scratch, SSH and dev container workbenches
 * never sleep.
 *
 * A workbench that would lose something stays up: a process running in one
 * of its own terminals (DevHub's terminal is tmux and survives), a debug
 * session, unsaved editors with hot exit off. It says so itself
 * (`readKeepAwake`); no answer is a reason.
 */

/** Checked this often; a workbench sleeps within a minute of its threshold. */
export const HIBERNATE_CHECK_MS = 60_000;

/** `Cmd+Q N/P` landing on an asleep editor wakes it after this, if still there. */
export const WAKE_DELAY_MS = 1_000;

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
