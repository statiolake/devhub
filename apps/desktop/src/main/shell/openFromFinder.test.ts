import { describe, expect, it, vi } from "vitest";
import { FinderOpens, finderOpen, type CliOpener } from "./openFromFinder.js";

/** A stand-in for `AppController`, recording what the CLI entry point was asked. */
function opener(): CliOpener & {
	calls: [string, string, undefined, undefined][];
} {
	const calls: [string, string, undefined, undefined][] = [];
	return {
		calls,
		openFromCli(path, cwd, position, waitMarkerPath) {
			calls.push([path, cwd, position, waitMarkerPath]);
			return Promise.resolve("open");
		},
	};
}

describe("finderOpen", () => {
	it("is the `devhub <path>` entry point and nothing else", async () => {
		const controller = opener();

		await finderOpen(controller)("/tmp/notes.md");

		// The parity the whole design rests on: Finder and the CLI reach the
		// same function, so where a file lands cannot differ between them.
		expect(controller.calls).toEqual([
			["/tmp/notes.md", "/tmp", undefined, undefined],
		]);
	});

	it("asks for no position and no wait marker, because Finder cannot mean either", async () => {
		const controller = opener();

		await finderOpen(controller)("/tmp/deep/file.txt");

		const [, , position, waitMarkerPath] = controller.calls[0] ?? [];
		expect(position).toBeUndefined();
		expect(waitMarkerPath).toBeUndefined();
	});
});

describe("FinderOpens", () => {
	it("holds paths that arrive before there is anything to open them in", () => {
		const opens = new FinderOpens();

		opens.offer("/tmp/one.md");
		opens.offer("/tmp/two.md");

		expect(opens.queued).toBe(2);
	});

	it("opens everything that was waiting, in the order it arrived", async () => {
		const opens = new FinderOpens();
		const opened: string[] = [];
		opens.offer("/tmp/one.md");
		opens.offer("/tmp/two.md");

		opens.answerWith(async (path) => {
			opened.push(path);
		}, vi.fn());
		await settled();

		expect(opened).toEqual(["/tmp/one.md", "/tmp/two.md"]);
		expect(opens.queued).toBe(0);
	});

	it("opens paths that arrive afterwards straight away", async () => {
		const opens = new FinderOpens();
		const opened: string[] = [];
		opens.answerWith(async (path) => {
			opened.push(path);
		}, vi.fn());

		opens.offer("/tmp/later.md");
		await settled();

		expect(opened).toEqual(["/tmp/later.md"]);
	});

	it("normalises the decomposed paths macOS hands out", async () => {
		const opens = new FinderOpens();
		const opened: string[] = [];
		opens.answerWith(async (path) => {
			opened.push(path);
		}, vi.fn());

		// "\u00e9" as e + combining acute, which is how macOS spells it on the
		// way in; everything downstream compares the path with workspace roots
		// that were composed.
		opens.offer("/tmp/caf\u0065\u0301.md");
		await settled();

		expect(opened).toEqual(["/tmp/caf\u00e9.md"]);
	});

	it("runs one open at a time, so two files cannot race for the selection", async () => {
		const opens = new FinderOpens();
		const events: string[] = [];
		let releaseFirst = (): void => {};
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		opens.offer("/tmp/one.md");
		opens.offer("/tmp/two.md");

		opens.answerWith(async (path) => {
			events.push(`start ${path}`);
			if (path === "/tmp/one.md") await first;
			events.push(`done ${path}`);
		}, vi.fn());
		await settled();

		expect(events).toEqual(["start /tmp/one.md"]);
		releaseFirst();
		await settled();
		expect(events).toEqual([
			"start /tmp/one.md",
			"done /tmp/one.md",
			"start /tmp/two.md",
			"done /tmp/two.md",
		]);
	});

	it("reports a failure and still opens the next file", async () => {
		const opens = new FinderOpens();
		const opened: string[] = [];
		const report = vi.fn();
		opens.offer("/tmp/broken.md");
		opens.offer("/tmp/fine.md");

		opens.answerWith(async (path) => {
			if (path === "/tmp/broken.md") throw new Error("no such file");
			opened.push(path);
		}, report);
		await settled();

		expect(report).toHaveBeenCalledTimes(1);
		expect((report.mock.calls[0]?.[0] as Error).message).toBe("no such file");
		expect(opened).toEqual(["/tmp/fine.md"]);
	});

	it("refuses a second opener, because that would be a second rule", () => {
		const opens = new FinderOpens();
		opens.answerWith(async () => undefined, vi.fn());

		expect(() => {
			opens.answerWith(async () => undefined, vi.fn());
		}).toThrow(/already has something answering/);
	});
});

/** Let every chained promise the queue made run to its end. */
async function settled(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}
