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

/**
 * The cap closes only workbenches off screen at least this long, so the ones
 * `Cmd+Q N/P` just passed through stay; the minute's check catches up.
 */
export const CAP_MIN_AWAY_MS = HIBERNATE_CHECK_MS;

/** Which of `awake` the cap closes, least recently shown first, and how many. */
export function capCandidates<T>(
	awake: readonly T[],
	awayMs: (one: T) => number | undefined,
	max: number,
): { readonly candidates: readonly T[]; readonly excess: number } {
	return {
		candidates: awake
			.map((one) => ({ one, ms: awayMs(one) ?? -1 }))
			.filter(({ ms }) => ms >= CAP_MIN_AWAY_MS)
			.sort((a, b) => b.ms - a.ms)
			.map(({ one }) => one),
		excess: max > 0 ? awake.length - max : 0,
	};
}

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

/**
 * Each folder's sleep, one state at a time: awake (no entry) → hibernating →
 * asleep → waking → awake. Only `shown` wakes, and nothing opens an asleep
 * folder (`mayOpen`), so a workbench is never up while counted asleep.
 */
export class WorkbenchSleep {
	private readonly phase = new Map<
		string,
		"hibernating" | "asleep" | "waking"
	>();
	/** An asleep folder `Cmd+Q N/P` landed on, not woken for `WAKE_DELAY_MS`. */
	private hold:
		| { readonly folder: string; readonly timer: ReturnType<typeof setTimeout> }
		| undefined;

	/** `reveal`: look at the selection again (`shown`), the held one let go. */
	constructor(private readonly reveal: () => void) {}

	asleep(): string[] {
		return [...this.phase].filter(([, p]) => p === "asleep").map(([f]) => f);
	}

	hibernating(folder: string): boolean {
		return this.phase.get(folder) === "hibernating";
	}

	/** False for an asleep folder: only `shown` may open it. */
	mayOpen(folder: string): boolean {
		return this.phase.get(folder) !== "asleep";
	}

	/** `Cmd+Q N/P` landed on this folder's editor, maybe only passing. */
	pass(folder: string | undefined): void {
		this.drop("left");
		if (folder === undefined || this.phase.get(folder) !== "asleep") return;
		const timer = setTimeout(() => {
			this.release();
		}, WAKE_DELAY_MS);
		this.hold = { folder, timer };
		log(folder, "held");
	}

	/** The delay passed or someone typed: the held one wakes if still shown. */
	release(): void {
		if (!this.hold) return;
		this.drop("released");
		this.reveal();
	}

	/** The selection shows `selected`; true when it starts waking it. */
	shown(selected: string | undefined): boolean {
		if (this.hold?.folder !== selected) this.drop("left");
		if (selected === undefined || this.hold) return false;
		return this.move(selected, "asleep", "waking");
	}

	/** Its workbench finished loading. */
	awake(folder: string): void {
		this.move(folder, "waking", undefined);
	}

	/** The folder left the model. */
	forget(folder: string): void {
		if (this.hold?.folder === folder) this.drop("left");
		if (this.phase.delete(folder)) log(folder, "forgotten");
	}

	/** Hibernate an awake folder; anything else in flight refuses. */
	async hibernate(folder: string, workbench: Hibernating): Promise<boolean> {
		if (!this.move(folder, undefined, "hibernating")) return false;
		let slept = false;
		try {
			slept = await hibernate({
				...workbench,
				sleep: () => {
					this.move(folder, "hibernating", "asleep");
					workbench.sleep();
				},
			});
			return slept;
		} finally {
			if (!slept) this.move(folder, "hibernating", undefined);
		}
	}

	private move(
		folder: string,
		from: "hibernating" | "asleep" | "waking" | undefined,
		to: "hibernating" | "asleep" | "waking" | undefined,
	): boolean {
		if (this.phase.get(folder) !== from) return false;
		if (to === undefined) this.phase.delete(folder);
		else this.phase.set(folder, to);
		log(folder, `${from ?? "awake"} -> ${to ?? "awake"}`);
		return true;
	}

	private drop(why: string): void {
		if (!this.hold) return;
		log(this.hold.folder, `hold ${why}`);
		clearTimeout(this.hold.timer);
		this.hold = undefined;
	}
}

function log(folder: string, what: string): void {
	console.log(`[devhub] workbench '${folder}' ${what}`);
}
