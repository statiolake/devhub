/**
 * Where a new project goes, and the folders a clone is offered.
 *
 * One notion: `[projects] directory`, when set, is the new-project default and
 * leads the clone list. Unset, both are what the workspace sources imply.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config, WorkspaceSource } from "../../model/config.js";
import { defaultConfig } from "../../model/config.js";
import { cloneParentChoices, defaultProjectDirectory } from "./projects.js";

const source: WorkspaceSource = {
	type: "filesystem",
	id: "code",
	path: "/srv/code",
	min_depth: 1,
	max_depth: 1,
	kinds: ["directory"],
	include_hidden: false,
	exclude_names: [],
};

function configWith(
	directory: string | undefined,
	sources: readonly WorkspaceSource[] = [source],
): Config {
	return {
		...defaultConfig(),
		workspaceSources: [...sources],
		projects: { directory },
	};
}

describe("where a new project goes", () => {
	it("is the setting when it is set, over the first folder source", () => {
		expect(defaultProjectDirectory(configWith("/srv/new"))).toBe("/srv/new");
	});

	it("expands ~ in the setting, and does not keep a trailing slash", () => {
		expect(defaultProjectDirectory(configWith("~/dev/new/"))).toBe(
			join(homedir(), "dev", "new"),
		);
		expect(defaultProjectDirectory(configWith("~"))).toBe(homedir());
	});

	it("is the first folder source, then home, when the setting is unset", () => {
		expect(defaultProjectDirectory(configWith(undefined))).toBe("/srv/code");
		expect(defaultProjectDirectory(configWith(undefined, []))).toBe(homedir());
		expect(defaultProjectDirectory(undefined)).toBe(homedir());
	});
});

describe("the folders a clone is offered", () => {
	const derived = ["/srv/code", "/srv/work"];

	it("starts with the setting, followed by the derived parents", () => {
		expect(cloneParentChoices(configWith("/srv/new"), derived)).toEqual([
			"/srv/new",
			"/srv/code",
			"/srv/work",
		]);
	});

	it("names the setting once when a source already yields it", () => {
		expect(cloneParentChoices(configWith("/srv/work/"), derived)).toEqual([
			"/srv/work",
			"/srv/code",
		]);
	});

	it("is the setting alone when the sources imply nothing", () => {
		expect(cloneParentChoices(configWith("/srv/new"), [])).toEqual([
			"/srv/new",
		]);
	});

	it("is unchanged when the setting is unset: the derived parents, else the default", () => {
		expect(cloneParentChoices(configWith(undefined), derived)).toEqual(derived);
		expect(cloneParentChoices(configWith(undefined), [])).toEqual([
			"/srv/code",
		]);
		expect(cloneParentChoices(undefined, [])).toEqual([homedir()]);
	});
});
