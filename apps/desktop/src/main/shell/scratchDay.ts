/**
 * Today's daily folder, on disk, and the moments that can change which it is.
 *
 * `model/scratchDay.ts` says what the folder is called; this makes it and
 * resolves it, so the model can be handed a Workspace for it. It is made here,
 * when it is first needed, rather than when somebody first looks at it,
 * because Scratch is a Workspace and a Workspace is a folder that is there.
 *
 * Scratch is always the folder today's date gives under the `[scratch] daily`
 * DevHub is running on — the one in the last settings it accepted. Three
 * things change the answer, and `ScratchFollower` is the one place that hears
 * all three: a new day, a wake (a timer cannot see a midnight slept through),
 * and settings accepted with a different `daily`, whether they came from the
 * Settings window or from an edit to the file.
 *
 * A folder that cannot be made is not a reason for DevHub not to start, and not
 * a thing to hide: the Workspace comes back with the path as the setting spells
 * it, unavailable as `root_inaccessible`, and `report` says why — so the row
 * says what is wrong in the place it is wrong.
 *
 * Settings that were refused at launch leave DevHub running on none, and then
 * there is no `daily` to make a folder from. That is not the default's cue:
 * a folder nobody configured is not made. Scratch is a stand-in, unavailable
 * as `settings_refused`, until settings are accepted and today's folder takes
 * its place. It has no `report` of its own: its reason *is* the refusal, which
 * is reported as itself (`settingsRefused`), and a second notice saying "and
 * so Scratch has no folder" would take the refusal's place on screen.
 *
 * The stand-in cannot be mistaken for a Workspace: its location is the
 * settings file, and a Workspace's root is a folder, so no open Workspace has
 * its key; and a Scratch that holds nothing is neither kept as a row nor
 * written to the state file (`scratchHoldsNothing`).
 *
 * Settings refused *later* change nothing here: DevHub goes on running on the
 * ones it had, and so does Scratch.
 */

import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import {
	displayPath,
	workspaceId as parseWorkspaceId,
	type ScratchUnavailable,
	Workspace,
	workspaceLocation,
} from "../../model/domain.js";
import type { AppErrorWire } from "../../ipc/appShell.js";
import { errorWireAt, withDetail } from "../../model/wire.js";
import {
	expandHome,
	nextLocalMidnight,
	scratchDailyPath,
} from "../../model/scratchDay.js";

export interface ScratchDay {
	/** A Workspace for today's folder, with an id nobody has used. */
	readonly workspace: Workspace;
	/** Why the day has no folder, when it has none. */
	readonly unavailable:
		| {
				readonly reason: Extract<ScratchUnavailable, "root_inaccessible">;
				/** The sentence to report: which folder, and what stopped it. */
				readonly report: string;
		  }
		| { readonly reason: Extract<ScratchUnavailable, "settings_refused"> }
		| undefined;
}

/** Where Scratch comes from: the `daily` DevHub runs on, and where it is written. */
export interface ScratchSetting {
	/** `[scratch] daily`, or `undefined` while DevHub runs on no settings. */
	readonly daily: string | undefined;
	/** The settings file, which is where Scratch points when there is no `daily`. */
	readonly settingsFile: string;
}

export async function scratchDay(
	setting: ScratchSetting,
	now: Date,
	home: string,
): Promise<ScratchDay> {
	const id = parseWorkspaceId(randomUUID());
	const at = (path: string): Workspace =>
		new Workspace(
			id,
			workspaceLocation({ kind: "local", path }),
			displayPath(path),
		);
	if (setting.daily === undefined) {
		return {
			workspace: at(setting.settingsFile),
			unavailable: { reason: "settings_refused" },
		};
	}
	const path = expandHome(scratchDailyPath(setting.daily, now), home);
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
			unavailable: {
				reason: "root_inaccessible",
				report: `Today's Scratch folder ${path} could not be made: ${error instanceof Error ? error.message : String(error)}`,
			},
		};
	}
	return { workspace: at(canonical), unavailable: undefined };
}

/**
 * Why a request that lands in Scratch without selecting it is refused, or
 * nothing when Scratch can take it.
 *
 * `devhub -`, `--wait`, an open no Workspace contains and a request for an
 * empty window all end at Scratch's workbench, and an unavailable Scratch has
 * none to give — the stand-in least of all, whose location is a file. They
 * are refused with the cause: the settings refusal itself for the stand-in,
 * and the missing folder for a day that could not be made.
 */
export function scratchRefusal(
	scratch: Workspace,
	settingsRefusal: () => AppErrorWire,
): AppErrorWire | undefined {
	const state = scratch.state;
	if (state.kind === "available") return undefined;
	if (state.reason === "settings_refused") return settingsRefusal();
	return withDetail(
		errorWireAt("workspace_unavailable"),
		`Scratch (${scratch.root}) has no folder to open this in: ${state.reason}.`,
	);
}

/**
 * Keeps Scratch on today's folder under the `daily` DevHub is running on.
 *
 * Launch is not here: the model is built with today's Scratch already in it
 * (`createAppController`), from the same `scratchDay`. From then on, every
 * moment that can change the answer works it out again from the clock and
 * the current `daily` and hands it to `adopt`; adopting the same folder twice
 * is a no-op, so asking too often costs nothing and asking too rarely is the
 * only way to be wrong.
 */
export class ScratchFollower {
	#daily: string | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		daily: string | undefined,
		private readonly options: {
			readonly settingsFile: string;
			readonly home: string;
			/** Make `day` Scratch. A rejection is the caller's to raise. */
			readonly adopt: (day: ScratchDay) => Promise<void>;
			readonly clock?: () => Date;
		},
	) {
		this.#daily = daily;
	}

	/** Aim at the next midnight. Launch already made today's Scratch. */
	start(): void {
		this.arm();
	}

	/**
	 * Settings were accepted — from the Settings window or from the file.
	 * A different `daily` names a different folder for today, and that folder
	 * is Scratch from now on; the old one stays as an ordinary row.
	 */
	settingsAccepted(daily: string): Promise<void> {
		if (daily === this.#daily) return Promise.resolve();
		this.#daily = daily;
		return this.catchUp();
	}

	/** A Mac asleep across midnight wakes to a timer aimed at a moment that has passed. */
	resumed(): Promise<void> {
		return this.catchUp();
	}

	stop(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** Work today out again now, and aim at the next midnight from the clock as it is. */
	private catchUp(): Promise<void> {
		this.arm();
		return this.followToday();
	}

	private arm(): void {
		this.stop();
		const now = this.now();
		const delay = Math.max(0, nextLocalMidnight(now).getTime() - now.getTime());
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.arm();
			// Not caught here: a failure nothing can recover from goes to the
			// main process's root (`mainFailureRoot.ts`) like any other.
			void this.followToday();
		}, delay);
	}

	private async followToday(): Promise<void> {
		const day = await scratchDay(
			{ daily: this.#daily, settingsFile: this.options.settingsFile },
			this.now(),
			this.options.home,
		);
		await this.options.adopt(day);
	}

	private now(): Date {
		return (this.options.clock ?? (() => new Date()))();
	}
}
