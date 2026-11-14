/**
 * Where the time from an action to its first frame goes, stage by stage, for
 * the stability suite's startup scenario (`test/stability/startup.mjs`).
 *
 * Off unless DevHub was started with `DEVHUB_STARTUP_TRACE=1`, and then each
 * stage is one line on stderr — `[startup-trace] <epoch ms> <label>` — which
 * the harness reads from the app's log and lines up with the pages'
 * `performance` marks (`shell/startupMarks.ts`) on the same clock. Off, a
 * call is one comparison.
 */

const enabled = process.env.DEVHUB_STARTUP_TRACE === "1";

export function startupTrace(label: string): void {
	if (!enabled) return;
	process.stderr.write(
		`[startup-trace] ${(performance.timeOrigin + performance.now()).toFixed(1)} ${label}\n`,
	);
}
