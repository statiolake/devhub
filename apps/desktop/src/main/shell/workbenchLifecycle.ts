/**
 * Every Workspace's workbench, from its start to frozen, discarded and back:
 * the facts, and the driver that acts on them.
 *
 * A workbench is a `WebContentsView` running VS Code for one folder, with
 * its own extension host(s) and language servers. What it should be doing is
 * decided by one pure function, `decide` (`workbenchPlan.ts`), from facts
 * this module holds and nothing else holds: its phase, whether it is shown,
 * asked for or closing, when it was last shown, whether it has settled, the
 * renderer's last answer about what a freeze would interrupt (`Probe`), when
 * its sockets last talked, and when a connection last arrived for it.
 *
 * The controller (`AppController`, the executor) reports what happened — an
 * open settled, a view finished loading or died, a probe answered, traffic,
 * a connection, an unload finished — and asks `plan` what to do. `plan`
 * reads the projection and the selection, updates the facts, asks `decide`,
 * moves each phase to match what it answers (so a second plan before anything
 * happens asks for nothing twice), and returns the effects to carry out:
 * open, probe, freeze, thaw, discard, dispose, report giving up, and the
 * placeholder for each slot. It reads no clock and runs no timer: every call
 * is given `now`, and `nextDeadline` says when it next needs a `plan`.
 *
 * Failures are bookkeeping, not policy, and stay here: an open nobody
 * settled, a view that died (`EditorSupervisor`: restart after a backoff that
 * doubles, give up after `MAX_EDITOR_RESTARTS`, parked until a person brings
 * the folder back with Retry or Locate…).
 *
 * The placeholder is the phase (`placeholderOf`), re-sent whenever it
 * changes, so it cannot outlive the state it describes.
 *
 * Every transition is one log line, `[devhub] workbench '<folder>' …`.
 */

import type { WorkbenchStateWire } from "../../ipc/taskManager.js";
import { EditorSupervisor } from "./editorSupervisor.js";
import {
	QUIET_MS,
	awakeReasons,
	decide,
	nextDecision,
	placeholderOf,
	workbenchStateOf,
	type EditorPlaceholder,
	type OpenCause,
	type PlanFacts,
	type Probe,
	type WorkbenchFacts,
	type WorkbenchPhase,
} from "./workbenchPlan.js";

export {
	placeholderOf,
	workbenchStateOf,
	type EditorPlaceholder,
	type OpenCause,
	type WorkbenchPhase,
};

/** A renderer and its window's utilities below this are quiet. */
export const CPU_QUIET_PERCENT = 10;

/**
 * Who asked for a workbench, which starts a discarded one (an absent one
 * starts by being shown, or by its turn):
 *
 * - `asked`: Enter or a click on its placeholder.
 * - `opened`: the Workspace was opened (`Cmd+Q F`, a folder from the command
 *   line, VS Code's own open) — not as a side effect of starting an Agent.
 */
export type WakeReason = "asked" | "opened";

/**
 * An open whose load has not been heard by then is settled anyway: up if its
 * view is there (shown as it is), failed if not. Three times the open's own
 * deadline (`EDITOR_OPEN_TIMEOUT_MS`), so it only ever catches a load nobody
 * reported.
 */
export const OPEN_SETTLE_MS = 90_000;

/** One Workspace that wants a workbench, as `plan` needs it. */
export interface WantedWorkbench {
	readonly folder: string;
	/** The page's name for its editor slot (`workspace-editor:<id>`). */
	readonly surfaceKey: string;
	/** Local: not SSH or a dev container, which are never frozen or discarded. */
	readonly freezable: boolean;
	/** Its close is running: its view goes at the close's view step. */
	readonly closing: boolean;
}

export interface LifecycleInput {
	readonly now: number;
	/** Every Workspace that wants a workbench, in the Sidebar's order. */
	readonly wanted: readonly WantedWorkbench[];
	/** The folder of the editor on screen, if any. */
	readonly selected: string | undefined;
	/** Folders with a live view now. */
	readonly views: readonly string[];
	/**
	 * Folders whose open is still in flight, or whose view's page is still
	 * loading. A starting folder in neither is settled by this plan — up if
	 * its view is there (its load was not heard), failed if not — so
	 * `starting` cannot outlive what it waits for. Absent, every starting
	 * folder is taken to be loading.
	 */
	readonly loading?: readonly string[];
	/** `general.workbench_discard_minutes`, in ms; 0 for never. */
	readonly discardAfterMs: number;
	/** `general.workbench_freeze`: false freezes nothing and thaws the frozen. */
	readonly freezing: boolean;
	/** Somebody asked, with this plan, for this folder's workbench. */
	readonly ask?: { readonly folder: string; readonly why: WakeReason };
	/**
	 * Folders a DevHub request is waiting on (`AppController.workbenchFor`):
	 * a file routed to it, a command, its close. Each is kept running —
	 * thawed, started, never frozen — while its request waits.
	 */
	readonly requests?: readonly string[];
	/**
	 * Folders DevHub is talking to and must not freeze meanwhile — a close
	 * asking about unsaved work. Thawed if frozen; never started for this.
	 */
	readonly holds?: readonly string[];
	/** A person asked for this one to be frozen now (the Task Manager's Sleep). */
	readonly freeze?: string;
	/**
	 * Folders whose renderer process also hosts other contents — another
	 * workbench, or one of DevHub's own pages. Never frozen.
	 */
	readonly sharedRenderers?: readonly string[];
	/**
	 * Folders whose processes are stopped now (`WorkbenchFreezer`). One that
	 * is not `frozen` any more — it failed, its view went, it is no longer
	 * wanted — is thawed by this plan: nothing stays stopped that the
	 * lifecycle does not know to be frozen.
	 */
	readonly stopped?: readonly string[];
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
	| { readonly kind: "thaw"; readonly folder: string }
	| {
			readonly kind: "open";
			readonly folder: string;
			readonly cause: OpenCause;
			readonly background: boolean;
	  }
	| { readonly kind: "probe"; readonly folder: string }
	| { readonly kind: "freeze"; readonly folder: string }
	| { readonly kind: "discard"; readonly folder: string };

/** What a probe brings back: the renderer's answer, and main's CPU reading. */
export interface ProbeAnswer {
	/** A debug session, a running task, a terminal with a program in front. */
	readonly busy: readonly string[];
	/** Its window restored and its extensions registered. */
	readonly ready: boolean;
	/** Its renderer's and window utilities' CPU, summed. */
	readonly cpuPercent: number;
}

interface WorkbenchRecord {
	phase: WorkbenchPhase;
	surfaceKey: string;
	/** Its gave-up verdict has been handed to the executor. */
	reported: boolean;
	lastShownAt: number | undefined;
	hiddenSince: number | undefined;
	settled: boolean;
	/** Since when every probe found it ready and quiet. */
	quietSince: number | undefined;
	probe: Probe | undefined;
	probing: boolean;
	trafficAt: number | undefined;
	connectionAt: number | undefined;
	/** As the last plan saw it, for the executor's last-moment checks. */
	shown: boolean;
	asked: boolean;
	held: boolean;
}

const ORDER: Record<LifecycleEffect["kind"], number> = {
	placeholder: 0,
	// Before its view is destroyed: a stopped renderer cannot end.
	thaw: 1,
	dispose: 2,
	"report-gave-up": 3,
	open: 4,
	probe: 5,
	freeze: 6,
	discard: 7,
};

export class WorkbenchLifecycle {
	private readonly records = new Map<string, WorkbenchRecord>();
	/** Where the placeholder each surface was last told stands. */
	private readonly told = new Map<
		string,
		{
			readonly surfaceKey: string;
			readonly text: string;
			readonly placeholder: EditorPlaceholder;
		}
	>();
	/** The facts the last plan decided on, for `nextDeadline`. */
	private lastFacts: PlanFacts | undefined;
	/** The last thing said about why each hidden one stays up, said once. */
	private readonly awakeNotes = new Map<string, string>();

	constructor(
		private readonly supervisor = new EditorSupervisor(),
		private readonly log: (line: string) => void = (line) => {
			console.log(line);
		},
	) {}

	phase(folder: string): WorkbenchPhase {
		return this.records.get(folder)?.phase ?? { kind: "absent" };
	}

	/** The Task Manager's word for one folder's workbench. */
	state(folder: string): WorkbenchStateWire {
		return workbenchStateOf(this.phase(folder));
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

	/**
	 * Every placeholder standing now, as the `placeholder` effects last said
	 * it: what a page that was not listening then — the window's own page
	 * still loading at launch, or reloaded — must be told when it starts to.
	 */
	standing(): {
		readonly surfaceKey: string;
		readonly placeholder: EditorPlaceholder;
	}[] {
		return [...this.told.values()].map(({ surfaceKey, placeholder }) => ({
			surfaceKey,
			placeholder,
		}));
	}

	/** When `plan` must run again even if nothing else happens. */
	nextDeadline(): number | undefined {
		const deadlines = [...this.records.values()].flatMap(({ phase }) =>
			phase.kind === "restart-waiting"
				? [phase.until]
				: phase.kind === "starting"
					? [phase.since + OPEN_SETTLE_MS]
					: [],
		);
		const decision =
			this.lastFacts === undefined ? undefined : nextDecision(this.lastFacts);
		if (decision !== undefined) deadlines.push(decision);
		return deadlines.length === 0 ? undefined : Math.min(...deadlines);
	}

	/**
	 * Whether a discard may still go ahead: nobody has shown or asked for it
	 * since it began. Asked by the executor at the last moment before the
	 * unload, from the facts as the latest plan left them.
	 */
	mayDiscard(folder: string): boolean {
		const record = this.records.get(folder);
		return (
			record?.phase.kind === "discarding" &&
			!record.shown &&
			!record.asked &&
			!record.held
		);
	}

	//#region events

	/** Its view finished loading (again). */
	loaded(folder: string, now: number): void {
		const record = this.records.get(folder);
		if (record?.phase.kind === "starting") {
			this.move(folder, record, { kind: "running", since: now });
		}
		if (record?.phase.kind === "running") this.supervisor.loaded(folder, now);
	}

	/**
	 * There is no workbench for this folder and DevHub did not mean that: an
	 * open that rejected or produced nothing, a view that died.
	 */
	failed(folder: string, reason: string, now: number): void {
		const record = this.records.get(folder);
		if (!record) return;
		const { phase } = record;
		if (phase.kind === "discarding") {
			// It was going anyway; whatever was asked, it is gone now.
			this.move(folder, record, { kind: "discarded", frame: "" }, reason);
			return;
		}
		if (
			phase.kind !== "starting" &&
			phase.kind !== "running" &&
			phase.kind !== "frozen"
		) {
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
		if (record?.phase.kind === "starting") {
			this.move(folder, record, { kind: "absent" }, "no longer wanted");
		}
	}

	/** DevHub took the view down itself (a close, a reattach). */
	disposed(folder: string): void {
		const record = this.records.get(folder);
		if (!record) return;
		const kind = record.phase.kind;
		if (
			kind === "starting" ||
			kind === "running" ||
			kind === "frozen" ||
			kind === "discarding"
		) {
			this.move(folder, record, { kind: "absent" }, "taken down");
		}
	}

	/** A probe answered. */
	probed(folder: string, answer: ProbeAnswer, now: number): void {
		const record = this.records.get(folder);
		if (!record) return;
		record.probing = false;
		if (record.phase.kind !== "running") return;
		record.probe = { at: now, busy: answer.busy };
		const quiet = answer.ready && answer.cpuPercent < CPU_QUIET_PERCENT;
		record.quietSince = quiet ? (record.quietSince ?? now) : undefined;
		if (
			!record.settled &&
			record.quietSince !== undefined &&
			now - record.quietSince >= QUIET_MS
		) {
			record.settled = true;
			this.say(folder, "settled");
		}
	}

	/** A probe got no answer: it counts as a reason to stay up, for now. */
	probeFailed(folder: string, reason: string, now: number): void {
		const record = this.records.get(folder);
		if (!record) return;
		record.probing = false;
		if (record.phase.kind !== "running") return;
		record.probe = { at: now, busy: [reason] };
	}

	/** Its sockets carried traffic. */
	traffic(folder: string, at: number): void {
		const record = this.records.get(folder);
		if (record) record.trafficAt = at;
	}

	/** A connection is waiting on a socket one of its frozen processes listens on. */
	connectionArrived(folder: string, now: number): void {
		const record = this.records.get(folder);
		if (!record) return;
		record.connectionAt = now;
		this.say(folder, "a connection arrived");
	}

	/** The freeze could not be carried out; it stays running for now. */
	freezeFailed(folder: string, reason: string, now: number): void {
		const record = this.records.get(folder);
		if (record?.phase.kind !== "frozen") return;
		record.probe = { at: now, busy: [reason] };
		this.move(folder, record, { kind: "running", since: now }, reason);
	}

	/** The unload went through; the view is for `plan` to dispose. */
	discarded(folder: string, frame: string): void {
		const record = this.records.get(folder);
		if (record?.phase.kind === "discarded" && record.phase.frame === "") {
			// Its view ended during the unload, before this said it was done.
			record.phase = { kind: "discarded", frame };
			return;
		}
		if (record?.phase.kind !== "discarding") return;
		this.move(folder, record, { kind: "discarded", frame });
	}

	/** It stays up (thawed), and why. */
	discardSkipped(folder: string, reason: string, now: number): void {
		const record = this.records.get(folder);
		if (record?.phase.kind !== "discarding") return;
		record.probe = { at: now, busy: [reason] };
		this.move(
			folder,
			record,
			{ kind: "running", since: now },
			`not discarded: ${reason}`,
		);
	}

	//#endregion

	/**
	 * What to do now, given the projection and the selection — and the phases
	 * moved to match, so a second call before anything happens asks for
	 * nothing twice.
	 */
	plan(input: LifecycleInput): LifecycleEffect[] {
		const effects: LifecycleEffect[] = [];
		const { now } = input;
		const wanted = new Map(input.wanted.map((one) => [one.folder, one]));
		const views = new Set(input.views);
		const selected =
			input.selected !== undefined && wanted.has(input.selected)
				? input.selected
				: undefined;
		const asked = new Set(input.requests ?? []);
		const held = new Set(input.holds ?? []);
		if (input.ask !== undefined) {
			asked.add(input.ask.folder);
			this.say(input.ask.folder, `asked for (${input.ask.why})`);
		}
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
			// A frozen one that goes is thawed first, so its processes can end.
			if (record.phase.kind === "frozen")
				effects.push({ kind: "thaw", folder });
			this.move(folder, record, { kind: "absent" }, "no longer wanted");
			this.records.delete(folder);
			this.supervisor.forget(folder);
			this.awakeNotes.delete(folder);
		}

		// A view where there should be none: its Workspace has gone, or it has
		// just been discarded. Taken down first, so a folder started again in
		// this same plan opens a fresh one.
		for (const folder of input.views) {
			const kind = this.phase(folder).kind;
			if (
				!wanted.has(folder) ||
				kind === "discarded" ||
				kind === "parked" ||
				kind === "gave-up"
			) {
				effects.push({ kind: "dispose", folder });
				views.delete(folder);
			}
		}

		for (const one of input.wanted) {
			const record = this.bookkeep(one, views, loading, now, effects);
			const shown = one.folder === selected;
			if (shown) {
				record.lastShownAt = now;
				record.hiddenSince = undefined;
			} else if (
				record.lastShownAt !== undefined &&
				record.hiddenSince === undefined
			) {
				record.hiddenSince = now;
			}
			record.shown = shown;
			record.asked = asked.has(one.folder);
			record.held = held.has(one.folder);
		}

		const shared = new Set(input.sharedRenderers ?? []);
		const facts: PlanFacts = {
			now,
			discardAfterMs: input.discardAfterMs,
			freeze: input.freezing,
			workbenches: input.wanted.map((one) =>
				this.factsOf(one, input.freeze === one.folder, shared.has(one.folder)),
			),
		};
		const actions = decide(facts);
		if (
			input.freeze !== undefined &&
			!actions.some(
				(action) => action.kind === "freeze" && action.folder === input.freeze,
			)
		) {
			const one = facts.workbenches.find((f) => f.folder === input.freeze);
			this.say(
				input.freeze,
				`asked to freeze, not frozen: ${
					one === undefined
						? "not wanted"
						: !facts.freeze
							? "freezing is off"
							: one.phase.kind !== "running"
								? `is ${one.phase.kind}`
								: awakeReasons(one, now).join(", ")
				}`,
			);
		}
		for (const action of actions) {
			const record = this.records.get(action.folder);
			if (!record) continue;
			switch (action.kind) {
				case "start":
					this.open(
						action.folder,
						record,
						action.cause,
						now,
						effects,
						action.background,
					);
					break;
				case "probe":
					record.probing = true;
					effects.push({ kind: "probe", folder: action.folder });
					break;
				case "freeze":
					this.move(
						action.folder,
						record,
						{ kind: "frozen", since: now },
						action.why,
					);
					effects.push({ kind: "freeze", folder: action.folder });
					break;
				case "thaw":
					// What it was doing before it froze says nothing about what
					// it is doing once it runs again: the next freeze probes anew.
					record.probe = undefined;
					this.move(
						action.folder,
						record,
						{ kind: "running", since: now },
						action.why,
					);
					effects.push({ kind: "thaw", folder: action.folder });
					break;
				case "discard": {
					const since =
						record.phase.kind === "frozen" ? record.phase.since : now;
					this.move(
						action.folder,
						record,
						{ kind: "discarding" },
						`frozen since ${String(since)}`,
					);
					effects.push({ kind: "discard", folder: action.folder });
					break;
				}
			}
		}
		// Moved by the actions: decided again only when something changes.
		this.lastFacts = {
			...facts,
			workbenches: input.wanted.map((one) =>
				this.factsOf(one, false, shared.has(one.folder)),
			),
		};
		this.noteAwake(this.lastFacts);

		// Stopped processes with no frozen phase behind them: a failure, a
		// dispose or a forgetting moved the phase without a thaw. They are
		// continued now — before any dispose or open in this plan (`ORDER`) —
		// so no process is left stopped that nothing would ever continue.
		for (const folder of input.stopped ?? []) {
			const kind = this.phase(folder).kind;
			if (kind === "frozen") continue;
			if (effects.some((e) => e.kind === "thaw" && e.folder === folder)) {
				continue;
			}
			this.say(folder, `thawed: its processes were stopped while ${kind}`);
			effects.push({ kind: "thaw", folder });
		}

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

	private factsOf(
		one: WantedWorkbench,
		freezeAsked: boolean,
		rendererShared: boolean,
	): WorkbenchFacts {
		const record = this.records.get(one.folder)!;
		return {
			folder: one.folder,
			phase: record.phase,
			freezable: one.freezable,
			shown: record.shown,
			asked: record.asked,
			held: record.held,
			closing: one.closing,
			lastShownAt: record.lastShownAt,
			hiddenSince: record.hiddenSince,
			settled: record.settled,
			probe: record.probe,
			probing: record.probing,
			trafficAt: record.trafficAt,
			connectionAt: record.connectionAt,
			rendererShared,
			freezeAsked,
		};
	}

	private open(
		folder: string,
		record: WorkbenchRecord,
		cause: OpenCause,
		now: number,
		effects: LifecycleEffect[],
		background = false,
	): void {
		const frame = record.phase.kind === "discarded" ? record.phase.frame : "";
		record.settled = false;
		record.quietSince = undefined;
		record.probe = undefined;
		record.probing = false;
		this.move(
			folder,
			record,
			{ kind: "starting", cause, frame, since: now },
			background ? "in the background" : undefined,
		);
		effects.push({ kind: "open", folder, cause, background });
	}

	/**
	 * One wanted folder's record, made if new, with what its view's comings
	 * and goings have settled: an adopted view, a restart whose backoff is
	 * over, an open nothing more is coming for.
	 */
	private bookkeep(
		one: WantedWorkbench,
		views: ReadonlySet<string>,
		loading: ReadonlySet<string> | undefined,
		now: number,
		effects: LifecycleEffect[],
	): WorkbenchRecord {
		const { folder } = one;
		let record = this.records.get(folder);
		if (record) record.surfaceKey = one.surfaceKey;
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
				reported: false,
				lastShownAt: undefined,
				hiddenSince: undefined,
				settled: false,
				quietSince: undefined,
				probe: undefined,
				probing: false,
				trafficAt: undefined,
				connectionAt: undefined,
				shown: false,
				asked: false,
				held: false,
			};
			this.records.set(folder, record);
		}
		const { phase } = record;
		switch (phase.kind) {
			case "absent":
				if (views.has(folder)) {
					// VS Code opened it on its own (a reload, a reopen).
					this.move(folder, record, { kind: "running", since: now }, "adopted");
				}
				break;
			case "running":
				if (!views.has(folder) && !one.closing) {
					this.open(folder, record, "start", now, effects);
				}
				break;
			case "restart-waiting":
				if (views.has(folder)) {
					// The open it gave up waiting for arrived after all.
					this.move(
						folder,
						record,
						{ kind: "running", since: now },
						"adopted, late",
					);
				} else if (now >= phase.until) {
					this.open(folder, record, "restart", now, effects);
				}
				break;
			case "starting": {
				// Nothing more is coming for it: the loaded event was missed (a
				// page that finished before anyone listened), or the open's
				// effect never ran.
				const waiting =
					loading === undefined || loading.has(folder)
						? now - phase.since < OPEN_SETTLE_MS
						: false;
				if (waiting) break;
				if (views.has(folder)) {
					this.move(
						folder,
						record,
						{ kind: "running", since: now },
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
				break;
			}
			case "frozen":
			case "discarding":
			case "discarded":
			case "gave-up":
			case "parked":
				break;
		}
		return record;
	}

	/** Why each hidden, running one is not frozen, said when it changes. */
	private noteAwake(facts: PlanFacts): void {
		for (const one of facts.workbenches) {
			const note =
				one.phase.kind === "running" && !one.shown && one.freezable
					? facts.freeze
						? awakeReasons(one, facts.now).join(", ")
						: "freezing is off"
					: "";
			if (note === (this.awakeNotes.get(one.folder) ?? "")) continue;
			this.awakeNotes.set(one.folder, note);
			if (note !== "") this.say(one.folder, `hidden, stays up: ${note}`);
		}
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
			else {
				this.told.set(folder, {
					surfaceKey: record.surfaceKey,
					text,
					placeholder,
				});
			}
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
			`${from} -> ${to.kind}${to.kind === "starting" ? ` (${to.cause})` : ""}${
				detail === undefined ? "" : `: ${detail}`
			}`,
		);
	}

	private say(folder: string, what: string): void {
		this.log(`[devhub] workbench '${folder}' ${what}`);
	}
}
