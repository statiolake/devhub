import { describe, expect, it } from "vitest";
import { AppearanceMode } from "./appearanceMode.js";

/** The writer `installAppFence` hands over, and a record of what it was told. */
function themeSourceWriter(): {
	write: (value: unknown) => void;
	written: string[];
} {
	const written: string[] = [];
	return {
		write: (value) => {
			written.push(String(value));
		},
		written,
	};
}

describe("the appearance DevHub runs in", () => {
	it("starts by reporting the OS, before any config has been read", () => {
		// `auto` is the default, and until the config is read it is also the only
		// honest answer: DevHub has not been told to overrule anything yet.
		const mode = new AppearanceMode();
		const writer = themeSourceWriter();
		mode.own(writer.write);
		expect(writer.written).toEqual(["system"]);
		expect(mode.current()).toBe("auto");
	});

	it("maps each appearance onto what Electron understands", () => {
		const mode = new AppearanceMode();
		const writer = themeSourceWriter();
		mode.own(writer.write);
		mode.apply("dark");
		mode.apply("light");
		mode.apply("auto");
		// 'system' is the value that makes Electron report the real OS, so it is
		// what `auto` has to mean — anything else would pin the appearance.
		expect(writer.written).toEqual(["system", "dark", "light", "system"]);
	});

	it("writes on every change, so a saved setting needs no restart", () => {
		const mode = new AppearanceMode();
		const writer = themeSourceWriter();
		mode.own(writer.write);
		mode.apply("dark");
		expect(writer.written).toEqual(["system", "dark"]);
		expect(mode.current()).toBe("dark");
	});

	it("applies the config it was given the moment it takes ownership", () => {
		// Ordering insurance. In the app the fence is installed before the config
		// is read, but nothing in the types says so, and an appearance that were
		// silently dropped because it arrived early would be invisible.
		const mode = new AppearanceMode();
		mode.apply("dark");
		const writer = themeSourceWriter();
		mode.own(writer.write);
		expect(writer.written).toEqual(["dark"]);
	});

	it("refuses an appearance it has no answer for", () => {
		// The config loader rejects anything but the three, so this can only mean
		// the two lists have drifted apart. Guessing would put DevHub in an
		// appearance nobody asked for and say nothing.
		const mode = new AppearanceMode();
		mode.own(themeSourceWriter().write);
		expect(() => mode.apply("midnight")).toThrow(/no appearance called/u);
	});

	it("refuses a second owner", () => {
		// Two owners is the thing the fence exists to prevent, one level up.
		const mode = new AppearanceMode();
		mode.own(themeSourceWriter().write);
		expect(() => mode.own(themeSourceWriter().write)).toThrow(
			/already has an owner/u,
		);
	});
});
