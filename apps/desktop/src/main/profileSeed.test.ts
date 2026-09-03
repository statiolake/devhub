import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, profileLocations } from "../model/profile.js";
import { makeScratchDir, removeScratchDir } from "../model/testScratch.js";
import { seedProfileSettings } from "./profileSeed.js";

describe("a new profile's first settings", () => {
	let home: string;

	const production = () => profileLocations(DEFAULT_PROFILE, home, {});
	const dev = () => profileLocations("dev", home, {});

	function writeProduction(contents: string): string {
		const directory = production().configDirectory;
		mkdirSync(directory, { recursive: true });
		const file = join(directory, "settings.local.toml");
		writeFileSync(file, contents);
		return file;
	}

	beforeEach(() => {
		home = makeScratchDir("profile-seed");
	});

	afterEach(() => {
		removeScratchDir(home);
	});

	it("copies the production local settings on a first launch", () => {
		writeProduction('[runtimes]\nshell = "/bin/zsh"\n');
		const outcome = seedProfileSettings(dev(), production());
		expect(outcome.kind).toBe("copied");
		expect(
			readFileSync(join(dev().configDirectory, "settings.local.toml"), "utf8"),
		).toBe('[runtimes]\nshell = "/bin/zsh"\n');
	});

	/** A copy, so that the two profiles can drift — which is the point of one. */
	it("copies rather than links, so a later edit reaches one profile only", () => {
		const source = writeProduction("first\n");
		seedProfileSettings(dev(), production());
		writeFileSync(source, "second\n");
		expect(
			readFileSync(join(dev().configDirectory, "settings.local.toml"), "utf8"),
		).toBe("first\n");
	});

	it("leaves settings the profile already has alone", () => {
		writeProduction("production\n");
		mkdirSync(dev().configDirectory, { recursive: true });
		writeFileSync(join(dev().configDirectory, "settings.local.toml"), "mine\n");
		expect(seedProfileSettings(dev(), production()).kind).toBe(
			"already-configured",
		);
		expect(
			readFileSync(join(dev().configDirectory, "settings.local.toml"), "utf8"),
		).toBe("mine\n");
	});

	it("does nothing when there is no production configuration to copy", () => {
		expect(seedProfileSettings(dev(), production()).kind).toBe(
			"nothing-to-copy",
		);
	});

	it("never touches the default profile's own directory", () => {
		writeProduction("production\n");
		expect(seedProfileSettings(production(), production()).kind).toBe(
			"default-profile",
		);
	});
});
