import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "./workspaces.js";

const scratchDirs: string[] = [];

function scratchFile(): string {
	// Under the repo, never the OS temp dir: a sandboxed run sees a different
	// $TMPDIR inside and outside, and these files must be the same ones.
	const dir = mkdtempSync(join(import.meta.dirname, "workspaces-test-"));
	scratchDirs.push(dir);
	return join(dir, "workspaces.json");
}

afterEach(() => {
	while (scratchDirs.length > 0) {
		rmSync(scratchDirs.pop()!, { recursive: true, force: true });
	}
});

describe("WorkspaceStore", () => {
	it("starts empty when nothing has been written yet", () => {
		expect(new WorkspaceStore(scratchFile()).all()).toEqual([]);
	});

	it("is idempotent by path and survives a reload", () => {
		const file = scratchFile();
		const store = new WorkspaceStore(file);
		const first = store.add("/projects/alpha");
		const again = store.add("/projects/alpha");
		store.add("/projects/beta");

		expect(again).toEqual(first);
		expect(new WorkspaceStore(file).all()).toEqual([
			{ id: "/projects/alpha", name: "alpha", path: "/projects/alpha" },
			{ id: "/projects/beta", name: "beta", path: "/projects/beta" },
		]);
	});

	it("removes by id and reports what is gone", () => {
		const file = scratchFile();
		const store = new WorkspaceStore(file);
		store.add("/projects/alpha");

		expect(store.remove("/projects/alpha")?.name).toBe("alpha");
		expect(store.remove("/projects/alpha")).toBeUndefined();
		expect(new WorkspaceStore(file).all()).toEqual([]);
	});

	it("does not hide an unreadable store behind an empty one", () => {
		const file = scratchFile();
		writeFileSync(file, "this is not JSON");

		expect(() => new WorkspaceStore(file)).toThrow();
	});

	it("writes the file the next run reads", () => {
		const file = scratchFile();
		new WorkspaceStore(file).add("/projects/alpha");

		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			workspaces: [
				{ id: "/projects/alpha", name: "alpha", path: "/projects/alpha" },
			],
		});
	});
});
