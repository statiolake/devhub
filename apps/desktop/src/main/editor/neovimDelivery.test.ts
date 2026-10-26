/**
 * The Neovims this DevHub carries, read out of a bundle directory laid out
 * as `scripts/build_nvim.py` writes it: the statement read, each tarball
 * checked against it, and every way a bundle can be missing said in words
 * that name what to do.
 */

import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BundledNeovimDelivery,
	parseNeovimStatement,
} from "./neovimDelivery.js";
import { makeScratchDir } from "../../model/testScratch.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function bundle(bytes: Uint8Array, sha256?: string): string {
	const directory = makeScratchDir("nvim-bundle");
	directories.push(directory);
	writeFileSync(join(directory, "nvim-v0.12.6-linux-x64.tar.gz"), bytes);
	writeFileSync(
		join(directory, "nvim.json"),
		JSON.stringify({
			version: "v0.12.6",
			source:
				"https://github.com/statiolake/neovim-binaries/releases/tag/v0.12.6",
			targets: {
				"linux-x64": {
					file: "nvim-v0.12.6-linux-x64.tar.gz",
					sha256: sha256 ?? createHash("sha256").update(bytes).digest("hex"),
					topLevelDirectory: "nvim-linux-x86_64",
					glibc: "2.14",
				},
			},
		}),
	);
	return directory;
}

describe("the Neovims a bundle carries", () => {
	it("reads a target's tarball and what it needs", async () => {
		const bytes = Buffer.from("a tarball");
		const delivery = new BundledNeovimDelivery({
			directory: bundle(bytes),
			packaged: true,
		});
		const tarball = await delivery.tarball("linux-x64");
		expect(Buffer.from(tarball.bytes).toString()).toBe("a tarball");
		expect(tarball).toMatchObject({
			version: "v0.12.6",
			topLevelDirectory: "nvim-linux-x86_64",
			glibc: "2.14",
		});
	});

	it("refuses bytes that are not what the statement says", async () => {
		const delivery = new BundledNeovimDelivery({
			directory: bundle(Buffer.from("x"), "0".repeat(64)),
			packaged: true,
		});
		await expect(delivery.tarball("linux-x64")).rejects.toThrow(
			/hashes to .* not the 0{64}/u,
		);
	});

	it("says a target it does not carry, and a bundle that is not there, with what to do", async () => {
		const partial = new BundledNeovimDelivery({
			directory: bundle(Buffer.from("x")),
			packaged: false,
		});
		await expect(partial.tarball("linux-arm64")).rejects.toThrow(
			/no Neovim for linux-arm64\. Fetch it in this checkout with scripts\/build_nvim\.py/u,
		);
		const none = new BundledNeovimDelivery({
			directory: "/nonexistent/nvim",
			packaged: true,
		});
		expect(await none.statement()).toMatch(
			/carries no Neovim for Linux .* packaged without it/u,
		);
	});

	it("parses only a statement with every field", () => {
		expect(parseNeovimStatement("{")).toBeUndefined();
		expect(
			parseNeovimStatement(
				JSON.stringify({
					version: "v1",
					targets: { "linux-x64": { file: "f", sha256: "s" } },
				}),
			),
		).toBeUndefined();
		expect(
			parseNeovimStatement(JSON.stringify({ version: "v1", targets: {} })),
		).toEqual({ version: "v1", targets: {} });
	});
});
