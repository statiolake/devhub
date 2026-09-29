import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecRequest, ExecResult } from "../../runtime/runtime.js";
import {
	fileSelection,
	resolvePathCandidates,
	type PathMachine,
} from "./pathLinks.js";

/** A machine whose programs run here, for real, with its home where the test says. */
function machine(
	home: string,
): PathMachine & { readonly exec: ReturnType<typeof vi.fn> } {
	return {
		where: " on test-host",
		home: () => Promise.resolve(home),
		exec: vi.fn((request: ExecRequest): Promise<ExecResult> => {
			const [file, ...args] = request.argv;
			const run = spawnSync(file!, args);
			return Promise.resolve({
				code: run.status,
				signal: run.signal,
				stdout: run.stdout,
				stderr: run.stderr,
			});
		}),
	};
}

describe("resolvePathCandidates", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "devhub-path-links-"));
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "a.ts"), "");
		writeFileSync(join(root, "notes with space.md"), "");
		symlinkSync(join(root, "src", "a.ts"), join(root, "link.ts"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("answers each path with its file, absolute, or null", async () => {
		const answers = await resolvePathCandidates(machine(root), root, [
			`${root}/src/a.ts`,
			"src/a.ts",
			"./src/../src/a.ts",
			"~/src/a.ts",
			"src/missing.ts",
			"src",
			"link.ts",
			"notes with space.md",
		]);
		expect(answers).toEqual([
			`${root}/src/a.ts`,
			`${root}/src/a.ts`,
			`${root}/src/a.ts`,
			`${root}/src/a.ts`,
			null,
			// A folder is not a file to open.
			null,
			`${root}/link.ts`,
			`${root}/notes with space.md`,
		]);
	});

	it("asks the machine once for a batch, and in pieces for a long one", async () => {
		const host = machine(root);
		await resolvePathCandidates(host, root, ["src/a.ts", "b.ts"]);
		expect(host.exec).toHaveBeenCalledTimes(1);
		const many = Array.from({ length: 600 }, (_, index) => `f${index}.ts`);
		const answers = await resolvePathCandidates(host, root, many);
		expect(answers).toHaveLength(600);
		expect(answers.every((answer) => answer === null)).toBe(true);
		expect(host.exec).toHaveBeenCalledTimes(1 + 3);
	});

	it("refuses a relative path when the conversation named no directory", async () => {
		await expect(
			resolvePathCandidates(machine(root), undefined, ["src/a.ts"]),
		).rejects.toThrow(/relative/u);
	});

	it("says, in the machine's words, when the machine could not answer", async () => {
		const host = machine(root);
		host.exec.mockResolvedValueOnce({
			code: 127,
			signal: null,
			stdout: Buffer.from(""),
			stderr: Buffer.from("sh: not found"),
		});
		await expect(
			resolvePathCandidates(host, root, ["src/a.ts"]),
		).rejects.toThrow(/on test-host.*sh: not found/u);
	});
});

describe("fileSelection", () => {
	it("puts the caret at a line and column", () => {
		expect(fileSelection({ kind: "line", line: 12, column: 5 })).toEqual({
			line: 12,
			column: 5,
		});
	});

	it("selects a range of lines whole, the last to its end", () => {
		expect(fileSelection({ kind: "lines", from: 12, to: 20 })).toEqual({
			line: 12,
			column: 1,
			end: { line: 20, column: Number.MAX_SAFE_INTEGER },
		});
	});

	it("leaves the caret alone when there is no range", () => {
		expect(fileSelection(undefined)).toBeUndefined();
	});

	it("refuses anything else", () => {
		expect(() => fileSelection({ kind: "line", line: 0, column: 1 })).toThrow();
		expect(() => fileSelection({ kind: "lines", from: 5, to: 2 })).toThrow();
		expect(() => fileSelection("12")).toThrow();
	});
});
