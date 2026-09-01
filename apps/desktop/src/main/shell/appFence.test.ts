import { describe, expect, it } from "vitest";
import { droppedProcessSettings, fenceMember } from "./appFence.js";

describe("the fence around DevHub's process settings", () => {
	it("answers instead of Electron, and never runs the real thing", () => {
		let real = 0;
		const app = {
			setProxy: () => {
				real += 1;
				return Promise.resolve();
			},
		};
		fenceMember(app, "setProxy", () => "refused", "app.setProxy");
		expect(app.setProxy()).toBe("refused");
		expect(real).toBe(0);
	});

	it("remembers what it refused, so a fence is not mistaken for a dead feature", () => {
		const app = { setBadgeCount: () => true };
		fenceMember(app, "setBadgeCount", () => false, "app.setBadgeCount");
		app.setBadgeCount();
		app.setBadgeCount();
		expect(
			droppedProcessSettings().filter(
				(call) => call.member === "app.setBadgeCount",
			),
		).toHaveLength(2);
	});

	it("refuses to pretend it fenced a member that is not there", () => {
		// The hole this closes: a VS Code or Electron bump renames the method,
		// the fence installs cleanly over nothing, and the call it was written
		// for reaches the real application again with nobody the wiser.
		expect(() =>
			fenceMember({}, "setJumpList", () => undefined, "app.setJumpList"),
		).toThrow(/no such member/u);
	});

	it("refuses a member it cannot replace", () => {
		const app = {};
		Object.defineProperty(app, "setPath", {
			value: () => undefined,
			writable: false,
			configurable: false,
		});
		expect(() =>
			fenceMember(app, "setPath", () => undefined, "app.setPath"),
		).toThrow(/read-only/u);
	});
});
