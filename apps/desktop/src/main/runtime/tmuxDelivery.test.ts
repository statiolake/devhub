/**
 * Getting the tmux tarball here, so it can be handed to a host that cannot.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ReleaseTmuxDelivery,
	tmuxDownloadUrl,
	tmuxInstallDirectory,
	tmuxTarballName,
	tmuxTopLevelDirectory,
} from "./tmuxDelivery.js";

const TEMPLATE =
	"https://example.com/releases/download/tmux-${tmuxVersion}/" +
	"devhub-tmux-${os}-${arch}-${tmuxVersion}.tar.gz";

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("where a platform's tmux comes from", () => {
	// The three names are DevHub's own. `${version}` and `${commit}` mean VS
	// Code's version and commit in `serverDownloadUrlTemplate`, so reusing
	// either here would give one word two meanings in one `product.json`.
	it("substitutes the three names the template takes and no others", () => {
		expect(tmuxDownloadUrl(TEMPLATE, "linux-arm64", "3.7c")).toBe(
			"https://example.com/releases/download/tmux-3.7c/" +
				"devhub-tmux-linux-arm64-3.7c.tar.gz",
		);
	});

	// One statement of it, so the runtime reads it off the delivery rather than
	// knowing it: a second copy is a copy that will disagree with product.json.
	it("puts the version directories under the server's own data folder", () => {
		expect(tmuxInstallDirectory(".devhub-server")).toBe(".devhub-server/tmux");
	});

	it("names the tarball and its single directory the way the build does", () => {
		expect(tmuxTarballName("linux-x64", "3.7c")).toBe(
			"devhub-tmux-linux-x64-3.7c.tar.gz",
		);
		expect(tmuxTopLevelDirectory("linux-x64")).toBe("devhub-tmux-linux-x64");
	});
});

describe("fetching one", () => {
	let cache: string;
	let served: Uint8Array;
	let requests: string[];

	beforeEach(async () => {
		cache = await mkdtemp("/tmp/devhub-tmux-cache-");
		served = new Uint8Array([1, 2, 3, 4]);
		requests = [];
	});
	afterEach(async () => {
		await rm(cache, { recursive: true, force: true });
	});

	function delivery(sha256: Readonly<Record<string, string>> = {}) {
		return new ReleaseTmuxDelivery({
			version: "3.7c",
			directory: ".devhub-server/tmux",
			urlTemplate: TEMPLATE,
			sha256,
			cacheDirectory: cache,
			fetchBytes: (url) => {
				requests.push(url);
				return Promise.resolve(served);
			},
		});
	}

	it("downloads once and reads the cache afterwards", async () => {
		const first = await delivery().tarball("linux-x64");
		expect(first.bytes).toEqual(served);
		expect(requests).toHaveLength(1);
		// A second DevHub start, a second host, the same platform: the bytes are
		// already on this Mac and the release is not asked again.
		const again = await delivery().tarball("linux-x64");
		expect(again.bytes).toEqual(served);
		expect(requests).toHaveLength(1);
		expect(
			new Uint8Array(
				await readFile(join(cache, tmuxTarballName("linux-x64", "3.7c"))),
			),
		).toEqual(served);
	});

	it("hands out the digest it checked, so a caller can say it checked one", async () => {
		const pin = sha256Of(served);
		const tarball = await delivery({ "linux-x64": pin }).tarball("linux-x64");
		expect(tarball.verifiedSha256).toBe(pin);
	});

	// The pin is the point: bytes that are not the ones this build was made
	// against are not unpacked onto somebody's machine on the strength of the
	// URL they came from.
	it("refuses bytes that are not what the build is pinned to", async () => {
		await expect(
			delivery({ "linux-x64": "0".repeat(64) }).tarball("linux-x64"),
		).rejects.toThrow(/pinned to/u);
		// And leaves nothing behind for the next start to read as whole.
		await expect(
			readFile(join(cache, tmuxTarballName("linux-x64", "3.7c"))),
		).rejects.toThrow();
	});

	it("throws away a cache entry that no longer matches the pin", async () => {
		await writeFile(
			join(cache, tmuxTarballName("linux-x64", "3.7c")),
			new Uint8Array([9, 9, 9]),
		);
		const tarball = await delivery({ "linux-x64": sha256Of(served) }).tarball(
			"linux-x64",
		);
		expect(tarball.bytes).toEqual(served);
		expect(requests).toHaveLength(1);
	});

	// Two hosts of the same platform coming up together are one download, not
	// two that race onto the same cache file.
	it("downloads once for however many hosts ask at once", async () => {
		const one = delivery();
		const [left, right] = await Promise.all([
			one.tarball("linux-x64"),
			one.tarball("linux-x64"),
		]);
		expect(left.bytes).toEqual(right.bytes);
		expect(requests).toHaveLength(1);
	});
});
