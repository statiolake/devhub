import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import { canonicalise, type PathMachine } from "./canonical.js";
import { localRuntime } from "../runtime/registry.js";

describe("canonicalising a path the CLI was given", () => {
	let scratch: string;
	let real: string;
	const here: PathMachine = localRuntime();

	beforeAll(() => {
		scratch = makeScratchDir("cli-canonical");
		// The scratch root itself can sit under a symlink (/var -> /private/var
		// on macOS), so the expectations below are written against its realpath.
		real = realpathSync(scratch);
		mkdirSync(join(real, "project", "src"), { recursive: true });
		writeFileSync(join(real, "project", "src", "main.ts"), "");
		symlinkSync(join(real, "project"), join(real, "link"));
	});

	afterAll(() => {
		removeScratchDir(scratch);
	});

	it("resolves a symlinked spelling to the one the model stores", async () => {
		const through = await canonicalise(
			here,
			join(real, "link", "src", "main.ts"),
		);
		expect(through).toEqual({
			path: join(real, "project", "src", "main.ts"),
			exists: true,
			isDirectory: false,
		});
	});

	it("says a directory is a directory", async () => {
		const folder = await canonicalise(here, join(real, "link"));
		expect(folder.isDirectory).toBe(true);
		expect(folder.path).toBe(join(real, "project"));
	});

	it("resolves a file that does not exist yet through its real parent", async () => {
		const missing = await canonicalise(
			here,
			join(real, "link", "src", "new.ts"),
		);
		expect(missing).toEqual({
			path: join(real, "project", "src", "new.ts"),
			exists: false,
			isDirectory: false,
		});
	});

	it("resolves a file whose parent does not exist either, as `code` does", async () => {
		const missing = await canonicalise(
			here,
			join(real, "link", "gone", "new.ts"),
		);
		expect(missing).toEqual({
			path: join(real, "project", "gone", "new.ts"),
			exists: false,
			isDirectory: false,
		});
	});
});

/**
 * A host's path is resolved on the host.
 *
 * Doing it here would answer about this disk, and the two ways that goes wrong
 * are both silent: a refusal about a path that is perfectly fine over there,
 * or a *different* folder that happens to exist here under the same name. The
 * machine is a parameter precisely so this is a thing a test can watch.
 */
describe("canonicalising a path on another machine", () => {
	/** A filesystem that is not this one, and says so. */
	function elsewhere(
		tree: Readonly<Record<string, "file" | "directory">>,
		links: Readonly<Record<string, string>> = {},
	): PathMachine & { readonly asked: string[] } {
		const asked: string[] = [];
		// `/` is a directory on every machine there is, and the walk up ends
		// there; a fake without one would be testing a filesystem nobody has.
		const all = { "/": "directory", ...tree } as const;
		return {
			asked,
			stat: (path) => {
				asked.push(`stat ${path}`);
				return Promise.resolve(all[path as keyof typeof all] ?? "absent");
			},
			realpath: (path) => {
				asked.push(`realpath ${path}`);
				return Promise.resolve(links[path] ?? path);
			},
		};
	}

	it("asks that machine and never this one", async () => {
		const host = elsewhere(
			{ "/srv/link": "directory", "/srv/app": "directory" },
			{ "/srv/link": "/srv/app" },
		);

		const resolved = await canonicalise(host, "/srv/link");

		expect(resolved).toEqual({
			path: "/srv/app",
			exists: true,
			isDirectory: true,
		});
		expect(host.asked).toContain("realpath /srv/link");
	});

	/**
	 * The case that decides which disk answered: a path that exists here and
	 * not there must come back as not existing.
	 */
	it("reports a path that exists here but not there as absent", async () => {
		const host = elsewhere({ "/etc": "directory" });

		const resolved = await canonicalise(host, "/etc/hosts");

		expect(resolved.exists).toBe(false);
		expect(resolved.path).toBe("/etc/hosts");
	});

	it("resolves a missing tail through its deepest real ancestor over there", async () => {
		const host = elsewhere(
			{ "/srv/link": "directory", "/srv/app": "directory" },
			{ "/srv/link": "/srv/app" },
		);

		expect(await canonicalise(host, "/srv/link/gone/new.ts")).toEqual({
			path: "/srv/app/gone/new.ts",
			exists: false,
			isDirectory: false,
		});
	});
});
