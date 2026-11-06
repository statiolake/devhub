/**
 * What every workbench should be doing now, decided from what is true now.
 *
 * A workbench (a Workspace's VS Code: its renderer, its extension hosts and
 * their language servers) is in one process state at a time —
 * `absent` (not started in this run), `starting`, `running`, `frozen`
 * (every one of its processes stopped with SIGSTOP), `discarding`, or
 * `discarded` (closed, as VS Code closes a window on quit) — and this file is
 * the one place that says which it should move to. `decide` is a pure
 * function of the facts the lifecycle holds (`WorkbenchFacts`); it reads no
 * clock, keeps nothing, and runs no timer. The driver
 * (`WorkbenchLifecycle.plan`, carried out by `AppController`) calls it
 * whenever a fact changes or an action completes, and at `nextDeadline`.
 *
 * ```text
 * absent     ─ asked / requested ───────────────▶ starting
 * starting   ─ loaded ──────────────────────────▶ running (lifecycle event)
 * running    ─ hidden 3 s, settled, nothing keeps it ▶ (probe) ─▶ frozen
 *            ─ asked to stop ───────────────────▶ discarding ─▶ discarded
 * frozen     ─ shown / asked / requested / a connection waits ─▶ running
 *            ─ frozen `discardAfterMs` / asked to stop ▶ discarding ─▶ discarded
 * discarded  ─ asked / requested ───────────────▶ starting (wake)
 * ```
 *
 * The rules, each in one place:
 *
 * - **Nothing starts until it is asked for.** Showing a workbench does not
 *   start it: an absent or discarded one shown is its placeholder ("Editor
 *   not running — press Enter to start") until somebody asks — Enter or the
 *   placeholder's button — or a DevHub request that needs it waits on it (a
 *   file routed to it). There is no start at launch and none in the
 *   background.
 * - **Shown, asked for or requested keeps it.** The shown workbench is never
 *   frozen, and a frozen one that is shown or needed is thawed at once.
 * - **A person can stop one.** Asked to stop (`Cmd+Q Shift+E`), a running or
 *   frozen local workbench is discarded — shown or not — the way a long
 *   frozen one is; the executor's last-moment checks and VS Code's unload are
 *   the same. Not while a DevHub request or hold needs it, while it starts or
 *   closes, or for a remote one (`stopRefusal`).
 * - **Freeze aggressively.** A running workbench that is not shown is frozen
 *   as soon as it has settled and nothing keeps it awake (`AWAKE_RULES`) —
 *   but one that was just hidden only `FREEZE_GRACE_MS` after it was hidden.
 *   The signals the renderer alone knows (a debug session, a running task, a
 *   busy terminal) come from a probe taken after that grace, so a freeze
 *   always follows a fresh probe and sees what was started just before the
 *   hiding (VS Code says a terminal is busy only about 2 s after its command
 *   starts); the decision is still made here, from the facts as they are when
 *   the probe's answer lands. Shown again within the grace, nothing happens.
 * - **Discard after a while.** Frozen for `discardAfterMs` (0: never), it is
 *   closed, and stays so until somebody asks for it.
 * - **Freezing can be turned off.** With `freeze` false
 *   (`general.workbench_freeze`) nothing is frozen — not on hiding, not on a
 *   person's Sleep — so nothing is discarded either, and one frozen when it
 *   turned off is thawed.
 *
 * SSH and dev container workbenches are not frozen or discarded
 * (`freezable: false`): they start when asked for, and stay up.
 */

import type { EditorPlaceholderWire } from "../../ipc/contract.js";
import type { WorkbenchStateWire } from "../../ipc/taskManager.js";

/** A hidden workbench's sockets that talked this recently keep it awake. */
export const NETWORK_ACTIVE_MS = 30_000;
/** A workbench thawed for a connection stays up at least this long. */
export const CONNECTION_GRACE_MS = 30_000;
/**
 * A workbench that stopped being shown is not frozen (or probed for it) until
 * this long after it was hidden, so in-use signals that arrive late — a
 * terminal reported busy about 2 s into its command, traffic — are seen by
 * the probe that decides. A person's Sleep skips it.
 */
export const FREEZE_GRACE_MS = 3_000;
/**
 * A probe this old is asked again: a busy workbench is looked at this often,
 * and a freeze never follows an answer older than this.
 */
export const PROBE_FRESH_MS = 15_000;
/** A starting workbench is probed this often until it has settled. */
export const SETTLE_PROBE_MS = 1_000;
/** Its CPU quiet this long (and its window ready) is settled. */
export const QUIET_MS = 3_000;

/** Why a workbench is being opened, which is what its slot says meanwhile. */
export type OpenCause = "start" | "restart" | "wake";

/** Where one folder's workbench is. A folder with no record is `absent`. */
export type WorkbenchPhase =
	/** Not started in this run: waiting to be asked for. */
	| { readonly kind: "absent" }
	/** An open in flight, or a view that has not finished loading. */
	| {
			readonly kind: "starting";
			readonly cause: OpenCause;
			/** A discarded one's frame from before it went. */
			readonly frame: string;
			readonly since: number;
	  }
	| { readonly kind: "running"; readonly since: number }
	/** Every one of its processes stopped (SIGSTOP). */
	| { readonly kind: "frozen"; readonly since: number }
	/** Thawed to be unloaded; it may still be called back. */
	| { readonly kind: "discarding" }
	/** Closed to free its memory; `frame` is what it showed, a data URL or "". */
	| { readonly kind: "discarded"; readonly frame: string }
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

/** The renderer's answer about what a freeze would interrupt. */
export interface Probe {
	readonly at: number;
	/** A debug session, a running task, a terminal with a program in front. */
	readonly busy: readonly string[];
}

/** Everything `decide` knows about one workbench. */
export interface WorkbenchFacts {
	readonly folder: string;
	readonly phase: WorkbenchPhase;
	/** Local: not SSH or a dev container. */
	readonly freezable: boolean;
	/** The editor on screen. */
	readonly shown: boolean;
	/**
	 * Somebody asked for it (Enter, opening the Workspace), or a DevHub
	 * request that needs it running waits on it: started if it is not.
	 */
	readonly asked: boolean;
	/**
	 * DevHub is talking to it (its close asking about unsaved work): kept
	 * running if it runs, thawed if frozen, but not started for this.
	 */
	readonly held: boolean;
	/** Its Workspace's close is running. */
	readonly closing: boolean;
	/** When it was last on screen; nothing if never in this run. */
	readonly lastShownAt: number | undefined;
	/** When it stopped being on screen; nothing while shown or never shown. */
	readonly hiddenSince: number | undefined;
	/** It has finished starting (see the file's comment). */
	readonly settled: boolean;
	readonly probe: Probe | undefined;
	/** A probe is in flight. */
	readonly probing: boolean;
	/** When its sockets last carried traffic. */
	readonly trafficAt: number | undefined;
	/** When a connection last arrived on a socket it listens on. */
	readonly connectionAt: number | undefined;
	/** Its renderer process also draws another workbench that is not frozen. */
	readonly rendererShared: boolean;
	/** A person asked for it to be frozen now (the Task Manager's Sleep). */
	readonly freezeAsked: boolean;
	/** A person asked for it to be stopped now (`Cmd+Q Shift+E`). */
	readonly stopAsked: boolean;
}

export interface PlanFacts {
	readonly now: number;
	/** `general.workbench_discard_minutes` in ms; 0 for never. */
	readonly discardAfterMs: number;
	/**
	 * `general.workbench_freeze`: false freezes nothing (so discards nothing)
	 * and thaws whatever is frozen.
	 */
	readonly freeze: boolean;
	/** Every wanted workbench, in the Sidebar's order. */
	readonly workbenches: readonly WorkbenchFacts[];
}

export type WorkbenchAction =
	| {
			readonly kind: "start";
			readonly folder: string;
			readonly cause: OpenCause;
	  }
	| { readonly kind: "probe"; readonly folder: string }
	| { readonly kind: "freeze"; readonly folder: string; readonly why: string }
	| { readonly kind: "thaw"; readonly folder: string; readonly why: string }
	/** `stop`: a person asked (`Cmd+Q Shift+E`); otherwise frozen long enough. */
	| {
			readonly kind: "discard";
			readonly folder: string;
			readonly stop: boolean;
	  };

/**
 * What keeps a running workbench from being frozen, as data. `hard` ones
 * hold even against a person asking for the freeze.
 */
export const AWAKE_RULES: readonly {
	readonly reason: string;
	readonly hard: boolean;
	readonly holds: (facts: WorkbenchFacts, now: number) => boolean;
}[] = [
	{ reason: "shown", hard: true, holds: (f) => f.shown },
	{ reason: "asked for", hard: true, holds: (f) => f.asked },
	{ reason: "in use by DevHub", hard: true, holds: (f) => f.held },
	{ reason: "closing", hard: true, holds: (f) => f.closing },
	{ reason: "not local", hard: true, holds: (f) => !f.freezable },
	{ reason: "still starting", hard: true, holds: (f) => !f.settled },
	{
		reason: "shares its renderer",
		hard: true,
		holds: (f) => f.rendererShared,
	},
	{
		reason: "network traffic",
		hard: false,
		holds: (f, now) =>
			f.trafficAt !== undefined && now - f.trafficAt < NETWORK_ACTIVE_MS,
	},
	{
		reason: "just hidden",
		hard: false,
		holds: (f, now) =>
			f.hiddenSince !== undefined && now - f.hiddenSince < FREEZE_GRACE_MS,
	},
	{
		reason: "a connection just arrived",
		hard: false,
		holds: (f, now) =>
			f.connectionAt !== undefined &&
			now - f.connectionAt < CONNECTION_GRACE_MS,
	},
	{
		reason: "busy",
		hard: false,
		holds: (f) => (f.probe?.busy.length ?? 0) > 0,
	},
];

/** Every reason this workbench may not be frozen now. */
export function awakeReasons(facts: WorkbenchFacts, now: number): string[] {
	return AWAKE_RULES.filter((rule) => rule.holds(facts, now)).map((rule) =>
		rule.reason === "busy" ? (facts.probe?.busy ?? []).join(", ") : rule.reason,
	);
}

/**
 * A probe taken after the grace that followed its hiding (any, if it was
 * never shown), and not too old to act on.
 */
export function probeIsFresh(facts: WorkbenchFacts, now: number): boolean {
	const { probe, hiddenSince } = facts;
	const since = hiddenSince === undefined ? 0 : hiddenSince + FREEZE_GRACE_MS;
	return (
		probe !== undefined && probe.at >= since && now - probe.at < PROBE_FRESH_MS
	);
}

/**
 * Why a person's stop (`Cmd+Q Shift+E`) does not stop this one now; nothing
 * when it does. Only a running or frozen local workbench is stopped, and not
 * while DevHub needs it: a request waiting on it, a hold, its close.
 */
export function stopRefusal(facts: WorkbenchFacts): string | undefined {
	const { phase } = facts;
	if (phase.kind === "absent" || phase.kind === "discarded") {
		return "it is not running";
	}
	if (phase.kind === "starting") return "it is still starting";
	if (phase.kind !== "running" && phase.kind !== "frozen") {
		return `it is ${phase.kind}`;
	}
	if (!facts.freezable) return "SSH and dev container editors are not stopped";
	if (facts.closing) return "its Workspace is closing";
	if (facts.asked) return "DevHub is waiting on it";
	if (facts.held) return "DevHub is talking to it";
	return undefined;
}

/** One workbench's own move. */
function decideOne(
	facts: WorkbenchFacts,
	now: number,
	discardAfterMs: number,
	freeze: boolean,
): WorkbenchAction | undefined {
	const { folder, phase } = facts;
	if (facts.stopAsked && stopRefusal(facts) === undefined) {
		return { kind: "discard", folder, stop: true };
	}
	switch (phase.kind) {
		case "absent":
			// Shown alone is its placeholder; it starts only when asked for.
			return facts.asked && !facts.closing
				? { kind: "start", folder, cause: "start" }
				: undefined;
		case "discarded":
			return facts.asked && !facts.closing
				? { kind: "start", folder, cause: "wake" }
				: undefined;
		case "frozen": {
			if (facts.shown) return { kind: "thaw", folder, why: "shown" };
			if (facts.asked) return { kind: "thaw", folder, why: "asked for" };
			if (facts.held) return { kind: "thaw", folder, why: "in use by DevHub" };
			if (facts.closing) return { kind: "thaw", folder, why: "closing" };
			if (
				facts.connectionAt !== undefined &&
				facts.connectionAt >= phase.since
			) {
				return { kind: "thaw", folder, why: "a connection is waiting" };
			}
			if (!freeze) return { kind: "thaw", folder, why: "freezing is off" };
			if (discardAfterMs > 0 && now - phase.since >= discardAfterMs) {
				return { kind: "discard", folder, stop: false };
			}
			return undefined;
		}
		case "running": {
			if (!facts.settled) {
				// Probed until it has settled, shown or not, local or not: a
				// freeze waits on it.
				const due =
					facts.probe === undefined || now - facts.probe.at >= SETTLE_PROBE_MS;
				return due && !facts.probing ? { kind: "probe", folder } : undefined;
			}
			if (!freeze || !facts.freezable || facts.shown) return undefined;
			const reasons = AWAKE_RULES.filter((rule) => rule.holds(facts, now));
			if (facts.freezeAsked && !reasons.some((rule) => rule.hard)) {
				return { kind: "freeze", folder, why: "asked" };
			}
			// Everything but the renderer's own answer first: no probe is
			// needed to know a shown or talking workbench stays up.
			if (reasons.some((rule) => rule.reason !== "busy")) return undefined;
			if (!probeIsFresh(facts, now)) {
				return facts.probing ? undefined : { kind: "probe", folder };
			}
			return reasons.length === 0
				? { kind: "freeze", folder, why: "hidden" }
				: undefined;
		}
		case "starting":
		case "discarding":
		case "restart-waiting":
		case "gave-up":
		case "parked":
			return undefined;
	}
}

/** What to do now. Pure: the same facts give the same actions. */
export function decide(facts: PlanFacts): WorkbenchAction[] {
	const { now, discardAfterMs, freeze, workbenches } = facts;
	const actions: WorkbenchAction[] = [];
	for (const one of workbenches) {
		const action = decideOne(one, now, discardAfterMs, freeze);
		if (action !== undefined) actions.push(action);
	}
	return actions;
}

/** When `decide` would answer differently with nothing else changing. */
export function nextDecision(facts: PlanFacts): number | undefined {
	const { now, discardAfterMs, freeze } = facts;
	const times: number[] = [];
	for (const one of facts.workbenches) {
		const { phase } = one;
		if (phase.kind === "frozen" && freeze && discardAfterMs > 0) {
			times.push(phase.since + discardAfterMs);
		}
		if (phase.kind === "running") {
			if (!one.settled) {
				times.push((one.probe?.at ?? now) + SETTLE_PROBE_MS);
			} else if (freeze && !one.shown) {
				if (one.probe !== undefined) times.push(one.probe.at + PROBE_FRESH_MS);
				if (one.hiddenSince !== undefined) {
					times.push(one.hiddenSince + FREEZE_GRACE_MS);
				}
				if (one.trafficAt !== undefined) {
					times.push(one.trafficAt + NETWORK_ACTIVE_MS);
				}
				if (one.connectionAt !== undefined) {
					times.push(one.connectionAt + CONNECTION_GRACE_MS);
				}
			}
		}
	}
	const future = times.filter((at) => at > now);
	return future.length === 0 ? undefined : Math.min(...future);
}

/** What the editor's slot shows instead of a workbench. */
export type EditorPlaceholder = EditorPlaceholderWire;

/**
 * The placeholder a phase stands for; nothing where the workbench is drawn
 * itself. A frozen workbench needs none: it is never the one on screen — it
 * is thawed the moment it is shown — and its view still holds its last frame.
 */
export function placeholderOf(
	phase: WorkbenchPhase,
): EditorPlaceholder | undefined {
	switch (phase.kind) {
		case "absent":
			// Not started: the same "not running" placeholder a discarded one
			// shows, with no frame — Enter or its button starts it.
			return { kind: "discarded", frame: "" };
		case "starting":
			return phase.cause === "restart"
				? { kind: "restarting" }
				: phase.cause === "wake"
					? { kind: "waking", frame: phase.frame }
					: { kind: "starting" };
		case "restart-waiting":
			return { kind: "restarting" };
		case "discarded":
			return { kind: "discarded", frame: phase.frame };
		case "running":
		case "frozen":
		case "discarding":
		case "gave-up":
		case "parked":
			return undefined;
	}
}

/** A phase in the Task Manager's words. */
export function workbenchStateOf(phase: WorkbenchPhase): WorkbenchStateWire {
	switch (phase.kind) {
		case "absent":
			return "not started";
		case "starting":
			return phase.cause === "restart" ? "restarting" : "starting";
		case "running":
			return "running";
		case "frozen":
			return "frozen";
		case "discarding":
			return "discarding";
		case "discarded":
			return "discarded";
		case "restart-waiting":
			return "restarting";
		case "gave-up":
		case "parked":
			return "failed";
	}
}
