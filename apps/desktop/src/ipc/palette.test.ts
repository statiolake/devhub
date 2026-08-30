import { describe, expect, it } from "vitest";
import {
	isPaletteColor,
	paletteStyleSheet,
	paletteVariables,
	type ShellPalette,
} from "./palette.js";

const solarized: ShellPalette = {
	base: "light",
	surface: "#fdf6e3",
	chrome: "#eee8d5",
	canvas: "#eee8d5",
	ink: "#586e75",
};

describe("paletteVariables", () => {
	it("sets the anchors and nothing else, so tokens.css keeps the derivation", () => {
		const names = paletteVariables(solarized).map(([name]) => name);
		expect(names).toEqual([
			"color-scheme",
			"--canvas",
			"--chrome",
			"--surface",
			"--primary",
		]);
	});

	it("resolves color-scheme from the base theme", () => {
		const scheme = (base: ShellPalette["base"]) =>
			paletteVariables({ ...solarized, base }).find(
				(entry) => entry[0] === "color-scheme",
			)?.[1];
		expect(scheme("light")).toBe("light");
		expect(scheme("dark")).toBe("dark");
	});
});

describe("paletteStyleSheet", () => {
	it("is the same mapping the page applies, as a :root rule", () => {
		const sheet = paletteStyleSheet(solarized);
		for (const [name, value] of paletteVariables(solarized)) {
			expect(sheet).toContain(`${name}: ${value};`);
		}
		expect(sheet.startsWith(":root {")).toBe(true);
	});
});

describe("isPaletteColor", () => {
	it("accepts what a theme can legitimately produce", () => {
		for (const color of [
			"#fff",
			"#ffffff",
			"#ffffff80",
			"rgb(1, 2, 3)",
			"rgba(1, 2, 3, 0.5)",
		]) {
			expect(isPaletteColor(color), color).toBe(true);
		}
	});

	it("refuses anything that could end a declaration", () => {
		for (const color of [
			"red; background: url(http://example.invalid)",
			"} :root { --primary: red",
			"var(--primary)",
			"",
		]) {
			expect(isPaletteColor(color), color).toBe(false);
		}
	});
});
