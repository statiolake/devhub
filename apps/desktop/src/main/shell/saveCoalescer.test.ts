import { describe, expect, it } from "vitest";
import { SaveCoalescer } from "./saveCoalescer.js";

function deferredSaves() {
	const started: Array<{ resolve: () => void; reject: (e: unknown) => void }> =
		[];
	const save = () =>
		new Promise<void>((resolve, reject) => {
			started.push({ resolve, reject });
		});
	return { started, save };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SaveCoalescer", () => {
	it("starts a save at once when none is running", async () => {
		const { started, save } = deferredSaves();
		const saves = new SaveCoalescer(save);
		const one = saves.request();
		expect(started).toHaveLength(1);
		started[0].resolve();
		await expect(one).resolves.toBeUndefined();
	});

	it("answers every request made during a save with one later save", async () => {
		const { started, save } = deferredSaves();
		const saves = new SaveCoalescer(save);
		const first = saves.request();
		const second = saves.request();
		const third = saves.request();
		expect(second).toBe(third);
		expect(started).toHaveLength(1);
		let secondDone = false;
		void second.then(() => (secondDone = true));
		started[0].resolve();
		await first;
		await tick();
		// The first save started before the second request: it does not count.
		expect(secondDone).toBe(false);
		expect(started).toHaveLength(2);
		started[1].resolve();
		await second;
		expect(started).toHaveLength(2);
	});

	it("still runs the waiting save after a failed one, and reports each its own", async () => {
		const { started, save } = deferredSaves();
		const saves = new SaveCoalescer(save);
		const first = saves.request();
		const second = saves.request();
		started[0].reject(new Error("disk full"));
		await expect(first).rejects.toThrow("disk full");
		await tick();
		expect(started).toHaveLength(2);
		started[1].resolve();
		await expect(second).resolves.toBeUndefined();
	});

	it("never runs two saves at once", async () => {
		let running = 0;
		let most = 0;
		const saves = new SaveCoalescer(async () => {
			running += 1;
			most = Math.max(most, running);
			await tick();
			running -= 1;
		});
		const all: Promise<void>[] = [];
		for (let round = 0; round < 20; round += 1) {
			all.push(saves.request());
			if (round % 3 === 0) await tick();
		}
		await Promise.all(all);
		expect(most).toBe(1);
	});
});
