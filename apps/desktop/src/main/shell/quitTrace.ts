/**
 * Every way DevHub's main process can end, said in the log before it happens.
 *
 * DevHub once closed itself 24 seconds after every launch on a person's Mac,
 * exit status 0, no crash report, and nothing in `devhub-main.log` between the
 * last workbench line and the extension hosts exiting. Nothing said *why*,
 * because nothing on the way out said anything: `app.quit()` has a dozen
 * callers (the menu, the coordinator's `detach`, VS Code's lifecycle service
 * on behalf of a workbench, the updater, a restart) and the one `before-quit`
 * handler they all end in was silent. And one way out has no caller at all:
 * Electron answers SIGHUP, SIGINT and SIGTERM by quitting the application
 * gracefully, and a graceful quit is an exit status of 0.
 *
 * So, installed first thing in the main process (`shimEntry.ts`):
 *
 *   - `app.quit()` and `app.exit()` say they were called, and by whom — the
 *     frames of the caller, which is the one fact a log line written later
 *     in `before-quit` can no longer know.
 *   - SIGHUP is answered by DevHub, not Electron, and the answer is to stay
 *     up. DevHub is a GUI application; it has no terminal to hang up. What
 *     does send it SIGHUP is the kernel, by the POSIX orphaned-process-group
 *     rule: when DevHub's process group is left orphaned while one of its
 *     members is stopped — and a frozen workbench's renderer, extension hosts
 *     and language servers are stopped members of exactly that group — every
 *     member is sent SIGHUP and then SIGCONT. Electron took that SIGHUP as a
 *     request to quit. See `processGroupAnchor.ts` for keeping the group from
 *     being orphaned in the first place; this is the floor under it.
 *     Staying up does not save the rest of the group — the renderers, the GPU
 *     and network processes and the extension hosts end on that SIGHUP — but
 *     a main process that says what happened and rebuilds what it can is
 *     better than one that vanishes with status 0 and leaves no trace.
 *   - SIGINT and SIGTERM still quit — a `kill`, `launchctl`, a Ctrl-C on
 *     `dev.sh` mean it — but they say so first.
 */

/** The part of Electron's `app` this wraps. */
export interface QuittableApp {
	quit(): void;
	exit(exitCode?: number): void;
	once(event: "ready", listener: () => void): unknown;
}

/** The part of `process` this listens on. */
export interface SignalSource {
	on(
		signal: NodeJS.Signals,
		listener: (signal: NodeJS.Signals) => void,
	): unknown;
	removeListener(
		signal: NodeJS.Signals,
		listener: (signal: NodeJS.Signals) => void,
	): unknown;
}

/** The frames that called the wrapper, without the wrapper's own. */
export function callerOf(stack: string | undefined): string {
	const frames = (stack ?? "")
		.split("\n")
		.slice(2)
		.map((frame) => frame.trim().replace(/^at /, ""))
		.filter((frame) => frame.length > 0)
		.slice(0, 6);
	return frames.length > 0 ? frames.join(" <- ") : "unknown";
}

let installed = false;
/** When the process last took a SIGHUP, if it ever did. */
let lastHangUp: number | undefined;

/**
 * When DevHub's main last took a SIGHUP, or undefined. One that came while
 * workbenches could be frozen means the process group was hung up despite
 * the anchor (`processGroupAnchor.ts`) — every renderer of the window went
 * with it — so the freezer asks this before it stops anything again.
 */
export function hungUpAt(): number | undefined {
	return lastHangUp;
}

/**
 * Wrap `app.quit` / `app.exit` and answer the shutdown signals. Once per
 * process: a second call is a no-op, so a module loaded twice does not log
 * every quit twice.
 */
export function installQuitTrace(
	app: QuittableApp,
	signals: SignalSource,
	log: (line: string) => void = (line) => {
		console.log(line);
	},
): void {
	if (installed) return;
	installed = true;

	const quit = app.quit.bind(app);
	const exit = app.exit.bind(app);
	app.quit = () => {
		log(`[devhub] quit: app.quit() called from ${callerOf(new Error().stack)}`);
		quit();
	};
	app.exit = (exitCode?: number) => {
		log(
			`[devhub] quit: app.exit(${String(exitCode ?? 0)}) called from ${callerOf(new Error().stack)}`,
		);
		exit(exitCode);
	};

	const answers: [NodeJS.Signals, () => void][] = [
		[
			"SIGHUP",
			() => {
				lastHangUp = Date.now();
				log(
					"[devhub] SIGHUP received — ignored: DevHub has no terminal to hang up. " +
						"If a workbench is frozen, this is the kernel's orphaned-process-group SIGHUP " +
						"(see processGroupAnchor.ts), and every frozen workbench was just sent SIGCONT with it.",
				);
			},
		],
		...(["SIGINT", "SIGTERM"] as const).map(
			(signal): [NodeJS.Signals, () => void] => [
				signal,
				() => {
					log(`[devhub] quit: ${signal} received — quitting`);
					app.quit();
				},
			],
		),
	];
	const answer = () => {
		for (const [signal, listener] of answers) {
			signals.removeListener(signal, listener);
			signals.on(signal, listener);
		}
	};
	answer();
	// Again once Electron is up. Electron installs its own SIGHUP / SIGINT /
	// SIGTERM handlers ("quit gracefully") while it starts, after this module
	// has run, and the process has one handler per signal: the last one
	// installed. Taking the listeners off and putting them back makes Node
	// install its handler again, after Electron's.
	app.once("ready", () => {
		setTimeout(answer, 0);
	});
}

/** For tests: forget that the trace was installed. */
export function resetQuitTraceForTests(): void {
	installed = false;
	lastHangUp = undefined;
}
