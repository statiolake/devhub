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
 * absent     ─ shown / asked / requested ───────▶ starting (foreground)
 *            ─ its turn, nothing else starting ─▶ starting (background)
 * starting   ─ loaded ──────────────────────────▶ running (lifecycle event)
 * running    ─ hidden, settled, nothing keeps it ▶ (probe) ─▶ frozen
 * frozen     ─ shown / asked / requested / a connection waits ─▶ running
 *            ─ frozen `discardAfterMs` ─────────▶ discarding ─▶ discarded
 * discarded  ─ asked / requested ───────────────▶ starting (wake)
 * ```
 *
 * The rules, each in one place:
 *
 * - **Shown, asked for or requested wins.** The shown workbench is never
 *   frozen, a frozen one that is shown or needed is thawed at once, and an
 *   absent one that is shown or needed starts at once, ahead of any
 *   background start — the user's choice preempts the queue.
 * - **One background start at a time.** At launch the shown workbench starts
 *   first; each other local one starts in the background only when no start
 *   is in flight and every started one has settled (`settled`: its window
 *   restored, its extensions registered, its CPU quiet for a few seconds, or
 *   `SETTLE_TIMEOUT_MS` gone by). Which one goes next is decided now, from
 *   recency and then the Sidebar's order — nothing is queued.
 * - **Freeze aggressively.** A running workbench that is not shown is frozen
 *   as soon as it has settled and nothing keeps it awake (`AWAKE_RULES`). The
 *   signals the renderer alone knows (a debug session, a running task, a busy
 *   terminal) come from a probe taken after it was hidden, so a freeze always
 *   follows a fresh probe; the decision is still made here, from the facts as
 *   they are when the probe's answer lands.
 * - **Discard after a while.** Frozen for `discardAfterMs` (0: never), it is
 *   closed, and stays so until somebody asks for it.
 *
 * SSH and dev container workbenches are not frozen or discarded
 * (`freezable: false`): they start when shown or asked for, and stay up.
 */

import type { EditorPlaceholderWire } from "../../ipc/contract.js";
import type { WorkbenchStateWire } from "../../ipc/taskManager.js";

/** A hidden workbench's sockets that talked this recently keep it awake. */
export const NETWORK_ACTIVE_MS = 30_000;
/** A workbench thawed for a connection stays up at least this long. */
export const CONNECTION_GRACE_MS = 30_000;
/**
 * A probe this old is asked again: a busy workbench is looked at this often,
 * and a freeze never follows an answer older than this.
 */
export const PROBE_FRESH_MS = 15_000;
/** A starting workbench is probed this often until it has settled. */
export const SETTLE_PROBE_MS = 1_000;
/** Its CPU quiet this long (and its window ready) is settled. */
export const QUIET_MS = 3_000;
/** Running this long counts as settled for the start budget, whatever it says. */
export const SETTLE_TIMEOUT_MS = 60_000;

/** Why a workbench is being opened, which is what its slot says meanwhile. */
export type OpenCause = "start" | "restart" | "wake";

/** Where one folder's workbench is. A folder with no record is `absent`. */
export type WorkbenchPhase =
	/** Not started in this run: waiting to be shown, asked for, or its turn. */
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
}

export interface PlanFacts {
	readonly now: number;
	/** `general.workbench_discard_minutes` in ms; 0 for never. */
	readonly discardAfterMs: number;
	/** Every wanted workbench, in the Sidebar's order. */
	readonly workbenches: readonly WorkbenchFacts[];
}

export type WorkbenchAction =
	| {
			readonly kind: "start";
			readonly folder: string;
			readonly cause: OpenCause;
			readonly background: boolean;
	  }
	| { readonly kind: "probe"; readonly folder: string }
	| { readonly kind: "freeze"; readonly folder: string; readonly why: string }
	| { readonly kind: "thaw"; readonly folder: string; readonly why: string }
	| { readonly kind: "discard"; readonly folder: string };

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

/** A probe taken since it was hidden, and not too old to act on. */
export function probeIsFresh(facts: WorkbenchFacts, now: number): boolean {
	const { probe } = facts;
	return (
		probe !== undefined &&
		probe.at >= (facts.hiddenSince ?? 0) &&
		now - probe.at < PROBE_FRESH_MS
	);
}

/** Whether this one counts against the start budget: a start not yet settled. */
function unsettledStart(facts: WorkbenchFacts, now: number): boolean {
	const { phase } = facts;
	if (phase.kind === "starting") return true;
	return (
		phase.kind === "running" &&
		!facts.settled &&
		now - phase.since < SETTLE_TIMEOUT_MS
	);
}

/** The order background starts go in: most recently shown, then the Sidebar's. */
function backgroundOrder(
	workbenches: readonly WorkbenchFacts[],
): WorkbenchFacts[] {
	return workbenches
		.map((facts, index) => ({ facts, index }))
		.sort(
			(a, b) =>
				(b.facts.lastShownAt ?? -Infinity) -
					(a.facts.lastShownAt ?? -Infinity) || a.index - b.index,
		)
		.map(({ facts }) => facts);
}

/** One workbench's own move, apart from the start budget. */
function decideOne(
	facts: WorkbenchFacts,
	now: number,
	discardAfterMs: number,
): WorkbenchAction | undefined {
	const { folder, phase } = facts;
	const wanted = facts.shown || facts.asked;
	switch (phase.kind) {
		case "absent":
			return wanted && !facts.closing
				? { kind: "start", folder, cause: "start", background: false }
				: undefined;
		case "discarded":
			// Shown alone is its placeholder; it starts only when asked for.
			return facts.asked && !facts.closing
				? { kind: "start", folder, cause: "wake", background: false }
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
			if (discardAfterMs > 0 && now - phase.since >= discardAfterMs) {
				return { kind: "discard", folder };
			}
			return undefined;
		}
		case "running": {
			if (!facts.settled) {
				// Probed until it has settled, shown or not, local or not: the
				// start budget waits on it.
				const due =
					facts.probe === undefined || now - facts.probe.at >= SETTLE_PROBE_MS;
				return due && !facts.probing ? { kind: "probe", folder } : undefined;
			}
			if (!facts.freezable || facts.shown) return undefined;
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
	const { now, discardAfterMs, workbenches } = facts;
	const actions: WorkbenchAction[] = [];
	for (const one of workbenches) {
		const action = decideOne(one, now, discardAfterMs);
		if (action !== undefined) actions.push(action);
	}
	// The budget: one background start, and only when nothing is starting —
	// counting the foreground starts this same plan makes.
	const starting =
		workbenches.some((one) => unsettledStart(one, now)) ||
		actions.some((action) => action.kind === "start");
	if (!starting) {
		const next = backgroundOrder(workbenches).find(
			(one) => one.phase.kind === "absent" && one.freezable && !one.closing,
		);
		if (next !== undefined) {
			actions.push({
				kind: "start",
				folder: next.folder,
				cause: "start",
				background: true,
			});
		}
	}
	return actions;
}

/** When `decide` would answer differently with nothing else changing. */
export function nextDecision(facts: PlanFacts): number | undefined {
	const { now, discardAfterMs } = facts;
	const times: number[] = [];
	for (const one of facts.workbenches) {
		const { phase } = one;
		if (phase.kind === "frozen" && discardAfterMs > 0) {
			times.push(phase.since + discardAfterMs);
		}
		if (phase.kind === "running") {
			if (!one.settled) {
				times.push((one.probe?.at ?? now) + SETTLE_PROBE_MS);
				times.push(phase.since + SETTLE_TIMEOUT_MS);
			} else if (!one.shown) {
				if (one.probe !== undefined) times.push(one.probe.at + PROBE_FRESH_MS);
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
			return { kind: "starting" };
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
