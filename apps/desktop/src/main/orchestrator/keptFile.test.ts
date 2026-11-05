import { describe, expect, it } from "vitest";
import { KEPT_FILE_VERSION, KeptFile, type KeptFileIo } from "./keptFile.js";

function memory(initial?: string): KeptFileIo & {
	files: Map<string, string>;
} {
	const files = new Map<string, string>();
	if (initial !== undefined) files.set("/k.json", initial);
	return {
		files,
		exists: (path) => files.has(path),
		read: (path) => files.get(path)!,
		write: (path, text) => {
			files.set(path, text);
		},
		moveAside: (path, to) => {
			files.set(to, files.get(path)!);
			files.delete(path);
		},
	};
}

describe("the keepings on disk", () => {
	it("round-trips, by agent id", () => {
		const io = memory();
		const file = new KeptFile("/k.json", io);
		expect(file.load().size).toBe(0);
		const kept = {
			note: "続ける",
			at: 5,
			facts: "outside_population status=working",
		};
		file.save(new Map([["a1", kept]]));
		expect(JSON.parse(io.files.get("/k.json")!)).toEqual({
			version: KEPT_FILE_VERSION,
			kept: { a1: kept },
		});
		expect([...new KeptFile("/k.json", io).load()]).toEqual([["a1", kept]]);
	});

	it("moves a file that does not read aside, says so, and keeps nothing", () => {
		for (const text of [
			"{",
			'{"version":9,"kept":{}}',
			'{"version":1,"kept":{"a":{}}}',
		]) {
			const io = memory(text);
			const file = new KeptFile("/k.json", io);
			expect(file.load().size).toBe(0);
			expect(file.refused).toMatch(/moved to \/k\.json\.corrupt/u);
			expect(io.files.get("/k.json.corrupt")).toBe(text);
		}
	});
});
