/**
 * Starting DevHub when there is no DevHub to talk to.
 *
 * The launcher is faked, because the three things it needs from the world are
 * an application, a socket and a clock, and none of them can be had in a unit
 * test without making the test about them instead. The real one is exercised
 * on a machine; what is worth pinning down here is the decision — who starts
 * DevHub, when, and what is said when it cannot be started.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, profileLocations } from "../../model/profile.js";
import {
	LAUNCH_TIMEOUT_MS,
	launchAndWait,
	NotRunning,
	sendOrLaunch,
	type Launcher,
} from "./launch.js";
import type { ControlResponse } from "./protocol.js";

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
		bundleIdentifier: BUNDLE_ID,
		opened,
		probes: () => probes,
		open: () => {
			opened.push(BUNDLE_ID);
			return options.opens === false
				? Promise.reject(
						new Error(`Unable to find application for bundle ${BUNDLE_ID}.`),
					)
				: Promise.resolve();
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

const BUNDLE_ID = profileLocations(
	DEFAULT_PROFILE,
	"/home/tester",
).bundleIdentifier;

const ANSWER: ControlResponse = { ok: true, message: "DevHub is in front." };

describe("starting DevHub when a bare devhub finds none", () => {
	/**
	 * The default profile's identifier is derived rather than read from
	 * product.json, because the CLI is a plain script run under the app's
	 * Electron as Node and cannot load VS Code's product. A derivation that can
	 * drift silently is worth exactly one test:
	 * the day somebody renames the bundle, `open -b` would start looking for an
	 * application nobody ships, and the CLI would report that DevHub is not
	 * installed on a machine where it is.
	 */
	it("asks for the bundle the packaging actually builds", () => {
		const overrides = JSON.parse(
			readFileSync(
				join(
					dirname(fileURLToPath(import.meta.url)),
					"..",
					"..",
					"..",
					"product-overrides.json",
				),
				"utf8",
			),
		) as { readonly darwinBundleIdentifier: string };
		expect(BUNDLE_ID).toBe(overrides.darwinBundleIdentifier);
	});

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
	 * No DevHub, so one is made, and the command waits for it to be able to
	 * answer rather than reporting success at a thing that is still starting.
	 */
	it("starts DevHub, then waits until its socket answers", async () => {
		const launcher = fakeLauncher({ answersAfter: 4 });
		const response = await sendOrLaunch(
			() => Promise.reject(new NotRunning()),
			launcher,
		);
		expect(launcher.opened).toEqual([BUNDLE_ID]);
		expect(launcher.probes()).toBe(4);
		// Nothing was answered, so nothing is returned to be printed: `open -b`
		// has already brought DevHub forward, and asking again would be asking
		// for something that is already true.
		expect(response).toBeUndefined();
	});

	/**
	 * The report that must not be swallowed. Falling back to the old "DevHub is
	 * not running" here would say nothing was attempted, when something was.
	 */
	it("says that it tried to start DevHub and could not", async () => {
		const launcher = fakeLauncher({ answersAfter: "never", opens: false });
		await expect(launchAndWait(launcher)).rejects.toThrow(
			/could not be started: Unable to find application for bundle net\.statiolake\.devhub/,
		);
		await expect(launchAndWait(launcher)).rejects.toThrow(
			/source checkout is not registered with macOS/,
		);
	});

	/** A DevHub that never comes up is reported, not waited on forever. */
	it("gives up on a DevHub that never answers, and says so", async () => {
		const launcher = fakeLauncher({ answersAfter: "never" });
		await expect(launchAndWait(launcher)).rejects.toThrow(
			new RegExp(`did not answer within ${LAUNCH_TIMEOUT_MS / 1000} seconds`),
		);
		expect(launcher.opened).toEqual([BUNDLE_ID]);
	});

	/**
	 * Every command that carries something to do is answered by the DevHub that
	 * exists, or not at all. Starting an application as a side effect of being
	 * asked to open a file is a much bigger thing than what was asked.
	 */
	it("starts nothing for a command that was given no launcher", async () => {
		await expect(
			sendOrLaunch(() => Promise.reject(new NotRunning()), undefined),
		).rejects.toThrow(/DevHub is not running\. Start DevHub/);
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
