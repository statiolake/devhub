/**
 * Opening a `devhub:` link from outside DevHub: a click in Slack, Notes or a
 * browser, `open devhub:agent/3f2a9c1e` in a shell.
 *
 * DevHub says it is the application for the `devhub` URL scheme twice: in
 * the packaged bundle's `Info.plist` (`CFBundleURLTypes`,
 * `scripts/darwin_bundle.py`'s `url_types`), which is what Launch Services
 * reads, and with `app.setAsDefaultProtocolClient` at startup, which makes
 * this copy the one a link goes to when more than one DevHub is on the Mac.
 * Only the default profile's packaged app does the second: a source run
 * (`DEVHUB_PROFILE=dev`) is another DevHub with other Agents, and a link
 * from outside means the one the person uses.
 *
 * macOS hands the URL to the running application as `open-url` — never to a
 * second copy — and for a launch by URL it fires before `ready`, before there
 * is a model to find the place in. So the URLs are queued, as Finder's
 * documents are (`openFromFinder.ts`), and answered once DevHub is ready
 * (`main.ts`), one at a time, by `AppController.openDevhubUrl` — which follows
 * the link the way a chip inside DevHub is followed. Elsewhere (Linux, a
 * second launch with the URL as its argument) the URL arrives on the command
 * line instead, and `devhubUrlsIn` finds it there.
 *
 * Free of Electron but for the two functions at the end, so the queue is
 * what the test reads.
 */

import { electron } from "../electron.js";
import { isDevhubLink } from "../../model/devhubLink.js";

/** The scheme, as Electron and `Info.plist` spell it: no colon. */
export const DEVHUB_URL_SCHEME = "devhub";

/** Follow one link from outside. */
export type OpenUrl = (url: string) => Promise<unknown>;

/** Say that a link from outside led nowhere, where DevHub says such things. */
export type ReportFailure = (error: unknown) => void;

/** The `devhub:` links in a command line, in order: a launch's own, or a second one's. */
export function devhubUrlsIn(argv: readonly string[]): string[] {
	return argv.filter((arg) => isDevhubLink(arg.trim()));
}

/**
 * Links that arrived, and the thing that follows them once it exists.
 *
 * One at a time: following one selects, maybe reopens an Agent, and the next
 * one is a question about what is selected after it.
 */
export class DevhubUrlOpens {
	private readonly waiting: string[] = [];
	private open: OpenUrl | undefined;
	private report: ReportFailure | undefined;
	private running: Promise<void> = Promise.resolve();

	/** How many links are waiting for DevHub to be ready. For the test. */
	get queued(): number {
		return this.waiting.length;
	}

	/** The system handed DevHub this link. */
	offer(url: string): void {
		this.waiting.push(url);
		this.drain();
	}

	/** DevHub is ready: follow everything that waited, and all that comes after. */
	answerWith(open: OpenUrl, report: ReportFailure): void {
		if (this.open) {
			throw new Error("DevHub already has something answering devhub: links");
		}
		this.open = open;
		this.report = report;
		this.drain();
	}

	/** Every link offered so far has been followed (or refused). For the test. */
	settled(): Promise<void> {
		return this.running;
	}

	private drain(): void {
		const open = this.open;
		const report = this.report;
		if (!open || !report) return;
		for (const url of this.waiting.splice(0, this.waiting.length)) {
			this.running = this.running.then(async () => {
				try {
					await open(url);
				} catch (error) {
					// Nothing above asked: the link came from another app, which
					// has stopped listening. Said in DevHub's notices; the next
					// link is still followed.
					report(error);
				}
			});
		}
	}
}

/** The one queue: one macOS, one DevHub. */
const devhubUrlOpens = new DevhubUrlOpens();

/**
 * Start collecting links, before anything can follow them: `open-url` for
 * macOS, called from `main.ts` at module scope like `watchForFinderOpens`
 * (a launch by URL delivers it right after `will-finish-launching`), and the
 * launch's own command line for the platforms that pass it there.
 */
export function watchForDevhubUrls(argv: readonly string[]): void {
	electron.app.on("open-url", (event, url) => {
		event.preventDefault();
		devhubUrlOpens.offer(url);
	});
	for (const url of devhubUrlsIn(argv)) devhubUrlOpens.offer(url);
}

/** A second launch's command line, handed over by the single-instance lock. */
export function offerDevhubUrls(argv: readonly string[]): void {
	for (const url of devhubUrlsIn(argv)) devhubUrlOpens.offer(url);
}

/** Follow them, now that DevHub is ready. */
export function answerDevhubUrls(open: OpenUrl, report: ReportFailure): void {
	devhubUrlOpens.answerWith(open, report);
}

/**
 * Be the application `devhub:` links open, when this is the DevHub a person
 * uses: the packaged app of the default profile. See the module comment.
 */
export function claimDevhubScheme(isDefaultProfile: boolean): void {
	const { app } = electron;
	if (!isDefaultProfile || !app.isPackaged) return;
	if (app.isDefaultProtocolClient(DEVHUB_URL_SCHEME)) return;
	if (!app.setAsDefaultProtocolClient(DEVHUB_URL_SCHEME))
		console.warn(
			"[devhub] could not make DevHub the application for devhub: links",
		);
}
