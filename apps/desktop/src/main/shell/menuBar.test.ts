import { describe, expect, it } from "vitest";
import { menuBarOptions } from "./menuBar.js";

describe("a window's menu bar", () => {
	it("is hidden on Linux until Alt shows it, the GTK bar following no theme of DevHub's", () => {
		expect(menuBarOptions("linux")).toEqual({ autoHideMenuBar: true });
	});

	it("is the system's on macOS, so the window sets nothing", () => {
		expect(menuBarOptions("darwin")).toEqual({});
	});
});
