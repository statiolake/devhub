/**
 * Today's daily folder, on disk, and the midnight that ends it.
 *
 * `model/scratchDay.ts` says what the folder is called; this makes it and
 * resolves it, so the model can be handed a Workspace for it. It is made here,
 * when it is first needed — at launch and at each midnight — rather than when
 * somebody first looks at it, because Scratch is a Workspace and a Workspace
 * is a folder that is there.
 *
 * A folder that cannot be made is not a reason for DevHub not to start, and not
 * a thing to hide: the Workspace comes back with the path as the setting spells
 * it and `failure` says why, and the caller marks it unavailable and reports
 * the sentence — so the row says what is wrong in the place it is wrong.
 */

import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import {
	displayPath,
	workspaceId as parseWorkspaceId,
	Workspace,
	workspaceLocation,
} from "../../model/domain.js";
import {
	expandHome,
	nextLocalMidnight,
	scratchDailyPath,
} from "../../model/scratchDay.js";

export interface ScratchDay {
	/** A Workspace for today's folder, with an id nobody has used. */
	readonly workspace: Workspace;
	/** Why the folder is not there, when it could not be made. */
	readonly failure: string | undefined;
}

export async function scratchDay(
	template: string,
	now: Date,
	home: string,
): Promise<ScratchDay> {
	const path = expandHome(scratchDailyPath(template, now), home);
	const id = parseWorkspaceId(randomUUID());
	const at = (folder: string): Workspace =>
		new Workspace(
			id,
			workspaceLocation({ kind: "local", path: folder }),
			displayPath(folder),
		);
	let canonical: string;
	try {
		await mkdir(path, { recursive: true });
		canonical = await realpath(path);
		if (!(await stat(canonical)).isDirectory()) {
			throw new Error(`${canonical} is not a folder`);
		}
	} catch (error) {
		// Recovered into a state, not swallowed: the Workspace is still made,
		// at the path the setting names, and the caller marks it unavailable
		// with this sentence.
		return {
			workspace: at(path),
			failure: `Today's Scratch folder ${path} could not be made: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return { workspace: at(canonical), failure: undefined };
}

/**
 * Call `onMidnight` at every local midnight from now on.
 *
 * One timer to the next midnight, re-armed after each one rather than a
 * minute-by-minute poll. A timer is a duration, and a Mac that sleeps through
 * midnight or changes timezone makes the duration wrong — so `rearm` is there
 * for the moments that can do that (resume, a settings change): it throws the
 * old timer away and aims again from the clock as it is now. Calling
 * `onMidnight` on every re-arm is safe, because adopting the same day twice is
 * a no-op, and it is what catches a midnight slept through.
 */
export class MidnightTimer {
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly onMidnight: () => void,
		private readonly clock: () => Date = () => new Date(),
	) {}

	arm(): void {
		this.stop();
		const now = this.clock();
		const delay = Math.max(0, nextLocalMidnight(now).getTime() - now.getTime());
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.onMidnight();
			this.arm();
		}, delay);
	}

	/** After a wake or a settings change: catch up, and aim again. */
	rearm(): void {
		this.onMidnight();
		this.arm();
	}

	stop(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
