/**
 * Starting DevHub when there is no DevHub to talk to.
 *
 * The launcher is faked, because the three things it needs from the world are
 * a command that starts an application, a socket and a clock, and none of them
 * can be had in a unit test without making the test about them instead. The
 * real one is exercised on a machine; what is worth pinning down here is the
 * decision — when DevHub is started, that the request is then sent anyway, and
 * what is said when it cannot be started or never comes up.
 */

import { describe, expect, it } from "vitest";
import {
	commandLauncher,
	forwardedSocketLauncher,
	launchAndWait,
	launchCommandFor,
	LAUNCH_TIMEOUT_MS,
	NotRunning,
	parseLaunchCommand,
	sendOrLaunch,
	type Launcher,
} from "./launch.js";
import type { ControlResponse } from "./protocol.js";

const SOCKET = "/tmp/devhub-test/control.sock";
const DESCRIPTION = "/usr/bin/open -a /Applications/DevHub.app --background";

/**
 * A DevHub that answers after `answersAfter` probes, or never. Time moves only
 * when the code under test waits, which is what makes a thirty-second ceiling
 * testable in no time at all.
 */
function fakeLauncher(options: {
	readonly answersAfter: number | "never";
	readonly opens?: boolean;
}): Launcher & { readonly opened: string[]; readonly probes: () => number } {
	const opened: string[] = [];
	let probes = 0;
	let clock = 0;
	return {
		description: DESCRIPTION,
		socketPath: SOCKET,
		// The real one's wording, so the assertions below are about the text a
		// person actually reads.
		cannotStart: (reason: string) =>
			`DevHub is not running, and it could not be started: ${reason}\nThe 'devhub' launcher starts DevHub with ${DESCRIPTION}. If DevHub has moved, run "DevHub: Install 'devhub' command in PATH" from DevHub's command palette again.`,
		opened,
		probes: () => probes,
		open: () => {
			opened.push(DESCRIPTION);
			// A launch that works reports nothing: the socket is what says
			// whether there is a DevHub now.
			return options.opens === false
				? Promise.reject(new Error("spawn ENOENT"))
				: new Promise<never>(() => undefined);
		},
		answers: () => {
			probes += 1;
			return Promise.resolve(
				options.answersAfter !== "never" && probes >= options.answersAfter,
			);
		},
		pause: (ms) => {
			clock += ms;
			return Promise.resolve();
		},
		now: () => clock,
	};
}

const ANSWER: ControlResponse = { ok: true, message: "Opened README.md." };

/** A `send` that fails until DevHub exists, then answers. */
function sendAfterLaunch(launcher: { readonly opened: string[] }) {
	let sends = 0;
	return {
		send: () => {
			sends += 1;
			return launcher.opened.length === 0
				? Promise.reject(new NotRunning())
				: Promise.resolve(ANSWER);
		},
		sends: () => sends,
	};
}

describe("starting DevHub when devhub finds none", () => {
	/**
	 * The ordinary case, and the one that must not change: DevHub is running,
	 * so it is asked and nothing is started.
	 */
	it("asks the DevHub that is already running, and starts nothing", async () => {
		const launcher = fakeLauncher({ answersAfter: 1 });
		const response = await sendOrLaunch(
			() => Promise.resolve(ANSWER),
			launcher,
		);
		expect(response).toEqual(ANSWER);
		expect(launcher.opened).toEqual([]);
	});

	/**
	 * The whole sequence: the send fails, DevHub is started, the socket is
	 * waited for, and then the *same* request is sent again and its answer is
	 * what comes back. Not a second shape of success meaning "started it, ask
	 * again yourself" — every caller past `sendOrLaunch` is written once.
	 */
	it("starts DevHub, waits for its socket, and sends the request again", async () => {
		const launcher = fakeLauncher({ answersAfter: 4 });
		const sender = sendAfterLaunch(launcher);
		const response = await sendOrLaunch(sender.send, launcher);
		expect(launcher.opened).toEqual([DESCRIPTION]);
		expect(launcher.probes()).toBe(4);
		expect(sender.sends()).toBe(2);
		expect(response).toEqual(ANSWER);
	});

	/**
	 * The report that must not be swallowed. Falling back to "DevHub is not
	 * running" here would say nothing was attempted, when something was.
	 */
	it("says that it tried to start DevHub and could not", async () => {
		const launcher = fakeLauncher({ answersAfter: "never", opens: false });
		await expect(launchAndWait(launcher)).rejects.toThrow(
			/could not be started: spawn ENOENT/,
		);
		await expect(launchAndWait(launcher)).rejects.toThrow(
			/starts DevHub with \/usr\/bin\/open -a/,
		);
	});

	/**
	 * A DevHub that never comes up is reported, not waited on forever — and the
	 * report names both halves of what was being waited for, so that the next
	 * question ("is it the app or the socket?") has somewhere to start.
	 */
	it("gives up on a DevHub that never answers, naming the socket and the app", async () => {
		const launcher = fakeLauncher({ answersAfter: "never" });
		await expect(launchAndWait(launcher)).rejects.toThrow(
			new RegExp(
				`started with /usr/bin/open -a .*nothing was listening on ${SOCKET} within ${LAUNCH_TIMEOUT_MS / 1000} seconds`,
			),
		);
		expect(launcher.opened).toEqual([DESCRIPTION]);
	});

	/** Exactly one bound, and the poll is what fills it. */
	it("polls until the bound and no further", async () => {
		const launcher = fakeLauncher({ answersAfter: "never" });
		await expect(launchAndWait(launcher)).rejects.toThrow();
		expect(launcher.now()).toBeGreaterThanOrEqual(LAUNCH_TIMEOUT_MS);
		expect(launcher.probes()).toBeGreaterThan(1);
	});

	/** A failure that is not "there is no DevHub" is not answered by making one. */
	it("does not start DevHub because some other request failed", async () => {
		const launcher = fakeLauncher({ answersAfter: 1 });
		await expect(
			sendOrLaunch(
				() => Promise.reject(new Error("DevHub closed the connection")),
				launcher,
			),
		).rejects.toThrow(/closed the connection/);
		expect(launcher.opened).toEqual([]);
	});
});

describe("the command that starts this DevHub", () => {
	/**
	 * A checkout is told apart from a bundle by what is on disk, not by an
	 * environment variable: `dev.sh` is there or it is not.
	 */
	it("runs dev.sh for a DevHub running from a checkout", () => {
		expect(
			launchCommandFor(
				"/repo/apps/desktop",
				(path) => path === "/repo/apps/desktop/scripts/dev.sh",
			),
		).toEqual(["/repo/apps/desktop/scripts/dev.sh"]);
	});

	/**
	 * The path of the running bundle, not its identifier: a DevHub that has
	 * never been opened from the Finder is not known to Launch Services, and
	 * `open -b` would report it missing on a machine where it is installed.
	 */
	it("opens the running bundle, in the background, for a packaged DevHub", () => {
		expect(
			launchCommandFor(
				"/Applications/DevHub.app/Contents/Resources/app",
				() => false,
			),
		).toEqual([
			"/usr/bin/open",
			"-a",
			"/Applications/DevHub.app",
			"--background",
		]);
	});
});

describe("what the launcher script recorded", () => {
	it("reads the command back", () => {
		expect(parseLaunchCommand('["/usr/bin/open","-a","/x.app"]')).toEqual([
			"/usr/bin/open",
			"-a",
			"/x.app",
		]);
	});

	/** An older launcher is named for what it is, with the way to fix it. */
	it("refuses a launcher that does not say how to start DevHub", () => {
		expect(() => parseLaunchCommand(undefined)).toThrow(
			/DEVHUB_LAUNCH_COMMAND is not set.*Install 'devhub' command in PATH/s,
		);
		expect(() => parseLaunchCommand("[]")).toThrow(/is not a command/);
		expect(() => parseLaunchCommand('"open"')).toThrow(/is not a command/);
	});
});

describe("running the launch command for real", () => {
	/**
	 * A command that is not there is reported at once rather than waited out:
	 * thirty seconds of silence is a bad way to learn that a path is wrong.
	 */
	it("reports a launch command that cannot be started", async () => {
		await expect(
			commandLauncher(SOCKET, ["/no/such/devhub-launcher"]).open(),
		).rejects.toThrow(/ENOENT/);
	});

	/** And one that starts, fails, and exits is reported for what it is. */
	it("reports a launch command that exits non-zero", async () => {
		await expect(
			commandLauncher(SOCKET, ["/bin/sh", "-c", "exit 3"]).open(),
		).rejects.toThrow(/exited with status 3/);
	});

	/**
	 * The ordinary case reports nothing at all — including `open`, which exits
	 * successfully the moment it has handed the request to Launch Services and
	 * long before there is a DevHub. Reporting that as "started" is how a wait
	 * for the socket turns into a claim that never checked.
	 */
	it("says nothing about a launch command that started", async () => {
		const settled = await Promise.race([
			commandLauncher(SOCKET, ["/bin/sh", "-c", "exit 0"])
				.open()
				.then(
					() => "resolved",
					() => "rejected",
				),
			new Promise((resolve) => setTimeout(() => resolve("waiting"), 200)),
		]);
		expect(settled).toBe("waiting");
	});
});

/**
 * A `devhub` on a host cannot start DevHub, and that is a fact rather than a
 * gap.
 *
 * DevHub runs on the machine the window is on; the socket over there is
 * forwarded from it. So "not running" is the end of the matter, and the
 * sentence must not send somebody to reinstall a launcher on the wrong
 * computer.
 */
describe("the launcher for a machine DevHub does not run on", () => {
	const REMOTE_SOCKET = "/home/dev/.devhub/terminal/control-abcdef.sock";

	it("refuses to start anything, naming the socket that is not answering", async () => {
		const launcher = forwardedSocketLauncher(REMOTE_SOCKET, "ssh:build-host");

		await expect(launcher.open()).rejects.toThrow(
			`DevHub is not listening on ${REMOTE_SOCKET}.`,
		);
	});

	it("says where DevHub actually is, and not how to reinstall a launcher", () => {
		const said = forwardedSocketLauncher(
			REMOTE_SOCKET,
			"ssh:build-host",
		).cannotStart("ignored");

		expect(said).toContain(`DevHub is not listening on ${REMOTE_SOCKET}.`);
		expect(said).toContain("ssh:build-host");
		// The local advice would be actively misleading over there: there is no
		// launcher on that machine to reinstall, and the command that would do
		// it is in a window on another computer.
		expect(said).not.toContain("Install 'devhub' command in PATH");
	});

	/**
	 * Same shape as the local one, so `sendOrLaunch` is written once and no
	 * caller asks which kind of machine it is on.
	 */
	it("is a Launcher like any other, so nothing downstream branches", async () => {
		const launcher: Launcher = forwardedSocketLauncher(
			REMOTE_SOCKET,
			"ssh:build-host",
		);

		expect(launcher.socketPath).toBe(REMOTE_SOCKET);
		expect(typeof launcher.now()).toBe("number");
		// Nothing is listening on a path that does not exist, and asking is the
		// same probe the local launcher uses.
		expect(await launcher.answers()).toBe(false);
	});
});
