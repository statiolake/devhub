import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import {
	ResolvedColorTheme,
	terminalPaletteOfTheme,
} from "../../model/colorTheme.js";
import {
	publishedThemeOf,
	type PublishedTheme,
} from "../../model/publishedTheme.js";
import { ThemePublication } from "./themePublication.js";
import { themeEnvironmentArgs } from "../terminal/tmux.js";

let root: string;
beforeEach(() => {
	root = makeScratchDir("theme-publication");
});
afterEach(() => {
	removeScratchDir(root);
});

function theme(name: string, type: "dark" | "light" = "dark"): PublishedTheme {
	const resolved = new ResolvedColorTheme({
		settingsId: name,
		label: name,
		type,
		colors: {},
	});
	return publishedThemeOf({
		theme: resolved,
		terminal: terminalPaletteOfTheme(resolved),
		temporary: false,
	});
}

describe("publishing the theme", () => {
	it("writes the first value before it returns, so the file is there before any shell", () => {
		const file = join(root, "state", "devhub", "theme.json");
		const publication = new ThemePublication({ file, debounceMs: 10_000 });
		expect(publication.publish(theme("Nord"))).toBe(true);
		expect(existsSync(file)).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			name: "Nord",
		});
		publication.dispose();
	});

	it("tells the environment at once, and the file and sinks once, after a pause", async () => {
		const file = join(root, "theme.json");
		const told: string[] = [];
		const publication = new ThemePublication({ file, debounceMs: 5 });
		publication.addSink("test", (published) => {
			told.push(published.name);
			return Promise.resolve();
		});
		publication.publish(theme("A"));
		publication.publish(theme("B", "light"));
		expect(publication.environmentFor("local")).toMatchObject({
			DEVHUB_THEME: "B",
			DEVHUB_THEME_KIND: "light",
			DEVHUB_THEME_FILE: file,
		});
		expect(publication.environmentFor("ssh:box")).not.toHaveProperty(
			"DEVHUB_THEME_FILE",
		);
		// The same value again is nothing to deliver.
		expect(publication.publish(theme("B", "light"))).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 30));
		await publication.flush();
		expect(told).toEqual(["B"]);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ name: "B" });
	});

	it("goes on telling the others when one sink fails", async () => {
		const failures: string[] = [];
		const told: string[] = [];
		const publication = new ThemePublication({
			file: join(root, "theme.json"),
			debounceMs: 0,
			onFailure: (what) => failures.push(what),
		});
		publication.addSink("broken", () => Promise.reject(new Error("no")));
		publication.addSink("fine", (published) => {
			told.push(published.name);
			return Promise.resolve();
		});
		publication.publish(theme("Nord"));
		await publication.flush();
		expect(failures).toEqual(["broken"]);
		expect(told).toEqual(["Nord"]);
	});

	it("is nothing before there is a value", () => {
		const publication = new ThemePublication({ file: join(root, "t.json") });
		expect(publication.environmentFor("local")).toEqual({});
		expect(existsSync(join(root, "t.json"))).toBe(false);
	});
});

describe("tmux's global environment", () => {
	it("is one client queue of set-environment -g, a trailing ; escaped", () => {
		expect(
			themeEnvironmentArgs({ DEVHUB_THEME_KIND: "dark", DEVHUB_THEME: "Odd;" }),
		).toEqual([
			"set-environment",
			"-g",
			"DEVHUB_THEME",
			String.raw`Odd\;`,
			";",
			"set-environment",
			"-g",
			"DEVHUB_THEME_KIND",
			"dark",
		]);
		expect(themeEnvironmentArgs({})).toEqual([]);
	});
});
