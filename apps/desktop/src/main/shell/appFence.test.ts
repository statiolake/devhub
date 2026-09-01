import { describe, expect, it } from "vitest";
import {
	droppedProcessSettings,
	fenceMember,
	fenceProperty,
} from "./appFence.js";

/**
 * A stand-in for `electron.nativeTheme`, which only exists inside Electron.
 *
 * What matters is that it behaves like the real one in the two ways the fence
 * depends on: `themeSource` is a configurable accessor, and what it reports is
 * whatever was last written to it. A class puts the accessor on the prototype
 * rather than the instance — the real one on Electron 42 is an own property —
 * so this also exercises the chain walk in `describe`.
 */
function nativeThemeLike(initial: string): {
	themeSource: string;
	written: () => string;
} {
	let value = initial;
	class NativeThemeLike {
		get themeSource(): string {
			return value;
		}
		set themeSource(next: string) {
			value = next;
		}
		written(): string {
			return value;
		}
	}
	return new NativeThemeLike();
}

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

	it("finds a member the object inherits", () => {
		// Electron's own objects put these on the instance today, but they are
		// native EventEmitter subclasses and a bump may move one to a prototype.
		// A fence that only looked at own properties would call that member
		// missing and crash DevHub at startup over a change that broke nothing.
		const base = { setProxy: () => "real" };
		const app = Object.create(base) as { setProxy: () => unknown };
		fenceMember(app, "setProxy", () => "refused", "app.setProxy");
		expect(app.setProxy()).toBe("refused");
		expect(base.setProxy()).toBe("real");
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

describe("the fence around the process's idea of the OS colour scheme", () => {
	it("keeps the value DevHub set, whatever the workbench assigns", () => {
		// The bug this closes: `window.systemColorTheme: "auto"` with a dark
		// workbench made VS Code write 'dark' here, and from then on every part
		// of DevHub that asked what the OS was set to was told 'dark' under a
		// light OS — including `window.autoDetectColorScheme`, which then put a
		// dark theme back every time the person chose a light one.
		const nativeTheme = nativeThemeLike("system");
		fenceProperty(nativeTheme, "themeSource", "nativeTheme.themeSource");
		nativeTheme.themeSource = "dark";
		expect(nativeTheme.themeSource).toBe("system");
		expect(nativeTheme.written()).toBe("system");
	});

	it("reports the truth to whoever reads it back", () => {
		// Upstream logs `themeSource` after writing it. A fence that answered
		// with the value it refused would be a lie in the one place someone
		// goes looking when the colours are wrong.
		const nativeTheme = nativeThemeLike("system");
		fenceProperty(nativeTheme, "themeSource", "nativeTheme.themeSource");
		nativeTheme.themeSource = "light";
		expect(nativeTheme.themeSource).toBe("system");
	});

	it("remembers that it refused", () => {
		// A name of its own: the refusals are the process's one running list,
		// and the tests above have already written to it under the real name.
		const nativeTheme = nativeThemeLike("system");
		fenceProperty(nativeTheme, "themeSource", "counted.themeSource");
		nativeTheme.themeSource = "dark";
		nativeTheme.themeSource = "light";
		expect(
			droppedProcessSettings().filter(
				(call) => call.member === "counted.themeSource",
			),
		).toHaveLength(2);
	});

	it("refuses to pretend it fenced a property that is not there", () => {
		expect(() =>
			fenceProperty({}, "themeSource", "nativeTheme.themeSource"),
		).toThrow(/no such member/u);
	});

	it("refuses a property that is a plain value rather than an accessor", () => {
		// If a bump turns the accessor into a data property, reads would stop
		// passing through and the fence would freeze a stale value instead.
		expect(() =>
			fenceProperty(
				{ themeSource: "system" },
				"themeSource",
				"nativeTheme.themeSource",
			),
		).toThrow(/not an accessor/u);
	});
});
