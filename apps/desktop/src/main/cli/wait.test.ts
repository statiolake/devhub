/**
 * Holding a terminal open until an editor is closed.
 *
 * The marker and the socket are faked for the decision tests, because what is
 * worth pinning down is when the wait ends and what it says when it ends
 * badly — not whether `stat` works. `createMarker` and `removeMarker` are
 * tested against a real directory, because those are the parts that are only
 * about the filesystem.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import {
	createMarker,
	markerWorld,
	removeMarker,
	waitForClose,
	type WaitWorld,
} from "./wait.js";

/**
 * A DevHub that closes the editor after `closesAfter` looks, and may have
 * stopped by then. Nothing sleeps: `pause` only counts.
 */
function fakeWorld(options: {
	readonly closesAfter: number | "never";
	readonly stopsAfter?: number;
}): WaitWorld & { readonly pauses: () => number } {
	let looks = 0;
	let pauses = 0;
	return {
		pauses: () => pauses,
		markerExists: () => {
			looks += 1;
			return Promise.resolve(
				options.closesAfter === "never" || looks < options.closesAfter,
			);
		},
		devhubAnswers: () =>
			Promise.resolve(
				options.stopsAfter === undefined || looks < options.stopsAfter,
			),
		pause: () => {
			pauses += 1;
			return Promise.resolve();
		},
	};
}

describe("waiting for an editor to be closed", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = makeScratchDir("cli-wait");
	});

	afterEach(() => {
		removeScratchDir(scratch);
	});

	/** The whole point: the tab closes, the marker goes, the command returns. */
	it("returns as soon as the marker is gone", async () => {
		const world = fakeWorld({ closesAfter: 3 });
		await expect(waitForClose(world)).resolves.toBeUndefined();
		expect(world.pauses()).toBe(2);
	});

	/**
	 * A marker that was never there — or was deleted before the first look,
	 * which is what the workbench does when the editor could not be opened at
	 * all — is a wait that is already over, not a wait that hangs.
	 */
	it("returns immediately when the marker was already gone", async () => {
		const world = fakeWorld({ closesAfter: 1 });
		await expect(waitForClose(world)).resolves.toBeUndefined();
		expect(world.pauses()).toBe(0);
	});

	/**
	 * Quitting DevHub with the file still open must not leave a terminal that
	 * never comes back. The person is told why, and the status is a failure,
	 * because the edit they were asked for did not happen.
	 */
	it("stops with a sentence when DevHub goes away first", async () => {
		const world = fakeWorld({ closesAfter: "never", stopsAfter: 3 });
		await expect(waitForClose(world)).rejects.toThrow(
			/DevHub stopped while the file was still open/,
		);
	});

	/**
	 * The marker is looked at before DevHub is, so a DevHub that deletes the
	 * marker and quits in the same instant is a success. Checking liveness
	 * first would turn the ordinary "close the editor, then quit DevHub" into
	 * a failed commit.
	 */
	it("counts a marker deleted on the way out as the editor being closed", async () => {
		const world = fakeWorld({ closesAfter: 2, stopsAfter: 2 });
		await expect(waitForClose(world)).resolves.toBeUndefined();
	});

	/** The marker gets a directory of its own, so nothing else can send the signal. */
	it("makes a private marker, and takes the whole directory away again", async () => {
		const marker = await createMarker(scratch);
		expect(existsSync(marker)).toBe(true);
		expect(statSync(marker).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(marker)).mode & 0o777).toBe(0o700);
		expect(dirname(marker)).toContain("devhub-wait-");

		await removeMarker(marker);
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(dirname(marker))).toBe(false);
	});

	/** Two waits at once must not share one signal. */
	it("makes a different marker every run", async () => {
		const first = await createMarker(scratch);
		const second = await createMarker(scratch);
		expect(dirname(first)).not.toBe(dirname(second));
	});

	/** Cleaning up must not itself fail the command it is cleaning up after. */
	it("does not mind being asked to remove a marker that is already gone", async () => {
		const marker = await createMarker(scratch);
		await removeMarker(marker);
		await expect(removeMarker(marker)).resolves.toBeUndefined();
	});

	/**
	 * The real `markerExists`, against a real file: an unreadable or missing
	 * path is the answer "no", and a present one is "yes".
	 */
	it("reads a real marker off the disk", async () => {
		const directory = join(scratch, "real");
		mkdirSync(directory);
		const marker = join(directory, "marker");
		writeFileSync(marker, "");
		const world = markerWorld(marker, join(scratch, "no.sock"));
		await expect(world.markerExists()).resolves.toBe(true);
		// A socket nothing is listening on is a DevHub that is not there.
		await expect(world.devhubAnswers()).resolves.toBe(false);

		await removeMarker(marker);
		await expect(world.markerExists()).resolves.toBe(false);
	});
});
