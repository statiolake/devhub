/**
 * Starting DevHub when `devhub` finds it is not running.
 *
 * Every `devhub` command does this, not just a bare one. The command names a
 * DevHub — its profile's control socket is written into the launcher script —
 * and "there is no DevHub listening" is a fact about the moment rather than an
 * answer to what was asked. Somebody who types `devhub README.md`, or has
 * `devhub --wait` as their EDITOR, wants the file open; a sentence telling
 * them to go and start DevHub first is a step a program can take for them. So
 * the CLI takes it, and then asks again. The request that follows is the
 * request that was typed, unchanged: `--wait` still waits, stdin has already
 * been read (see `main` in `devhubCli.ts`, which spools it before anything
 * touches the socket, so the pipe cannot be lost to a cold start).
 *
 * How DevHub is started is not guessed here. It is *recorded* by the app that
 * installed the launcher, in `DEVHUB_LAUNCH_COMMAND`, because the app is the
 * only thing that knows how it was itself started:
 *
 *   - A packaged DevHub records `open -a <the .app that is running>
 *     --background`. The path rather than the bundle identifier, because a
 *     DevHub that has never been launched from the Finder is not yet known to
 *     Launch Services and `open -b` would report it as not installed on a
 *     machine where it plainly is. `--background` because the request that
 *     follows decides whether DevHub comes forward — `devhub` on its own
 *     activates, `devhub --wait` deliberately does not steal focus twice.
 *   - A DevHub run from a checkout records `apps/desktop/scripts/dev.sh`,
 *     which is how such a DevHub is started and the only way it can be: it is
 *     not an installed application, it needs VS Code's own Electron and the
 *     profile's directories on its command line, and Launch Services has never
 *     heard of it. The profile rides along in the environment, which is where
 *     `dev.sh` reads it from.
 *
 * Both are the same shape — a command to run, detached, that leaves a DevHub
 * behind it — so there is one launcher here and not two. `open` exits as soon
 * as it has handed the request over; `dev.sh` *is* the app and does not exit
 * at all. What is watched, either way, is the control socket: DevHub is ready
 * exactly when the socket answers, and a launch command that exits non-zero
 * before then is reported for what it is instead of being waited out.
 *
 * Nothing here worries about two `devhub` commands racing into a cold start.
 * The second one starts a second app, the app's own single-instance lock turns
 * that into a no-op, and both then wait for the one socket.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve as resolvePath, join } from "node:path";
import type { ControlResponse } from "./protocol.js";

/** The launcher script's record of how to start the DevHub it belongs to. */
export const LAUNCH_COMMAND_ENVIRONMENT_VARIABLE = "DEVHUB_LAUNCH_COMMAND";

/** How long a cold start is given before the wait is called a failure. */
export const LAUNCH_TIMEOUT_MS = 30_000;

/** How often the socket is asked, while waiting. */
export const LAUNCH_POLL_MS = 200;

/**
 * The socket said nothing was there.
 *
 * A type rather than a message, because the callers need to tell "DevHub is
 * not running" from every other reason a request can fail, and matching on the
 * text of a sentence is how the sentence becomes impossible to change.
 */
export class NotRunning extends Error {
	constructor() {
		super("DevHub is not running.");
		this.name = "NotRunning";
	}
}

/**
 * The command that starts this DevHub, as the app that installed the launcher
 * knows it.
 *
 * `appRoot` is where DevHub's own code lives — `apps/desktop` in a checkout,
 * `<DevHub.app>/Contents/Resources/app` in a bundle — and the difference
 * between the two is asked of the filesystem rather than of an environment
 * variable: a checkout has `scripts/dev.sh` in it and a bundle does not. An
 * environment variable would be a claim about the run; this is the run.
 */
export function launchCommandFor(
	appRoot: string,
	exists: (path: string) => boolean = existsSync,
): readonly string[] {
	const devScript = join(appRoot, "scripts", "dev.sh");
	if (exists(devScript)) return [devScript];
	// `<DevHub.app>/Contents/Resources/app` -> `<DevHub.app>`.
	const bundle = resolvePath(appRoot, "..", "..", "..");
	return ["/usr/bin/open", "-a", bundle, "--background"];
}

/**
 * What the launcher script recorded, read back.
 *
 * A launcher without it is one written by an older DevHub, and that is said
 * out loud rather than papered over with a guess at the bundle identifier:
 * a guess that works on the machine where DevHub has already been opened once
 * and fails on the machine where it has not is worse than a sentence naming
 * the command that fixes it.
 */
export function parseLaunchCommand(raw: string | undefined): readonly string[] {
	if (raw === undefined || raw === "") {
		throw new Error(
			`${LAUNCH_COMMAND_ENVIRONMENT_VARIABLE} is not set, so this launcher does not know how to start DevHub. Run "DevHub: Install 'devhub' command in PATH" from DevHub's command palette to write it again.`,
		);
	}
	const parsed: unknown = JSON.parse(raw);
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		!parsed.every((part) => typeof part === "string")
	) {
		throw new Error(
			`${LAUNCH_COMMAND_ENVIRONMENT_VARIABLE} is not a command: ${raw}`,
		);
	}
	return parsed as readonly string[];
}

/**
 * The things starting DevHub needs from the world, so that the tests do not
 * need the world. Time is in here for the same reason the socket is: a test
 * for "it gave up after thirty seconds" that takes thirty seconds is a test
 * nobody runs.
 */
export interface Launcher {
	/**
	 * Start DevHub, and report only failure.
	 *
	 * The promise rejects with the reason the command could not be started, or
	 * that it started and gave up; it never resolves, because "the command ran"
	 * is not the question. Whether there is a DevHub is asked of the socket, and
	 * this promise is raced against that wait — which is what keeps a wrong path
	 * from costing thirty seconds of silence, and keeps a launch command that
	 * exits the moment it has handed over (`open`) from being mistaken for one.
	 */
	open(): Promise<never>;
	/** What was started, named in the message when it never answers. */
	readonly description: string;
	/** The socket being waited on, named in the same message. */
	readonly socketPath: string;
	/** Whether the control socket is answering right now. */
	answers(): Promise<boolean>;
	pause(ms: number): Promise<void>;
	now(): number;
}

/**
 * Send a request; if there is no DevHub to send it to, make one and send the
 * same request again.
 *
 * The retry is the whole point: what comes back is an answer to what was
 * asked, so every caller past this line is written once, for a DevHub that is
 * running. There is no second shape of success meaning "started it, ask again
 * yourself".
 */
export async function sendOrLaunch(
	send: () => Promise<ControlResponse>,
	launcher: Launcher,
): Promise<ControlResponse> {
	try {
		return await send();
	} catch (error) {
		if (!(error instanceof NotRunning)) throw error;
		await launchAndWait(launcher);
		return await send();
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
	const failed = launcher.open().catch((error: unknown) => {
		throw new Error(
			`DevHub is not running, and it could not be started: ${
				error instanceof Error ? error.message : String(error)
			}\nThe 'devhub' launcher starts DevHub with ${launcher.description}. If DevHub has moved, run "DevHub: Install 'devhub' command in PATH" from DevHub's command palette again.`,
		);
	});
	try {
		await Promise.race([failed, waitForSocket(launcher)]);
	} finally {
		// The wait is over either way, and a launch that fails after DevHub has
		// already answered is not this command's business — but an unhandled
		// rejection would take the process down over it.
		failed.catch(() => undefined);
	}
}

async function waitForSocket(launcher: Launcher): Promise<void> {
	const deadline = launcher.now() + LAUNCH_TIMEOUT_MS;
	for (;;) {
		if (await launcher.answers()) return;
		if (launcher.now() >= deadline) {
			throw new Error(
				`DevHub was started with ${launcher.description}, but nothing was listening on ${launcher.socketPath} within ${LAUNCH_TIMEOUT_MS / 1000} seconds.`,
			);
		}
		await launcher.pause(LAUNCH_POLL_MS);
	}
}

/** The real thing: a command, the socket, and the clock. */
export function commandLauncher(
	socketPath: string,
	command: readonly string[],
): Launcher {
	return {
		socketPath,
		description: command.join(" "),
		open: () => runDetached(command),
		answers: () => socketAnswers(socketPath),
		pause: (ms) =>
			new Promise((resolve) => {
				setTimeout(resolve, ms);
			}),
		now: () => Date.now(),
	};
}

/**
 * Run the launch command and let it outlive this process.
 *
 * `ELECTRON_RUN_AS_NODE` is taken out of the child's environment and that is
 * not a detail: the launcher script sets it so that the app's Electron runs
 * *this* file as Node, and a DevHub inheriting it would boot as a Node process
 * with no window at all. It is set for the CLI, so it is unset for the app.
 *
 * Only failure is reported: the command could not be started, or it started
 * and exited non-zero. Whether there is a DevHub is the socket's answer, not
 * this one — `open` exits the instant it has handed the request to Launch
 * Services, long before any window exists, and `dev.sh` never exits at all.
 */
function runDetached(command: readonly string[]): Promise<never> {
	const [program, ...args] = command;
	if (program === undefined) {
		return Promise.reject(new Error("the launch command is empty"));
	}
	const environment = { ...process.env };
	delete environment["ELECTRON_RUN_AS_NODE"];
	return new Promise((_resolve, reject) => {
		const child = spawn(program, args, {
			detached: true,
			stdio: "ignore",
			env: environment,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
		});
		child.once("exit", (code) => {
			// Exit 0 is what `open` does the moment it has handed the request
			// over, and it says nothing about whether DevHub came up — so it is
			// not reported as either outcome. The socket answers that.
			if (code !== null && code !== 0) {
				reject(new Error(`${program} exited with status ${code}`));
			}
		});
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
