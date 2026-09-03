/**
 * Starting DevHub when `devhub` finds it is not running.
 *
 * Only a bare `devhub` does this, and that is a decision rather than an
 * accident. `devhub` on its own means "put DevHub in front of me", and the
 * honest way to satisfy that when there is no DevHub is to make one. Every
 * other command carries something to do — a file, an agent, an extension —
 * and starting a whole application as a side effect of being asked to open a
 * file is a much bigger thing to do than what was asked. The seam is drawn so
 * that widening it later is a matter of passing a launcher where `undefined`
 * is passed now, not of rewriting this.
 *
 * The app is started through macOS rather than by spawning a binary: `open -b`
 * hands the request to Launch Services, which knows where DevHub is installed,
 * starts it in its own session rather than as a child of a terminal that may
 * be closed a second later, and brings it to the front on its way. That last
 * part is why nothing sends `activate` afterwards — the front-bringing has
 * already happened, and asking twice would be asking for something that is
 * already true.
 *
 * The bundle identifier is used rather than the name because a name is a
 * guess: `open -a DevHub` matches whatever is called DevHub, including a copy
 * in the Downloads folder that is not the one anybody meant.
 *
 * What this deliberately does not do is fall back. A DevHub run from a
 * checkout is not registered with Launch Services and `open -b` will not find
 * it; the answer to that is a sentence saying so, not a quiet return to the
 * old "DevHub is not running" as though nothing had been attempted.
 */

import { execFile } from "node:child_process";
import { connect } from "node:net";
import type { ControlResponse } from "./protocol.js";

/**
 * The bundle to ask macOS for.
 *
 * It is a parameter rather than a constant because which DevHub the CLI
 * belongs to is decided by the profile in its generated launcher, and a
 * `devhub-dev` that woke the packaged DevHub would be answering with the wrong
 * application.
 */

/** How long a cold start is given before the wait is called a failure. */
export const LAUNCH_TIMEOUT_MS = 30_000;

/** How often the socket is asked, while waiting. */
export const LAUNCH_POLL_MS = 200;

/**
 * The socket said nothing was there.
 *
 * A type rather than a message, because two callers now need to tell "DevHub
 * is not running" from every other reason a request can fail, and matching on
 * the text of a sentence is how the sentence becomes impossible to change.
 */
export class NotRunning extends Error {
	constructor() {
		super("DevHub is not running. Start DevHub and run this command again.");
		this.name = "NotRunning";
	}
}

/**
 * The three things starting DevHub needs from the world, so that the tests do
 * not need the world. Time is in here for the same reason the socket is: a
 * test for "it gave up after thirty seconds" that takes thirty seconds is a
 * test nobody runs.
 */
export interface Launcher {
	/** Ask macOS to start DevHub. Rejects with the reason it could not. */
	open(): Promise<void>;
	/** The bundle `open` was asked for, for the message when it is not there. */
	readonly bundleIdentifier: string;
	/** Whether the control socket is answering right now. */
	answers(): Promise<boolean>;
	pause(ms: number): Promise<void>;
	now(): number;
}

/**
 * Send a request, and — when a launcher is given — start DevHub and wait if
 * there is no DevHub to send it to.
 *
 * `undefined` means DevHub was started rather than asked: there is no answer
 * to print because nothing was answered, and the caller says so in its own
 * words. Returning a made-up successful response instead would be this file
 * claiming DevHub did something nobody ever asked it to do.
 */
export async function sendOrLaunch(
	send: () => Promise<ControlResponse>,
	launcher: Launcher | undefined,
): Promise<ControlResponse | undefined> {
	try {
		return await send();
	} catch (error) {
		if (!(error instanceof NotRunning) || launcher === undefined) throw error;
		await launchAndWait(launcher);
		return undefined;
	}
}

/**
 * Start DevHub and wait for it to be able to answer.
 *
 * The wait is for the socket rather than for a duration, because a duration is
 * a guess about a machine this code is not running on: a cold start behind a
 * first-launch security check takes many seconds, and a warm one takes barely
 * any. The ceiling is there so that a DevHub which never comes up is reported
 * instead of hanging a terminal forever.
 */
export async function launchAndWait(launcher: Launcher): Promise<void> {
	try {
		await launcher.open();
	} catch (error) {
		throw new Error(
			`DevHub is not running, and it could not be started: ${
				error instanceof Error ? error.message : String(error)
			}\nmacOS was asked to open the bundle ${launcher.bundleIdentifier} and found no DevHub installed. A DevHub running from a source checkout is not registered with macOS, so start that one yourself and run this command again.`,
		);
	}
	const deadline = launcher.now() + LAUNCH_TIMEOUT_MS;
	for (;;) {
		if (await launcher.answers()) return;
		if (launcher.now() >= deadline) {
			throw new Error(
				`DevHub was started, but its control socket did not answer within ${LAUNCH_TIMEOUT_MS / 1000} seconds. It may still be starting; run this command again.`,
			);
		}
		await launcher.pause(LAUNCH_POLL_MS);
	}
}

/** The real thing: macOS, the socket, and the clock. */
export function bundleLauncher(
	socketPath: string,
	bundleIdentifier: string,
): Launcher {
	return {
		bundleIdentifier,
		open: () => openBundle(bundleIdentifier),
		answers: () => socketAnswers(socketPath),
		pause: (ms) =>
			new Promise((resolve) => {
				setTimeout(resolve, ms);
			}),
		now: () => Date.now(),
	};
}

function openBundle(bundleIdentifier: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			"/usr/bin/open",
			["-b", bundleIdentifier],
			(error, _stdout, stderr) => {
				if (!error) {
					resolve();
					return;
				}
				// `open` puts its reason on stderr and says nothing useful in the
				// exit status, so the reason is what gets reported.
				const reason = stderr.trim();
				reject(new Error(reason.length > 0 ? reason : error.message));
			},
		);
	});
}

/**
 * Whether anything is listening yet.
 *
 * Connecting is the whole test, and it is the same test the app itself uses
 * before it claims the socket (`controlServer.ts`): a connection that is
 * accepted means a DevHub is serving there. Nothing is sent, so a DevHub that
 * is midway through starting is not handed a request it is not ready for.
 */
export function socketAnswers(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = connect(socketPath);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => {
			probe.destroy();
			resolve(false);
		});
	});
}
