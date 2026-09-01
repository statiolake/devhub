import { readFileSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import { spoolStdin, stdinSpoolPath } from "./stdin.js";

describe("what `devhub -` does with what is piped into it", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = makeScratchDir("cli-stdin");
	});

	afterEach(() => {
		removeScratchDir(scratch);
	});
	it("spools it to a file, byte for byte", async () => {
		const path = stdinSpoolPath(scratch);
		await spoolStdin(Readable.from([Buffer.from("foo\n")]), path);
		expect(readFileSync(path, "utf8")).toBe("foo\n");
	});

	/**
	 * Upstream decodes stdin through the terminal's encoding and re-encodes it,
	 * which turns anything that is not text into something that never was.
	 * Nothing here interprets the bytes, so what you piped is what you see.
	 */
	it("does not interpret the bytes it is given", async () => {
		const path = stdinSpoolPath(scratch);
		const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x80]);
		await spoolStdin(Readable.from([bytes]), path);
		expect(readFileSync(path).equals(bytes)).toBe(true);
	});

	/** Large input goes to disk as it arrives; it is never a string in memory. */
	it("takes input in as many chunks as it arrives in", async () => {
		const path = stdinSpoolPath(scratch);
		const chunk = Buffer.alloc(64 * 1024, 0x61);
		await spoolStdin(
			Readable.from([chunk, chunk, chunk], { objectMode: true }),
			path,
		);
		expect(statSync(path).size).toBe(chunk.length * 3);
	});

	/** Whatever was piped in is the user's, and the temp directory is not private. */
	it("leaves the spool readable by nobody else", async () => {
		const path = stdinSpoolPath(scratch);
		await spoolStdin(Readable.from([Buffer.from("secret")]), path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	/** A fresh name each time, so two pipes at once cannot become one file. */
	it("names a different file every run", () => {
		const names = new Set(
			Array.from({ length: 50 }, () => stdinSpoolPath(scratch)),
		);
		expect(names.size).toBe(50);
		for (const name of names) expect(name).toContain("devhub-stdin-");
	});

	/**
	 * The name is meant to be fresh. If it is not, something else is writing
	 * there, and appending this run's input to that is worse than failing.
	 */
	it("refuses to write over a file that is already there", async () => {
		const path = stdinSpoolPath(scratch);
		writeFileSync(path, "someone else's");
		await expect(
			spoolStdin(Readable.from([Buffer.from("mine")]), path),
		).rejects.toThrow(/EEXIST/);
		expect(readFileSync(path, "utf8")).toBe("someone else's");
	});
});
