/**
 * DevHub's own pages heal themselves.
 *
 * A page is a renderer, and a renderer can go away under DevHub without
 * DevHub having asked: macOS reclaims memory from an app that has sat in the
 * background for hours, a hang-up reaches an orphaned process group, the GPU
 * process dies across a sleep and takes a renderer with it. A `WebContents`
 * whose renderer is gone is not destroyed — it stays in the window, keeps its
 * bounds, and draws nothing, which is the whole window gone white with nothing
 * left that could notice. Only the Sidebar's floating-width cleanup used to
 * listen, and it cleaned up and left the page dead.
 *
 * So every page DevHub owns — the App Shell page, the Sidebar, the Agents, the
 * notices, the questions, the tooltip, every terminal pane, Settings and the
 * Task Manager — is put under `supervisePage`, and a renderer that is gone, or
 * that has hung for long, is answered by loading the page again. A reload is
 * a normal load as far as the page and main are concerned: the page asks for
 * what it shows the way it does at launch, and main's own "the page started
 * over" listeners (`onSidebarRestarted`, the picker's republish, the
 * conversation detach) run as they do for any load.
 *
 * Workbenches are not here. A workbench renderer gone already ends the view
 * (`WorkbenchView`), and the editor lifecycle rebuilds it in its slot
 * (`AppController.superviseEditorView`).
 *
 * The decisions are `pageRecoveryAction` and `gpuGoneAction`, pure and tested;
 * what is left below them is listening and timers.
 */

import { electron } from "../electron.js";

/** How long an `unresponsive` page is waited for before it is reloaded. */
export const UNRESPONSIVE_RELOAD_MS = 30_000;
/** A page that hangs within this long of a wake is catching up, not hung. */
export const WAKE_GRACE_MS = 15_000;
/** Reloads closer together than this count as one burst for the backoff. */
export const RELOAD_BURST_WINDOW_MS = 60_000;
/** The longest a gone page waits before it is loaded again. */
export const MAX_RELOAD_DELAY_MS = 30_000;
/** After a forced crash, how long to wait for `render-process-gone` to say so. */
export const FORCED_CRASH_FALLBACK_MS = 5_000;
/** When pages are repainted after the GPU process went, and again. */
export const GPU_REPAINT_DELAYS_MS: readonly number[] = [500, 3_000];
/** When pages are repainted after a wake. */
export const WAKE_REPAINT_DELAY_MS = 1_000;

/** What happened to a page, as far as its recovery is concerned. */
export type PageSignal =
	| {
			readonly kind: "gone";
			readonly reason: string;
			readonly exitCode?: number;
	  }
	| { readonly kind: "unresponsive" }
	| { readonly kind: "responsive" }
	/** The wait armed by `unresponsive` ran out with no `responsive`. */
	| { readonly kind: "unresponsive-elapsed" };

export interface PageSituation {
	/** DevHub is quitting: every ending is expected and nothing is restarted. */
	readonly quitting: boolean;
	/** The contents were destroyed: the page was closed on purpose. */
	readonly destroyed: boolean;
	/** Whether the page has ever been loaded, i.e. there is something to reload. */
	readonly loaded: boolean;
	/** Reloads of this page within `RELOAD_BURST_WINDOW_MS`, for the backoff. */
	readonly recentReloads: number;
	/** Whether an `unresponsive` wait is running. */
	readonly waiting: boolean;
	/** When the running wait started, if one is. */
	readonly waitStartedAt?: number;
	/** When the Mac last woke, or `-Infinity`. */
	readonly lastWakeAt: number;
	readonly now: number;
}

export type PageRecoveryAction =
	| { readonly kind: "nothing" }
	| { readonly kind: "reload"; readonly delayMs: number }
	| { readonly kind: "wait"; readonly delayMs: number }
	| { readonly kind: "stop-waiting" }
	/** Kill the hung renderer; its `render-process-gone` reloads it. */
	| { readonly kind: "kill" };

/** The delay before the n-th reload in a burst: at once, then doubling. */
export function reloadDelayMs(recentReloads: number): number {
	if (recentReloads <= 0) return 0;
	return Math.min(MAX_RELOAD_DELAY_MS, 1_000 * 2 ** (recentReloads - 1));
}

/**
 * What a page does about a signal.
 *
 * At quit nothing, whatever the reason: every renderer ends then, and a
 * reload would be a page started into a window on its way out. A destroyed
 * page was closed (a terminal that ended, Settings closed) and is not
 * reloaded either. Every other ending is reloaded — a `clean-exit` included,
 * because a page DevHub did not close has no business exiting cleanly.
 */
export function pageRecoveryAction(
	signal: PageSignal,
	situation: PageSituation,
): PageRecoveryAction {
	if (situation.quitting || situation.destroyed) return { kind: "nothing" };
	switch (signal.kind) {
		case "gone":
			if (!situation.loaded) return { kind: "nothing" };
			return {
				kind: "reload",
				delayMs: reloadDelayMs(situation.recentReloads),
			};
		case "unresponsive":
			if (situation.waiting) return { kind: "nothing" };
			return { kind: "wait", delayMs: UNRESPONSIVE_RELOAD_MS };
		case "responsive":
			return situation.waiting ? { kind: "stop-waiting" } : { kind: "nothing" };
		case "unresponsive-elapsed": {
			if (!situation.waiting) return { kind: "nothing" };
			// Asleep for part of the wait, or just woken: the renderer has been
			// stopped with the rest of the Mac and is catching up. The wait
			// starts over from now.
			const started = situation.waitStartedAt ?? situation.now;
			if (
				situation.lastWakeAt >= started ||
				situation.now - situation.lastWakeAt < WAKE_GRACE_MS
			) {
				return { kind: "wait", delayMs: UNRESPONSIVE_RELOAD_MS };
			}
			if (!situation.loaded) return { kind: "stop-waiting" };
			return { kind: "kill" };
		}
	}
}

/** What DevHub does about a child process going away. */
export type GpuGoneAction =
	| { readonly kind: "nothing" }
	| { readonly kind: "repaint" };

/**
 * Only the GPU process is this module's: Chromium starts it again by itself,
 * but what was on screen was composited by the one that died, and a view that
 * has nothing new to draw can stay blank until something invalidates it.
 */
export function gpuGoneAction(
	details: { readonly type: string; readonly reason: string },
	quitting: boolean,
): GpuGoneAction {
	if (quitting) return { kind: "nothing" };
	if (details.type !== "GPU") return { kind: "nothing" };
	return { kind: "repaint" };
}

/** `(reason, code)` the way every line below writes it. */
function describe(reason: string, exitCode: number | undefined): string {
	return `${reason}, ${exitCode === undefined ? "no exit code" : String(exitCode)}`;
}

let lastWakeAt = Number.NEGATIVE_INFINITY;
const supervised = new WeakSet<Electron.WebContents>();

/**
 * Keep one page alive for as long as its contents exist.
 *
 * `name` is what the log calls it. Supervising the same contents twice is a
 * no-op, so a page can be handed in from wherever it is made.
 */
export function supervisePage(
	contents: Electron.WebContents | undefined,
	name: string,
	quitting: () => boolean,
): void {
	if (!contents || contents.isDestroyed() || supervised.has(contents)) return;
	supervised.add(contents);
	const reloads: number[] = [];
	let waitTimer: ReturnType<typeof setTimeout> | undefined;
	let waitStartedAt: number | undefined;
	let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;

	const situation = (): PageSituation => {
		const now = Date.now();
		while (
			reloads.length > 0 &&
			now - (reloads[0] ?? now) > RELOAD_BURST_WINDOW_MS
		) {
			reloads.shift();
		}
		return {
			quitting: quitting(),
			destroyed: contents.isDestroyed(),
			loaded: !contents.isDestroyed() && contents.getURL() !== "",
			recentReloads: reloads.length,
			waiting: waitTimer !== undefined,
			waitStartedAt,
			lastWakeAt,
			now,
		};
	};
	const stopWaiting = (): void => {
		if (waitTimer !== undefined) clearTimeout(waitTimer);
		waitTimer = undefined;
		waitStartedAt = undefined;
	};
	const wait = (delayMs: number): void => {
		stopWaiting();
		waitStartedAt = Date.now();
		waitTimer = setTimeout(() => {
			act({ kind: "unresponsive-elapsed" });
		}, delayMs);
	};
	const reload = (): void => {
		reloadTimer = undefined;
		if (contents.isDestroyed() || quitting()) return;
		reloads.push(Date.now());
		contents.reload();
	};

	const act = (signal: PageSignal): void => {
		const action = pageRecoveryAction(signal, situation());
		switch (action.kind) {
			case "nothing":
				return;
			case "wait":
				if (signal.kind === "unresponsive") {
					console.warn(
						`[devhub] page '${name}' unresponsive: reloading if it stays so for ${String(action.delayMs / 1000)}s`,
					);
				}
				wait(action.delayMs);
				return;
			case "stop-waiting":
				if (signal.kind === "responsive") {
					console.log(`[devhub] page '${name}' responsive again`);
				}
				stopWaiting();
				return;
			case "kill":
				stopWaiting();
				console.error(
					`[devhub] page '${name}' unresponsive for ${String(UNRESPONSIVE_RELOAD_MS / 1000)}s: ending its renderer to reload it`,
				);
				// The renderer's going is what reloads it, through the one path
				// every ending takes. Should that never be said, it is reloaded
				// anyway.
				fallbackTimer = setTimeout(() => {
					fallbackTimer = undefined;
					if (!contents.isDestroyed() && reloadTimer === undefined) reload();
				}, FORCED_CRASH_FALLBACK_MS);
				contents.forcefullyCrashRenderer();
				return;
			case "reload":
				if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
				fallbackTimer = undefined;
				if (reloadTimer !== undefined) return;
				reloadTimer = setTimeout(reload, action.delayMs);
				return;
		}
	};

	contents.on("render-process-gone", (_event, details) => {
		stopWaiting();
		const before = situation();
		const action = pageRecoveryAction(
			{ kind: "gone", reason: details.reason, exitCode: details.exitCode },
			before,
		);
		if (!before.quitting && !before.destroyed) {
			const what =
				action.kind === "reload"
					? action.delayMs === 0
						? "reloading"
						: `reloading in ${String(action.delayMs / 1000)}s`
					: "not loaded yet, nothing to reload";
			console.error(
				`[devhub] page '${name}' renderer gone (${describe(details.reason, details.exitCode)}): ${what}`,
			);
		}
		act({ kind: "gone", reason: details.reason, exitCode: details.exitCode });
	});
	contents.on("unresponsive", () => {
		act({ kind: "unresponsive" });
	});
	contents.on("responsive", () => {
		act({ kind: "responsive" });
	});
	contents.once("destroyed", () => {
		stopWaiting();
		if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
		if (reloadTimer !== undefined) clearTimeout(reloadTimer);
	});
}

/** Ask every live page to draw itself again. */
function repaintEveryPage(): void {
	for (const contents of electron.webContents.getAllWebContents()) {
		if (!contents.isDestroyed()) contents.invalidate();
	}
}

let installed = false;

/**
 * The application-wide half: the GPU process, and waking up. Once per run.
 *
 * Adds one `child-process-gone` listener to `app`, counted in
 * `APPLICATION_WIDE_LISTENERS`.
 */
export function installRendererRecovery(quitting: () => boolean): void {
	if (installed) return;
	installed = true;
	electron.app.on("child-process-gone", (_event, details) => {
		if (gpuGoneAction(details, quitting()).kind === "nothing") return;
		console.error(
			`[devhub] GPU process gone (${describe(details.reason, details.exitCode)}): Chromium restarts it; repainting every page`,
		);
		for (const delay of GPU_REPAINT_DELAYS_MS) {
			setTimeout(() => {
				if (!quitting()) repaintEveryPage();
			}, delay);
		}
	});
	electron.powerMonitor.on("resume", () => {
		lastWakeAt = Date.now();
		setTimeout(() => {
			if (!quitting()) repaintEveryPage();
		}, WAKE_REPAINT_DELAY_MS);
	});
}
