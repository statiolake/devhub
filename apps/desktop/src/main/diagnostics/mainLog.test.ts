import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAIN_LOG_FILE,
	RotatingLog,
	installMainLog,
	logLine,
	mainLogPath,
} from "./mainLog.js";

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "devhub-main-log-"));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

/** A console that remembers what reached it, as the real one prints. */
function fakeConsole() {
	const printed: string[] = [];
	const record =
		(level: string) =>
		(...args: unknown[]) => {
			printed.push(`${level} ${args.map(String).join(" ")}`);
		};
	const target = {
		log: record("log"),
		info: record("info"),
		warn: record("warn"),
		error: record("error"),
		debug: record("debug"),
	} as unknown as Console;
	return { printed, target };
}

describe("main's log file", () => {
	it("lives in the log folder Settings opens", () => {
		expect(mainLogPath("/u/DevHub")).toBe(`/u/DevHub/logs/${MAIN_LOG_FILE}`);
		expect(MAIN_LOG_FILE).toBe("devhub-main.log");
	});

	it("gets every console line, timestamped and levelled, and the console still gets it", () => {
		const { printed, target } = fakeConsole();
		const file = join(directory, "logs", MAIN_LOG_FILE);
		const when = new Date("2026-10-25T09:41:07.123Z");
		const log = installMainLog(file, { target, now: () => when });
		target.log("[devhub] workbench '%s' awake", "/a");
		target.info("info", { n: 1 });
		target.warn("careful");
		target.error(new Error("broke"));
		target.debug("detail");
		log.uninstall();
		target.log("after");

		expect(printed).toEqual([
			"log [devhub] workbench '%s' awake /a",
			"info info [object Object]",
			"warn careful",
			"error Error: broke",
			"debug detail",
			"log after",
		]);
		const lines = readFileSync(file, "utf8").split("\n");
		expect(lines[0]).toBe(
			"2026-10-25T09:41:07.123Z INFO  [devhub] workbench '/a' awake",
		);
		expect(lines[1]).toBe("2026-10-25T09:41:07.123Z INFO  info { n: 1 }");
		expect(lines[2]).toBe("2026-10-25T09:41:07.123Z WARN  careful");
		expect(lines[3]).toBe("2026-10-25T09:41:07.123Z ERROR Error: broke");
		// The stack follows its line, as the console prints it.
		expect(lines[4]).toMatch(/^ {4}at /);
		expect(readFileSync(file, "utf8")).toContain("DEBUG detail");
		expect(readFileSync(file, "utf8")).not.toContain("after");
	});

	it("appends to what an earlier run wrote", () => {
		const file = join(directory, MAIN_LOG_FILE);
		writeFileSync(file, "earlier\n");
		const log = new RotatingLog(file);
		log.write("now\n");
		log.close();
		expect(readFileSync(file, "utf8")).toBe("earlier\nnow\n");
	});
});

describe("rotation", () => {
	it("moves the file aside past the limit, keeping one old one", () => {
		const file = join(directory, MAIN_LOG_FILE);
		const log = new RotatingLog(file, 20);
		log.write("0123456789\n"); // 11
		log.write("abcdefghi\n"); // 21 > 20: rotated first
		log.write("ABCDEFGHI\n"); // 20: fits
		log.write("second\n"); // past again: the first .1 is replaced
		log.close();
		expect(readFileSync(`${file}.1`, "utf8")).toBe("abcdefghi\nABCDEFGHI\n");
		expect(readFileSync(file, "utf8")).toBe("second\n");
	});

	it("starts afresh on a file an earlier run left past the limit", () => {
		const file = join(directory, MAIN_LOG_FILE);
		writeFileSync(file, "x".repeat(30));
		const log = new RotatingLog(file, 20);
		log.write("new\n");
		log.close();
		expect(statSync(`${file}.1`).size).toBe(30);
		expect(readFileSync(file, "utf8")).toBe("new\n");
	});

	it("carries on when the file was deleted from under it", () => {
		const file = join(directory, MAIN_LOG_FILE);
		const log = new RotatingLog(file, 10);
		log.write("12345\n");
		rmSync(file);
		expect(log.write("678901\n")).toBe(true);
		log.close();
		expect(readFileSync(file, "utf8")).toBe("678901\n");
	});

	it("says once, on the real console, that a file cannot be written, and keeps the console working", () => {
		const { printed, target } = fakeConsole();
		// A directory where the file should be.
		const log = installMainLog(directory, { target });
		target.log("one");
		target.log("two");
		log.uninstall();
		expect(
			printed.filter((line) => line.includes("cannot be written")),
		).toHaveLength(1);
		expect(printed).toContain("log one");
		expect(printed).toContain("log two");
	});
});

describe("a line", () => {
	it("formats like the console, one line per call", () => {
		expect(logLine("warn", new Date(0), ["%d workbenches", 3, "awake"])).toBe(
			"1970-01-01T00:00:00.000Z WARN  3 workbenches awake\n",
		);
	});
});
