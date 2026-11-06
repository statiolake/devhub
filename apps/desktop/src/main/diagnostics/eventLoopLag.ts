/**
 * Whether main's event loop was blocked, and while doing what.
 *
 * "Typing is sluggish while a terminal starts" has two very different causes:
 * main busy on its own thread (a synchronous save, a menu rebuild, a big JSON
 * round trip) — and then every page waits on it, because every keystroke to a
 * terminal is an IPC to main — or a renderer busy drawing. From the outside the
 * two look the same. This tells them apart from the log: a timer that should
 * fire every `intervalMs` and fired late was held up by whatever ran on main in
 * between, and a line is written when it was held up for longer than
 * `thresholdMs`.
 *
 * **What it was doing.** The few places that do real work on main say so with
 * `noteMainActivity` — a label, and nothing else: no timing, no allocation
 * beyond the label. The line names the labels noted since the previous tick,
 * which is the work that ran in the window the loop was blocked in (the
 * blocking task itself, or the ones queued with it), and the last label from
 * before it when none was.
 *
 * **What it costs.** One timer, unref'd, at `intervalMs` (250 ms): a
 * subtraction and a comparison per tick, a set of at most a few labels.
 * Nothing is written while the loop keeps up.
 */

/** A tick this much later than due is a blocked loop worth a line. */
export const EVENT_LOOP_LAG_THRESHOLD_MS = 150;
/** How often the loop is asked whether it is keeping up. */
export const EVENT_LOOP_PROBE_INTERVAL_MS = 250;
/** The labels one line can name, most recent kept. */
const MAX_LABELS = 6;

/** The labels noted since the previous tick, oldest first. */
const recent: string[] = [];
let lastLabel: string | undefined;

/**
 * Say what main is about to do, for the next blocked-loop line.
 *
 * Cheap enough for any call site that is not per byte: a push and, rarely, a
 * shift.
 */
export function noteMainActivity(label: string): void {
	lastLabel = label;
	if (recent[recent.length - 1] === label) return;
	const index = recent.indexOf(label);
	if (index !== -1) recent.splice(index, 1);
	recent.push(label);
	if (recent.length > MAX_LABELS) recent.shift();
}

/**
 * The line for one tick, or nothing when the loop kept up.
 *
 * `lagMs` is how much later than due the tick ran. A pure function of what it
 * is given, so the format is pinned by a test.
 */
export function eventLoopLagLine(
	lagMs: number,
	thresholdMs: number,
	during: readonly string[],
	before: string | undefined,
): string | undefined {
	if (!(lagMs > thresholdMs)) return undefined;
	const activity =
		during.length > 0
			? during.join(", ")
			: before === undefined
				? "unknown"
				: `nothing noted; last: ${before}`;
	return `[devhub] main event loop blocked for ${String(Math.round(lagMs))} ms (during: ${activity})`;
}

export interface EventLoopLagMonitorOptions {
	readonly intervalMs?: number;
	readonly thresholdMs?: number;
	/** Overridden only by tests. */
	readonly now?: () => number;
	readonly log?: (line: string) => void;
}

/**
 * Start probing. Answers the function that stops it.
 *
 * One per process: the labels are module state, because the call sites that
 * note them have no handle to pass around and should not need one.
 */
export function startEventLoopLagMonitor(
	options: EventLoopLagMonitorOptions = {},
): () => void {
	const intervalMs = options.intervalMs ?? EVENT_LOOP_PROBE_INTERVAL_MS;
	const thresholdMs = options.thresholdMs ?? EVENT_LOOP_LAG_THRESHOLD_MS;
	const now = options.now ?? (() => performance.now());
	const log = options.log ?? ((line: string) => console.warn(line));
	let due = now() + intervalMs;
	let before: string | undefined = lastLabel;
	const timer = setInterval(() => {
		const at = now();
		const line = eventLoopLagLine(at - due, thresholdMs, recent, before);
		if (line !== undefined) log(line);
		recent.length = 0;
		before = lastLabel;
		due = at + intervalMs;
	}, intervalMs);
	// Never the reason main stays up.
	(timer as { unref?: () => void }).unref?.();
	return () => clearInterval(timer);
}
