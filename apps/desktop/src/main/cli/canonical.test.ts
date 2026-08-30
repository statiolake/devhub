import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import { canonicalise } from "./canonical.js";

describe("canonicalising a path the CLI was given", () => {
	let scratch: string;
	let real: string;

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
		const through = await canonicalise(join(real, "link", "src", "main.ts"));
		expect(through).toEqual({
			path: join(real, "project", "src", "main.ts"),
			exists: true,
			isDirectory: false,
		});
	});

	it("says a directory is a directory", async () => {
		const folder = await canonicalise(join(real, "link"));
		expect(folder.isDirectory).toBe(true);
		expect(folder.path).toBe(join(real, "project"));
	});

	it("resolves a file that does not exist yet through its real parent", async () => {
		const missing = await canonicalise(join(real, "link", "src", "new.ts"));
		expect(missing).toEqual({
			path: join(real, "project", "src", "new.ts"),
			exists: false,
			isDirectory: false,
		});
	});

	it("resolves a file whose parent does not exist either, as `code` does", async () => {
		const missing = await canonicalise(join(real, "link", "gone", "new.ts"));
		expect(missing).toEqual({
			path: join(real, "project", "gone", "new.ts"),
			exists: false,
			isDirectory: false,
		});
	});
});
