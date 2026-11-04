import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
	callerOf,
	installQuitTrace,
	resetQuitTraceForTests,
} from "./quitTrace.js";

function fakeApp() {
	const calls: string[] = [];
	return {
		calls,
		quit() {
			calls.push("quit");
		},
		exit(code?: number) {
			calls.push(`exit ${String(code)}`);
		},
	};
}

afterEach(() => {
	resetQuitTraceForTests();
});

describe("installQuitTrace", () => {
	it("says who called app.quit() and app.exit(), then does it", () => {
		const app = fakeApp();
		const lines: string[] = [];
		installQuitTrace(app, new EventEmitter(), (line) => lines.push(line));
		function menuQuit() {
			app.quit();
		}
		menuQuit();
		app.exit(0);
		expect(app.calls).toEqual(["quit", "exit 0"]);
		expect(lines[0]).toMatch(
			/^\[devhub\] quit: app\.quit\(\) called from .*menuQuit/,
		);
		expect(lines[1]).toMatch(/^\[devhub\] quit: app\.exit\(0\) called from /);
	});

	it("does not quit on SIGHUP — the kernel's orphaned-group hangup — and says so", () => {
		const app = fakeApp();
		const signals = new EventEmitter();
		const lines: string[] = [];
		installQuitTrace(app, signals, (line) => lines.push(line));
		signals.emit("SIGHUP", "SIGHUP");
		expect(app.calls).toEqual([]);
		expect(lines.join("\n")).toMatch(/SIGHUP received — ignored/);
	});

	it("quits on SIGTERM and SIGINT, saying which", () => {
		const app = fakeApp();
		const signals = new EventEmitter();
		const lines: string[] = [];
		installQuitTrace(app, signals, (line) => lines.push(line));
		signals.emit("SIGTERM", "SIGTERM");
		expect(app.calls).toEqual(["quit"]);
		expect(lines[0]).toBe("[devhub] quit: SIGTERM received — quitting");
		signals.emit("SIGINT", "SIGINT");
		expect(app.calls).toEqual(["quit", "quit"]);
	});

	it("is installed once", () => {
		const app = fakeApp();
		const lines: string[] = [];
		installQuitTrace(app, new EventEmitter(), (line) => lines.push(line));
		installQuitTrace(app, new EventEmitter(), (line) => lines.push(line));
		app.quit();
		expect(lines).toHaveLength(1);
	});
});

describe("callerOf", () => {
	it("is the frames above the wrapper", () => {
		const stack =
			"Error\n    at app.quit (quitTrace.ts:1)\n    at perform (appController.ts:5)\n    at drain (appController.ts:9)";
		expect(callerOf(stack)).toBe(
			"perform (appController.ts:5) <- drain (appController.ts:9)",
		);
	});
	it("is 'unknown' with no stack", () => {
		expect(callerOf(undefined)).toBe("unknown");
	});
});
