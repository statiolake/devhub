import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecRequest, ExecResult } from "../../runtime/runtime.js";
import {
	MAX_EMBED_BYTES,
	embedPath,
	embedSignature,
	embedType,
	readEmbedFile,
} from "./embedFiles.js";
import type { PathMachine } from "./pathLinks.js";

/** A machine whose programs run here, for real, keeping to the output limit. */
function machine(): PathMachine & { readonly exec: ReturnType<typeof vi.fn> } {
	return {
		where: " on test-host",
		home: () => Promise.resolve(tmpdir()),
		exec: vi.fn((request: ExecRequest): Promise<ExecResult> => {
			const [file, ...args] = request.argv;
			const run = spawnSync(file!, args, { maxBuffer: 64 * 1024 * 1024 });
			return Promise.resolve({
				code: run.status,
				signal: run.signal,
				stdout: run.stdout.subarray(0, request.limits?.stdoutBytes),
				stderr: run.stderr,
			});
		}),
	};
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);

describe("a file an answer embeds", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "devhub-embed-"));
		mkdirSync(join(root, "out"));
		writeFileSync(join(root, "out", "plot.png"), PNG);
		writeFileSync(join(root, "deck.md"), "---\nmarp: true\n---\n# A\n");
		writeFileSync(join(root, "secret.txt"), "key");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("is read as its bytes, binary and all, with its type", async () => {
		const file = await readEmbedFile(machine(), join(root, "out", "plot.png"));
		expect(file?.mediaType).toBe("image/png");
		expect(Buffer.from(file!.bytes)).toEqual(PNG);
		const deck = await readEmbedFile(machine(), join(root, "deck.md"));
		expect(new TextDecoder().decode(deck!.bytes)).toBe(
			"---\nmarp: true\n---\n# A\n",
		);
		expect(deck!.signature).toBe(
			await embedSignature(machine(), join(root, "deck.md")),
		);
	});

	it("is null when it is not there, or not a file", async () => {
		expect(await readEmbedFile(machine(), join(root, "gone.png"))).toBeNull();
		expect(await embedSignature(machine(), join(root, "gone.md"))).toBeNull();
		mkdirSync(join(root, "dir.md"));
		expect(await readEmbedFile(machine(), join(root, "dir.md"))).toBeNull();
	});

	it("has a signature that changes when the file does", async () => {
		const path = join(root, "deck.md");
		const before = await embedSignature(machine(), path);
		writeFileSync(path, "---\nmarp: true\n---\n# B\n");
		// The same size, the same second: the checksum still tells them apart.
		utimesSync(path, new Date(2026, 0, 1), new Date(2026, 0, 1));
		const after = await embedSignature(machine(), path);
		expect(after).not.toBe(before);
		expect(after).toMatch(/^\d+ \d+ \d+$/);
	});

	it("reads only the kinds an embed draws, by absolute path", async () => {
		await expect(
			readEmbedFile(machine(), join(root, "secret.txt")),
		).rejects.toThrow(/not a kind of file DevHub embeds/);
		await expect(readEmbedFile(machine(), "out/plot.png")).rejects.toThrow(
			/not a file to embed/,
		);
		expect(() => embedPath(`${root}/a\0.png`)).toThrow();
		expect(() => embedPath(42)).toThrow();
		expect(embedType("/a/chart.VL.json")).toBe("application/vnd.vegalite+json");
		expect(embedType("/a/.png")).toBeUndefined();
		expect(embedType("/a/report.pdf")).toBeUndefined();
	});

	it("refuses a file past the size it reads, without reading it", async () => {
		const path = join(root, "huge.png");
		writeFileSync(path, "");
		truncateSync(path, MAX_EMBED_BYTES + 1);
		const host = machine();
		await expect(readEmbedFile(host, path)).rejects.toThrow(
			/too large to embed/,
		);
		const [request] = host.exec.mock.calls[0]! as [ExecRequest];
		expect(request.limits?.stdoutBytes).toBeLessThanOrEqual(
			MAX_EMBED_BYTES + 256,
		);
	});
});
