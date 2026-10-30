/**
 * Every Workspace's workbench, from first open to sleep and back, in one state.
 *
 * A workbench is a `WebContentsView` running VS Code for one folder. DevHub
 * opens one per Workspace, rebuilds one that falls over, and closes one that
 * has been away for a while — `general.workbench_hibernate_minutes` off screen,
 * or the least recently shown past `general.workbench_awake_max` — the way VS
 * Code unloads a window on quit: storage written, extensions shut down,
 * unsaved editors backed up by hot exit (`UnloadReason.QUIT`), its view
 * destroyed, which ends its renderer, extension host and language servers.
 * Showing its editor again opens it through the ordinary open path, and VS
 * Code restores its editors, layout and backups for that folder. Its Agents,
 * tmux sessions and row stay through all of it.
 *
 * This module is the one owner of where each folder is in that life. It holds
 * one phase per folder and nothing else holds any part of it: the controller
 * (`AppController`, the executor) reports what happened — an open settled, a
 * view finished loading or died, an unload finished — and asks `plan` what to
 * do; `plan` reads the phases, the projection and the selection, moves the
 * phases, and answers with effects to carry out. It reads no clock and runs no
 * timer: every call is given `now`, and `nextDeadline` says when it next
 * needs a `plan` (a wake hold running out, a restart's backoff).
 *
 * ```text
 * absent          ─ wanted ─────────────▶ opening(start), or asleep past the cap
 *                                          or lazy and not shown
 * opening         ─ loaded ─────────────▶ awake
 *                 ─ nothing coming ─────▶ awake if its view is there, else failed
 * opening, awake  ─ failed ─────────────▶ restart-waiting, or gave-up
 * awake           ─ away / over the cap ▶ hibernating
 * hibernating     ─ unloaded, or died ──▶ asleep
 *                 ─ refused, shown ─────▶ awake
 * asleep          ─ selected ───────────▶ opening(wake), or held if passing
 * held            ─ 1 s, a key ─────────▶ opening(wake);  ─ left ▶ asleep
 * restart-waiting ─ backoff over ───────▶ opening(restart)
 * gave-up         ─ unwanted ───────────▶ parked  ─ wanted again ▶ absent
 * any but parked  ─ unwanted ───────────▶ absent (forgotten)
 * ```
 *
 * The rules, each in one place:
 *
 * - **Only `plan` opens.** A folder is opened when it is wanted and absent,
 *   when its restart's backoff is over, and — the only way out of asleep — when
 *   it is the selected editor and not held. Revealing is never opening.
 * - **Waking waits for a pass to settle.** `Cmd+Q N/P` landing on an asleep
 *   editor holds it `WAKE_DELAY_MS`; a typed key or the delay running out with
 *   it still selected wakes it, and moving on drops the hold.
 * - **The cap is a fact about the state, checked on every `plan`.** More than
 *   `awakeMax` sleepable workbenches up or opening, and the least recently
 *   shown awake ones go to sleep at once — never the selected one, never one
 *   opening, waking or closing, never one that has just refused (it said why;
 *   it is asked again on the minute check). Only a deliberate wake raises the
 *   count, and passing never wakes, so stepping through many Workspaces moves
 *   nothing; each wake puts at most one other to sleep. A folder that would
 *   start past the cap, not selected, starts asleep instead of being opened to
 *   be closed.
 * - **Time-based sleep is the minute check** (`tick`): away at least
 *   `hibernateAfterMs`.
 * - **A failure is counted once** (`EditorSupervisor`): restart after a
 *   backoff that doubles, give up after `MAX_EDITOR_RESTARTS`, and the verdict
 *   is parked until a person brings the folder back (Retry, Locate…). A view
 *   ending while it hibernates is the sleep it was going to.
 * - **The placeholder is the phase.** What stands in the editor's slot —
 *   "Restarting…", "休止中" with the frame it left, "起動中…" — is derived from
 *   the phase (`placeholderOf`) and re-sent whenever it changes, so it cannot
 *   outlive the state it describes.
 *
 * Scratch is a Workspace like any other here: it sleeps and counts toward the
 * cap. SSH and dev container workbenches never sleep: their input says
 * `sleepable: false` and nothing here hibernates or counts them.
 *
 * Every transition and every skipped hibernation or wake is one log line,
 * `[devhub] workbench '<folder>' …`.
 */

import type { EditorPlaceholderWire } from "../../ipc/contract.js";
import { EditorSupervisor } from "./editorSupervisor.js";

/** Checked this often: time-based sleep, and the cap's retry of a refusal. */
export const HIBERNATE_CHECK_MS = 60_000;

/** `Cmd+Q N/P` landing on an asleep editor wakes it after this, if still there. */
export const WAKE_DELAY_MS = 1_000;

/**
 * An open whose load has not been heard by then is settled anyway: up if its
 * view is there (shown as it is), failed if not. Three times the open's own
 * deadline (`EDITOR_OPEN_TIMEOUT_MS`), so it only ever catches a load nobody
 * reported, and longer than the minute check, which it must not race.
 */
export const OPEN_SETTLE_MS = 90_000;

/** Why a workbench is being opened, which is what its slot says meanwhile. */
export type OpenCause = "start" | "restart" | "wake";

/** Where one folder's workbench is. A folder with no record is `absent`. */
export type WorkbenchPhase =
	| { readonly kind: "absent" }
	/** An open in flight, or a view that has not finished loading. */
	| {
			readonly kind: "opening";
			readonly cause: OpenCause;
			/** A waking one's frame from before it slept. */
			readonly frame: string;
	  }
	| { readonly kind: "awake" }
	/** Being asked whether it may sleep, or unloading. */
	| {
			readonly kind: "hibernating";
			readonly why: "away" | "cap";
			/** It was the selected editor again since this began. */
			readonly shown: boolean;
	  }
	/** No view; `frame` is what it showed when it went, a data URL or "". */
	| { readonly kind: "asleep"; readonly frame: string }
	/** Asleep and selected, but only passed through: wakes at `until`. */
	| { readonly kind: "held"; readonly frame: string; readonly until: number }
	/** Failed; opened again at `until`. */
	| { readonly kind: "restart-waiting"; readonly until: number }
	/** Failed too often, still wanted until the report makes it unavailable. */
	| {
			readonly kind: "gave-up";
			readonly reason: string;
			readonly attempt: number;
	  }
	/** Given up on and no longer wanted; wanted again is a person asking. */
	| { readonly kind: "parked" };

/** What the editor's slot shows instead of a workbench. */
export type EditorPlaceholder = EditorPlaceholderWire;

/** The placeholder a phase stands for; nothing where the workbench is itself. */
export function placeholderOf(
	phase: WorkbenchPhase,
): EditorPlaceholder | undefined {
	switch (phase.kind) {
		case "opening":
			return phase.cause === "restart"
				? { kind: "restarting" }
				: phase.cause === "wake"
					? { kind: "waking", frame: phase.frame }
					: { kind: "starting" };
		case "restart-waiting":
			return { kind: "restarting" };
		case "asleep":
		case "held":
			return { kind: "asleep", frame: phase.frame };
		case "absent":
		case "awake":
		case "hibernating":
		case "gave-up":
		case "parked":
			return undefined;
	}
}

/** One Workspace that wants a workbench, as `plan` needs it. */
export interface WantedWorkbench {
	readonly folder: string;
	/** The page's name for its editor slot (`workspace-editor:<id>`). */
	readonly surfaceKey: string;
	/** Not SSH or a dev container. */
	readonly sleepable: boolean;
	/** Its close is running: its view goes at the close's view step. */
	readonly closing: boolean;
	/** Off screen this long, or nothing while it is shown (or has no view). */
	readonly awayMs: number | undefined;
	/**
	 * Started only when shown: absent and not the selected editor, it is
	 * asleep without ever having been opened, and the first time it is shown
	 * is its wake. Every Workspace is, in DevHub: its editor area shows its
	 * terminal until `Cmd+Q E` asks for its workbench (`docs/terminal-mode.md`),
	 * so no workbench is started for one nobody has looked at. Absent is the
	 * eager start: opened as soon as it is wanted.
	 */
	readonly lazy?: boolean;
}

export interface LifecycleInput {
	readonly now: number;
	/** Every Workspace that wants a workbench, in the projection's order. */
	readonly wanted: readonly WantedWorkbench[];
	/** The folder of the editor the selection shows, if any. */
	readonly selected: string | undefined;
	/** Folders with a live view now. */
	readonly views: readonly string[];
	/**
	 * Folders whose open is still in flight, or whose view's page is still
	 * loading. An opening folder in neither is settled by this plan — up if
	 * its view is there (its load was not heard), failed if not (its open
	 * ended without one) — so `opening` cannot outlive what it waits for.
	 * Absent, every opening folder is taken to be loading.
	 */
	readonly loading?: readonly string[];
	/** `general.workbench_awake_max`; 0 for no cap. */
	readonly awakeMax: number;
	/** `general.workbench_hibernate_minutes`, in ms; 0 for never. */
	readonly hibernateAfterMs: number;
	/** The minute check: time-based sleep, and the cap asks refusals again. */
	readonly tick?: boolean;
}

/** What the executor carries out, in this order. */
export type LifecycleEffect =
	| {
			readonly kind: "placeholder";
			readonly folder: string;
			readonly surfaceKey: string;
			readonly placeholder: EditorPlaceholder | undefined;
	  }
	| { readonly kind: "dispose"; readonly folder: string }
	| {
			readonly kind: "report-gave-up";
			readonly folder: string;
			readonly reason: string;
			readonly attempt: number;
	  }
	| {
			readonly kind: "open";
			readonly folder: string;
			readonly cause: OpenCause;
	  }
	| {
			readonly kind: "hibernate";
			readonly folder: string;
			readonly why: "away" | "cap";
	  };

interface WorkbenchRecord {
	phase: WorkbenchPhase;
	surfaceKey: string;
	/** The cap does not ask again before this; it said why it stays. */
	excusedUntil: number;
	/** Its gave-up verdict has been handed to the executor. */
	reported: boolean;
	/** When it last went `opening`. */
	openingSince: number;
}

const ORDER: Record<LifecycleEffect["kind"], number> = {
	placeholder: 0,
	dispose: 1,
	"report-gave-up": 2,
	open: 3,
	hibernate: 4,
};

export class WorkbenchLifecycle {
	private readonly records = new Map<string, WorkbenchRecord>();
	/** Where the placeholder each surface was last told stands. */
	private readonly told = new Map<
		string,
		{ readonly surfaceKey: string; readonly text: string }
	>();
	/** The editor `Cmd+Q N/P` last landed on, and when its wake may start. */
	private hold: { readonly folder: string; until: number } | undefined;
	private selected: string | undefined;
	/** The last thing said about the cap, so it is said once. */
	private capNote = "";
	/** The last thing said about a selected one not woken, so it is said once. */
	private selectedNote = "";

	constructor(
		private readonly supervisor = new EditorSupervisor(),
		private readonly log: (line: string) => void = (line) => {
			console.log(line);
		},
	) {}

	phase(folder: string): WorkbenchPhase {
		return this.records.get(folder)?.phase ?? { kind: "absent" };
	}

	/** Every folder in a phase, for the executor's questions. */
	foldersIn(kind: WorkbenchPhase["kind"]): string[] {
		return [...this.records]
			.filter(([, record]) => record.phase.kind === kind)
			.map(([folder]) => folder);
	}

	placeholder(folder: string): EditorPlaceholder | undefined {
		return placeholderOf(this.phase(folder));
	}

	/** When `plan` must run again even if nothing else happens. */
	nextDeadline(): number | undefined {
		const deadlines = [...this.records.values()].flatMap(
			({ phase, openingSince }) =>
				phase.kind === "held" || phase.kind === "restart-waiting"
					? [phase.until]
					: phase.kind === "opening"
						? [openingSince + OPEN_SETTLE_MS]
						: [],
		);
		return deadlines.length === 0 ? undefined : Math.min(...deadlines);
	}

	//#region events

	/** `Cmd+Q N/P` is landing on this folder's editor, maybe only passing. */
	pass(folder: string | undefined, now: number): void {
		this.dropHold("passed on");
		if (folder === undefined) return;
		this.hold = { folder, until: now + WAKE_DELAY_MS };
	}

	/**
	 * Something needs this folder's workbench now — a request routed to it
	 * (an empty window, a file opened in Scratch): a wake held for a passing
	 * `Cmd+Q N/P` on it starts at the next `plan` instead of after the delay.
	 */
	needed(folder: string, now: number): void {
		if (this.hold?.folder === folder && this.hold.until > now) {
			this.hold.until = now;
			if (this.phase(folder).kind === "held") {
				this.say(folder, "hold released: needed now");
			}
		}
	}

	/** A key was typed: a held wake starts now. True when one was held. */
	typed(now: number): boolean {
		if (!this.hold || this.hold.until <= now) return false;
		this.hold.until = now;
		if (this.phase(this.hold.folder).kind === "held") {
			this.say(this.hold.folder, "hold released by a typed key");
		}
		return true;
	}

	/** Its view finished loading (again). */
	loaded(folder: string, now: number): void {
		const record = this.records.get(folder);
		if (record?.phase.kind === "opening") {
			this.move(folder, record, { kind: "awake" });
		}
		if (record?.phase.kind === "awake") this.supervisor.loaded(folder, now);
	}

	/**
	 * There is no workbench for this folder and DevHub did not mean that: an
	 * open that rejected or produced nothing, a view that died.
	 */
	failed(folder: string, reason: string, now: number): void {
		const record = this.records.get(folder);
		if (!record) return;
		const { phase } = record;
		if (phase.kind === "hibernating") {
			// It was going anyway; whatever it was asked, it is asleep now.
			this.move(folder, record, { kind: "asleep", frame: "" }, reason);
			return;
		}
		if (phase.kind !== "opening" && phase.kind !== "awake") {
			this.say(folder, `failure ignored while ${phase.kind}: ${reason}`);
			return;
		}
		const verdict = this.supervisor.failed(folder, now);
		this.move(
			folder,
			record,
			verdict.kind === "restart"
				? { kind: "restart-waiting", until: now + verdict.delayMs }
				: { kind: "gave-up", reason, attempt: verdict.attempt },
			verdict.kind === "restart"
				? `attempt ${String(verdict.attempt)}, in ${String(verdict.delayMs)} ms: ${reason}`
				: `after ${String(verdict.attempt)} failures: ${reason}`,
		);
	}

	/** An open that ended with the folder no longer wanted. */
	abandoned(folder: string): void {
		const record = this.records.get(folder);
		if (record?.phase.kind === "opening") {
			this.move(folder, record, { kind: "absent" }, "no longer wanted");
		}
	}

	/** DevHub took the view down itself (a close, a reattach). */
	disposed(folder: string): void {
		const record = this.records.get(folder);
		if (!record) return;
		const kind = record.phase.kind;
		if (kind === "opening" || kind === "awake" || kind === "hibernating") {
			this.move(folder, record, { kind: "absent" }, "taken down");
		}
	}

	/** Whether a hibernation may still go ahead: not shown since it began. */
	mayHibernate(folder: string): boolean {
		const phase = this.phase(folder);
		return phase.kind === "hibernating" && !phase.shown;
	}

	/** The unload went through; the view is for `plan` to dispose. */
	hibernated(folder: string, frame: string): void {
		const record = this.records.get(folder);
		if (record?.phase.kind === "asleep" && record.phase.frame === "") {
			// Its view ended during the unload, before this said it was done.
			record.phase = { kind: "asleep", frame };
			return;
		}
		if (record?.phase.kind !== "hibernating") return;
		this.move(folder, record, { kind: "asleep", frame });
	}

	/** It stays up, and why; the cap leaves it be until the minute check. */
	hibernateSkipped(folder: string, reason: string, now: number): void {
		const record = this.records.get(folder);
		if (record?.phase.kind !== "hibernating") return;
		record.excusedUntil = now + HIBERNATE_CHECK_MS;
		this.move(folder, record, { kind: "awake" }, `stays awake: ${reason}`);
	}

	//#endregion

	/**
	 * What to do now, given the projection and the selection — and the phases
	 * moved to match, so a second call before anything happens asks for
	 * nothing twice.
	 */
	plan(input: LifecycleInput): LifecycleEffect[] {
		const effects: LifecycleEffect[] = [];
		const wanted = new Map(input.wanted.map((one) => [one.folder, one]));
		const views = new Set(input.views);
		const selected =
			input.selected !== undefined && wanted.has(input.selected)
				? input.selected
				: undefined;
		if (this.hold && this.hold.folder !== selected) this.dropHold("left");
		this.selected = selected;

		const loading =
			input.loading === undefined ? undefined : new Set(input.loading);
		// Not wanted: a closed Workspace, or one whose folder is gone. A verdict
		// is kept (parked); everything else is forgotten.
		for (const [folder, record] of this.records) {
			if (wanted.has(folder)) continue;
			if (record.phase.kind === "gave-up" || record.phase.kind === "parked") {
				if (record.phase.kind === "gave-up") {
					this.move(folder, record, { kind: "parked" });
				}
				continue;
			}
			this.move(folder, record, { kind: "absent" }, "no longer wanted");
			this.records.delete(folder);
			this.supervisor.forget(folder);
		}

		// A view where there should be none: its Workspace has gone, or it has
		// just been unloaded to sleep. Taken down before anything else, so a
		// folder woken in this same plan opens a fresh one.
		for (const folder of input.views) {
			const kind = this.phase(folder).kind;
			if (
				!wanted.has(folder) ||
				kind === "asleep" ||
				kind === "held" ||
				kind === "parked" ||
				kind === "gave-up"
			) {
				effects.push({ kind: "dispose", folder });
				views.delete(folder);
			}
		}

		// The selected one first: it is the one somebody is waiting for.
		const order = [...input.wanted].sort(
			(a, b) => Number(b.folder === selected) - Number(a.folder === selected),
		);
		for (const one of order) {
			this.step(one, one.folder === selected, views, loading, input, effects);
		}
		this.noteSelected(selected, input.now);

		this.hibernateAway(input, effects);
		this.cap(input, effects);

		for (const [folder, record] of this.records) {
			if (record.phase.kind === "gave-up" && !record.reported) {
				record.reported = true;
				effects.push({
					kind: "report-gave-up",
					folder,
					reason: record.phase.reason,
					attempt: record.phase.attempt,
				});
			}
		}
		effects.push(...this.placeholders(wanted));
		return effects.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
	}

	/** One wanted folder's own transitions. */
	private step(
		one: WantedWorkbench,
		isSelected: boolean,
		views: ReadonlySet<string>,
		loading: ReadonlySet<string> | undefined,
		input: LifecycleInput,
		effects: LifecycleEffect[],
	): void {
		const { folder } = one;
		const { now } = input;
		let record = this.records.get(folder);
		if (record) record.surfaceKey = one.surfaceKey;
		const open = (target: WorkbenchRecord, cause: OpenCause, frame = "") => {
			target.openingSince = now;
			this.move(folder, target, { kind: "opening", cause, frame });
			effects.push({ kind: "open", folder, cause });
		};
		if (record?.phase.kind === "parked") {
			// Wanted again after giving up: a person asked (Retry, Locate…).
			this.supervisor.forget(folder);
			this.move(folder, record, { kind: "absent" }, "asked for again");
			this.records.delete(folder);
			record = undefined;
		}
		if (!record) {
			record = {
				phase: { kind: "absent" },
				surfaceKey: one.surfaceKey,
				excusedUntil: 0,
				reported: false,
				openingSince: 0,
			};
			this.records.set(folder, record);
		}
		const { phase } = record;
		switch (phase.kind) {
			case "absent":
				if (views.has(folder)) {
					// VS Code opened it on its own (a reload, a reopen).
					this.move(folder, record, { kind: "awake" }, "adopted");
				} else if (one.closing) {
					// Its view went with the close; nothing reopens it meanwhile.
				} else if (!isSelected && one.lazy === true) {
					this.move(
						folder,
						record,
						{ kind: "asleep", frame: "" },
						"not started: not shown yet",
					);
				} else if (
					!isSelected &&
					one.sleepable &&
					input.awakeMax > 0 &&
					this.awakeCount(input) >= input.awakeMax
				) {
					this.move(
						folder,
						record,
						{ kind: "asleep", frame: "" },
						`not started: ${String(input.awakeMax)} already awake`,
					);
				} else {
					open(record, "start");
				}
				return;
			case "awake":
				if (!views.has(folder) && !one.closing) {
					open(record, "start");
				}
				return;
			case "restart-waiting":
				if (views.has(folder)) {
					// The open it gave up waiting for arrived after all.
					this.move(folder, record, { kind: "awake" }, "adopted, late");
				} else if (now >= phase.until) {
					open(record, "restart");
				}
				return;
			case "hibernating":
				if (isSelected && !phase.shown) {
					this.say(folder, "shown again while hibernating");
					record.phase = { ...phase, shown: true };
				}
				return;
			case "asleep":
			case "held": {
				if (!isSelected) {
					if (phase.kind === "held") {
						this.move(folder, record, { kind: "asleep", frame: phase.frame });
					}
					return;
				}
				const hold = this.hold?.folder === folder ? this.hold : undefined;
				if (hold && now < hold.until) {
					if (phase.kind !== "held" || phase.until !== hold.until) {
						this.move(
							folder,
							record,
							{ kind: "held", frame: phase.frame, until: hold.until },
							`wake held ${String(hold.until - now)} ms: passing through`,
						);
					}
					return;
				}
				if (hold) this.hold = undefined;
				open(record, "wake", phase.frame);
				return;
			}
			case "opening": {
				// Nothing more is coming for it: the loaded event was missed (a
				// page that finished before anyone listened), or the open's
				// effect never ran. Left alone it would say "起動中…" for ever and
				// count against the cap without ever being one it could put to
				// sleep.
				const waiting =
					loading === undefined || loading.has(folder)
						? now - record.openingSince < OPEN_SETTLE_MS
						: false;
				if (waiting) return;
				if (views.has(folder)) {
					this.move(
						folder,
						record,
						{ kind: "awake" },
						loading?.has(folder) === false
							? "adopted: its load was not heard"
							: `adopted: still loading after ${String(OPEN_SETTLE_MS)} ms`,
					);
					this.supervisor.loaded(folder, now);
				} else {
					this.failed(
						folder,
						loading?.has(folder) === false
							? "Its open ended without a workbench."
							: `The workbench did not open within ${String(OPEN_SETTLE_MS / 1_000)} seconds.`,
						now,
					);
				}
				return;
			}
			case "gave-up":
			case "parked":
				return;
		}
	}

	/**
	 * The selected editor is asleep, held or still opening at the end of a
	 * plan: one line saying why it is not up yet, said when that changes.
	 */
	private noteSelected(selected: string | undefined, now: number): void {
		const phase = selected === undefined ? undefined : this.phase(selected);
		let note = "";
		if (selected !== undefined && phase !== undefined) {
			const record = this.records.get(selected);
			if (phase.kind === "held") {
				note = `wake held until ${String(phase.until)}: passing through`;
			} else if (phase.kind === "asleep") {
				note = "asleep, no open planned";
			} else if (
				phase.kind === "opening" &&
				record !== undefined &&
				now - record.openingSince >= WAKE_DELAY_MS * 10
			) {
				note = `still opening (${phase.cause}) since ${String(record.openingSince)}`;
			}
			if (note !== "")
				note = `[devhub] workbench '${selected}' selected, not up: ${note}`;
		}
		if (note !== "" && note !== this.selectedNote) this.log(note);
		this.selectedNote = note;
	}

	/** The sleepable workbenches up or on their way up. */
	private awakeCount(input: LifecycleInput): number {
		return input.wanted.filter((one) => {
			const kind = this.phase(one.folder).kind;
			return one.sleepable && (kind === "awake" || kind === "opening");
		}).length;
	}

	/** Whether this one may be put to sleep now, or why not. */
	private refusal(one: WantedWorkbench): string | undefined {
		const phase = this.phase(one.folder);
		if (!one.sleepable) return "never sleeps";
		if (phase.kind !== "awake") return `is ${phase.kind}`;
		if (one.folder === this.selected || one.awayMs === undefined)
			return "is shown";
		if (one.closing) return "is closing";
		return undefined;
	}

	private hibernateAway(input: LifecycleInput, effects: LifecycleEffect[]) {
		const after = input.hibernateAfterMs;
		if (input.tick !== true || !(after > 0)) return;
		for (const one of input.wanted) {
			if (!one.sleepable || (one.awayMs ?? 0) < after) continue;
			const phase = this.phase(one.folder);
			if (phase.kind === "asleep" || phase.kind === "hibernating") continue;
			const refused = this.refusal(one);
			if (refused !== undefined) {
				this.say(one.folder, `away, not hibernating: ${refused}`);
				continue;
			}
			this.startHibernating(one.folder, "away", effects);
		}
	}

	/** Over `awakeMax`: the least recently shown go to sleep, now. */
	private cap(input: LifecycleInput, effects: LifecycleEffect[]): void {
		const max = input.awakeMax;
		const count = this.awakeCount(input);
		if (!(max > 0) || count <= max) {
			this.capNote = "";
			return;
		}
		const tick = input.tick === true;
		const candidates = input.wanted
			.filter(
				(one) =>
					this.refusal(one) === undefined &&
					(tick ||
						(this.records.get(one.folder)?.excusedUntil ?? 0) <= input.now),
			)
			.sort((a, b) => (b.awayMs ?? 0) - (a.awayMs ?? 0));
		const chosen = candidates.slice(0, count - max);
		for (const one of chosen) {
			this.startHibernating(
				one.folder,
				"cap",
				effects,
				`${String(count)} awake, cap ${String(max)}`,
			);
		}
		const left = count - chosen.length;
		if (left <= max) {
			this.capNote = "";
			return;
		}
		const why = input.wanted
			.filter((one) => one.sleepable)
			.flatMap((one) => {
				if (chosen.includes(one)) return [];
				const refused =
					this.refusal(one) ??
					((this.records.get(one.folder)?.excusedUntil ?? 0) > input.now
						? "refused a moment ago"
						: undefined);
				return refused === undefined ? [] : [`'${one.folder}' ${refused}`];
			})
			.join(", ");
		const note = `[devhub] workbench cap: ${String(left)} awake, cap ${String(max)}, none more may sleep (${why})`;
		if (note !== this.capNote) this.log(note);
		this.capNote = note;
	}

	private startHibernating(
		folder: string,
		why: "away" | "cap",
		effects: LifecycleEffect[],
		detail?: string,
	): void {
		const record = this.records.get(folder);
		if (!record) return;
		this.move(
			folder,
			record,
			{ kind: "hibernating", why, shown: false },
			detail ?? why,
		);
		effects.push({ kind: "hibernate", folder, why });
	}

	/** Every placeholder that is not what its surface was last told. */
	private placeholders(
		wanted: ReadonlyMap<string, WantedWorkbench>,
	): LifecycleEffect[] {
		const effects: LifecycleEffect[] = [];
		// A folder forgotten with a placeholder up: take it down — first, since
		// its surface may be the one a relocated Workspace's new folder is
		// about to be told about (the same Workspace, so the same slot).
		for (const [folder, told] of this.told) {
			if (this.records.has(folder)) continue;
			effects.push({
				kind: "placeholder",
				folder,
				surfaceKey: told.surfaceKey,
				placeholder: undefined,
			});
			this.told.delete(folder);
		}
		for (const [folder, record] of this.records) {
			const placeholder = wanted.has(folder)
				? placeholderOf(record.phase)
				: undefined;
			const text = JSON.stringify(placeholder ?? null);
			const told = this.told.get(folder);
			if (told?.text === text && told.surfaceKey === record.surfaceKey) {
				continue;
			}
			if (told === undefined && placeholder === undefined) continue;
			if (told && told.surfaceKey !== record.surfaceKey) {
				effects.push({
					kind: "placeholder",
					folder,
					surfaceKey: told.surfaceKey,
					placeholder: undefined,
				});
			}
			effects.push({
				kind: "placeholder",
				folder,
				surfaceKey: record.surfaceKey,
				placeholder,
			});
			if (placeholder === undefined) this.told.delete(folder);
			else this.told.set(folder, { surfaceKey: record.surfaceKey, text });
		}
		return effects;
	}

	private move(
		folder: string,
		record: WorkbenchRecord,
		to: WorkbenchPhase,
		detail?: string,
	): void {
		const from = record.phase.kind;
		record.phase = to;
		if (to.kind !== "gave-up") record.reported = false;
		this.say(
			folder,
			`${from} -> ${to.kind}${to.kind === "opening" ? ` (${to.cause})` : ""}${
				detail === undefined ? "" : `: ${detail}`
			}`,
		);
	}

	private dropHold(why: string): void {
		if (!this.hold) return;
		const { folder } = this.hold;
		this.hold = undefined;
		// Said only where it held something back: every N/P sets one.
		if (this.phase(folder).kind === "held") {
			this.say(folder, `hold dropped: ${why}`);
		}
	}

	private say(folder: string, what: string): void {
		this.log(`[devhub] workbench '${folder}' ${what}`);
	}
}
