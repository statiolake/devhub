import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	discardUnsavedEditors,
	readUnsavedEditors,
	type WorkbenchContents,
} from "./workbenchUnsaved.js";
import { InvariantViolation } from "./invariant.js";
import { TypedFailure } from "../../model/wire.js";

/**
 * A workbench's contents that answer each request with `answer`, or not at
 * all when it is `undefined`.
 */
function contents(answer?: (channel: string) => unknown) {
	const self = new EventEmitter();
	const ipc = new EventEmitter();
	let destroyed = false;
	const fake: WorkbenchContents & { destroy(): void; ipcListeners(): number } =
		{
			send(channel: string, ...args: unknown[]) {
				if (answer === undefined) return;
				const reply = answer(channel);
				queueMicrotask(() => ipc.emit(`${channel}Reply`, {}, args[0], reply));
			},
			isDestroyed: () => destroyed,
			once: (event, listener) => self.once(event, listener),
			removeListener: (event, listener) => self.removeListener(event, listener),
			ipc: {
				on: (channel, listener) => ipc.on(channel, listener),
				removeListener: (channel, listener) =>
					ipc.removeListener(channel, listener),
			},
			destroy() {
				destroyed = true;
				self.emit("destroyed");
			},
			ipcListeners: () =>
				ipc
					.eventNames()
					.reduce((sum, name) => sum + ipc.listenerCount(name), 0),
		};
	return fake;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("reading a workbench's unsaved editors", () => {
	it("answers with the names the workbench gives", async () => {
		const workbench = contents(() => ({ names: ["main.ts", "Untitled-1"] }));
		expect(await readUnsavedEditors(workbench)).toEqual([
			"main.ts",
			"Untitled-1",
		]);
		expect(workbench.ipcListeners()).toBe(0);
	});

	it("ends with a sentence when the workbench never answers", async () => {
		vi.useFakeTimers();
		const workbench = contents();
		const read = readUnsavedEditors(workbench, 5_000);
		const failure = expect(read).rejects.toThrow(
			"The editor did not answer within 5 seconds.",
		);
		await vi.advanceTimersByTimeAsync(5_000);
		await failure;
		await expect(read).rejects.toBeInstanceOf(TypedFailure);
		expect(workbench.ipcListeners()).toBe(0);
	});

	it("ends when the workbench goes away before answering", async () => {
		const workbench = contents();
		const read = readUnsavedEditors(workbench);
		workbench.destroy();
		await expect(read).rejects.toThrow(
			"The editor went away before it answered.",
		);
	});

	it("refuses a workbench that is already gone without asking it", async () => {
		const workbench = contents(() => {
			throw new Error("must not be asked");
		});
		workbench.destroy();
		await expect(readUnsavedEditors(workbench)).rejects.toBeInstanceOf(
			TypedFailure,
		);
	});

	it("treats a reply of the wrong shape as a broken build", async () => {
		const workbench = contents(() => ({ names: "main.ts" }));
		await expect(readUnsavedEditors(workbench)).rejects.toBeInstanceOf(
			InvariantViolation,
		);
	});
});

describe("discarding a workbench's unsaved editors", () => {
	it("succeeds when nothing is left modified", async () => {
		const workbench = contents(() => ({ errors: [], remaining: [] }));
		await expect(discardUnsavedEditors(workbench, 1_000)).resolves.toBe(
			undefined,
		);
	});

	it("fails naming what could not be discarded, and why", async () => {
		const workbench = contents(() => ({
			errors: ["EACCES: permission denied"],
			remaining: ["main.ts"],
		}));
		await expect(discardUnsavedEditors(workbench, 1_000)).rejects.toThrow(
			"Unsaved changes in main.ts could not be discarded. EACCES: permission denied",
		);
	});

	it("fails when a revert threw even though nothing is left modified", async () => {
		const workbench = contents(() => ({
			errors: ["the notebook refused"],
			remaining: [],
		}));
		await expect(discardUnsavedEditors(workbench, 1_000)).rejects.toThrow(
			"Unsaved changes could not be discarded. the notebook refused",
		);
	});

	it("ends when the workbench never answers", async () => {
		vi.useFakeTimers();
		const discard = discardUnsavedEditors(contents(), 20_000);
		const failure = expect(discard).rejects.toThrow(
			"The editor did not answer within 20 seconds.",
		);
		await vi.advanceTimersByTimeAsync(20_000);
		await failure;
	});
});
