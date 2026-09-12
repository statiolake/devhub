/**
 * Opening a file from outside DevHub: Finder's "Open With", a drop on the Dock
 * tile, `open -a DevHub notes.md`, Quick Look's "Open with".
 *
 * macOS delivers all of them as one Electron event, `open-file`, and it delivers
 * them to the *running* application — Launch Services never starts a second
 * copy of a bundle for a document open, which is why nothing here has to think
 * about a second instance. The one thing it does have to think about is time:
 * for a launch-by-file the event fires before `ready`, long before DevHub has a
 * model, a window or a workbench to put the file in. So the paths are queued,
 * and the queue is answered once the App Shell's controller exists.
 *
 * **There is one rule for where a file lands, and it is not written here.**
 * `AppController.openFromCli` is that rule — the workspace whose root contains
 * the file, or the Scratch editor when no open workspace does, with the window
 * brought to the front because a document you cannot see has not been opened.
 * A Finder open is the same request the `devhub` command makes, arriving by a
 * different door, so it goes through the same function; `finderOpen` below is
 * the whole of the adaptation, and it is deliberately one line.
 *
 * VS Code's own answer to `open-file` is dropped rather than shared. Upstream
 * hands the path to `windowsMainService.open({ context: OpenContext.DOCK })`,
 * which means "a new window with this file in it" — DevHub has one window, and
 * "the last active window" is exactly the rule `openFromCli` exists to reject.
 * The drop is in `services/devhubWindowsMainService.ts`, next to the same drop
 * for the Dock icon, so that both places where the desktop talks to DevHub say
 * so in one file.
 *
 * The module is free of Electron on purpose: the queue is the part worth
 * testing, and `watchForFinderOpens` around it is three lines.
 */

import { dirname } from "node:path";
import { electron } from "../electron.js";

/** Open one path the way `devhub <path>` opens it. */
export type OpenPath = (path: string) => Promise<unknown>;

/** Say that a request from outside failed, wherever DevHub says such things. */
export type ReportFailure = (error: unknown) => void;

/** The part of `AppController` a Finder open needs, named so a test can stand in for it. */
export interface CliOpener {
	openFromCli(
		path: string,
		cwd: string,
		position: undefined,
		waitMarkerPath: undefined,
	): Promise<string>;
}

/**
 * The `devhub` command's own entry point, addressed as Finder addresses it.
 *
 * `cwd` is the file's own directory. The CLI sends the directory the person
 * typed the command in, and `openFromCli` does not read it — but a Finder open
 * has no terminal to have been typed in, and the containing directory is the
 * only honest answer to "where did this come from" if it ever starts reading
 * it. There is no `--goto` position and no `--wait` marker: Finder has no way
 * to ask for either, and inventing one here would be a second dialect of a
 * request that has one.
 */
export function finderOpen(controller: CliOpener): OpenPath {
	return (path) =>
		controller.openFromCli(path, dirname(path), undefined, undefined);
}

/**
 * Paths the desktop asked for, and the thing that opens them once it exists.
 *
 * Opens are run one at a time. `openFromCli` selects a workspace, waits for the
 * view to exist and then sends the file to it; two of those interleaved would
 * be two answers to "what is selected now", and dropping several files on the
 * Dock at once is the ordinary way to get them.
 */
export class FinderOpens {
	private readonly waiting: string[] = [];
	private open: OpenPath | undefined;
	private report: ReportFailure | undefined;
	/** The tail of the chain of opens, so the next one waits for the last. */
	private running: Promise<void> = Promise.resolve();

	/** How many paths are still waiting for something to open them. For the test. */
	get queued(): number {
		return this.waiting.length;
	}

	/** macOS asked for this path. */
	offer(path: string): void {
		// macOS hands out decomposed Unicode; upstream normalises it at the same
		// point (`app.on('open-file')` in `vs/code/electron-main/app.ts`), and
		// everything downstream compares these paths with workspace roots that
		// came from somewhere else.
		this.waiting.push(path.normalize("NFC"));
		this.drain();
	}

	/**
	 * There is now something that can open a file. Answer everything that has
	 * been waiting, and everything that arrives after this.
	 */
	answerWith(open: OpenPath, report: ReportFailure): void {
		if (this.open) {
			// Two openers would be two rules for where a file lands, which is the
			// one thing this module exists to prevent.
			throw new Error("DevHub already has something answering Finder opens");
		}
		this.open = open;
		this.report = report;
		this.drain();
	}

	private drain(): void {
		const open = this.open;
		const report = this.report;
		if (!open || !report) return;
		const paths = this.waiting.splice(0, this.waiting.length);
		for (const path of paths) {
			this.running = this.running.then(async () => {
				try {
					await open(path);
				} catch (error) {
					// The root of this request is right here: nothing above called
					// it, so nothing above can be told. It goes to the one place
					// DevHub shows failures, and the next path still opens.
					report(error);
				}
			});
		}
	}
}

/** The one queue, because there is one macOS and one DevHub. */
const finderOpens = new FinderOpens();

/**
 * Start collecting `open-file`, before anything can answer it.
 *
 * Called from `main.ts` at module scope, which is the only place early enough:
 * macOS delivers a launch-by-file's document immediately after
 * `will-finish-launching`, and a listener added once the app is ready has
 * already missed it.
 */
export function watchForFinderOpens(): void {
	electron.app.on("open-file", (event, path) => {
		event.preventDefault();
		finderOpens.offer(path);
	});
}

/** Answer them, now that there is a DevHub to answer with. */
export function answerFinderOpens(open: OpenPath, report: ReportFailure): void {
	finderOpens.answerWith(open, report);
}
