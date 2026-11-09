/**
 * Getting a tool's tarball here — tmux's, bash's — so it can be handed to a
 * host that cannot.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_ROOT } from "../shell/appRoot.js";
import {
	neovimReleasePlatform,
	ReleaseToolDelivery,
	toolDownloadUrl,
	toolInstallDirectory,
	toolTarballName,
	toolTopLevelDirectory,
	toolVersionArgument,
	type HostTool,
} from "./toolDelivery.js";

const TEMPLATE =
	"https://example.com/releases/download/tmux-${tmuxVersion}/" +
	"devhub-tmux-${os}-${arch}-${tmuxVersion}.tar.gz";

const BASH_TEMPLATE =
	"https://example.com/releases/download/bash-${bashVersion}/" +
	"devhub-bash-${os}-${arch}-${bashVersion}.tar.gz";

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("where a platform's tmux comes from", () => {
	// The three names are DevHub's own. `${version}` and `${commit}` mean VS
	// Code's version and commit in `serverDownloadUrlTemplate`, so reusing
	// either here would give one word two meanings in one `product.json`.
	it("substitutes the three names the template takes and no others", () => {
		expect(toolDownloadUrl(TEMPLATE, "tmux", "linux-arm64", "3.7c")).toBe(
			"https://example.com/releases/download/tmux-3.7c/" +
				"devhub-tmux-linux-arm64-3.7c.tar.gz",
		);
	});

	// One statement of it, so the runtime reads it off the delivery rather than
	// knowing it: a second copy is a copy that will disagree with product.json.
	it("puts the version directories under the server's own data folder", () => {
		expect(toolInstallDirectory(".devhub-server", "tmux")).toBe(
			".devhub-server/tmux",
		);
		expect(toolInstallDirectory(".devhub-server", "bash")).toBe(
			".devhub-server/bash",
		);
	});

	it("names the tarball and its single directory the way the build does", () => {
		expect(toolTarballName("tmux", "linux-x64", "3.7c")).toBe(
			"devhub-tmux-linux-x64-3.7c.tar.gz",
		);
		expect(toolTopLevelDirectory("tmux", "linux-x64", "")).toBe(
			"devhub-tmux-linux-x64",
		);
	});
});

describe("where a platform's bash comes from", () => {
	// Each tool substitutes its own version name and no other tool's: a bash
	// template that said `${tmuxVersion}` would fetch a bash named after tmux.
	it("substitutes its own version name, not tmux's", () => {
		expect(toolDownloadUrl(BASH_TEMPLATE, "bash", "linux-x64", "5.3.20")).toBe(
			"https://example.com/releases/download/bash-5.3.20/" +
				"devhub-bash-linux-x64-5.3.20.tar.gz",
		);
		expect(
			toolDownloadUrl(BASH_TEMPLATE, "tmux", "linux-x64", "3.7c"),
		).toContain("${bashVersion}");
	});

	it("names the tarball and its single directory the way build_bash.py does", () => {
		expect(toolTarballName("bash", "linux-arm64", "5.3.20")).toBe(
			"devhub-bash-linux-arm64-5.3.20.tar.gz",
		);
		expect(toolTopLevelDirectory("bash", "linux-arm64", "")).toBe(
			"devhub-bash-linux-arm64",
		);
	});

	it("asks each binary for its version the way that binary answers", () => {
		expect(toolVersionArgument("tmux")).toBe("-V");
		expect(toolVersionArgument("bash")).toBe("--version");
	});
});

describe("where a platform's Neovim comes from", () => {
	const product = JSON.parse(
		readFileSync(join(APP_ROOT, "product.json"), "utf8"),
	) as Record<string, unknown>;
	const template = product.nvimDownloadUrlTemplate as string;

	// Neovim's own release archive, in Neovim's own spelling of the platform.
	it("is Neovim's release archive for that platform", () => {
		expect(toolDownloadUrl(template, "nvim", "linux-x64", "0.12.6")).toBe(
			"https://github.com/neovim/neovim/releases/download/v0.12.6/nvim-linux-x86_64.tar.gz",
		);
		expect(toolDownloadUrl(template, "nvim", "linux-arm64", "0.12.6")).toBe(
			"https://github.com/neovim/neovim/releases/download/v0.12.6/nvim-linux-arm64.tar.gz",
		);
		expect(toolDownloadUrl(template, "nvim", "darwin-arm64", "0.12.6")).toBe(
			"https://github.com/neovim/neovim/releases/download/v0.12.6/nvim-macos-arm64.tar.gz",
		);
		expect(neovimReleasePlatform("linux-x64")).toBe("linux-x86_64");
		expect(toolTopLevelDirectory("nvim", "linux-x64", "0.12.6")).toBe(
			"nvim-linux-x86_64",
		);
		expect(toolVersionArgument("nvim")).toBe("--version");
	});

	// Hosts are Linux on both architectures; this Mac is Apple Silicon.
	it("is pinned for every platform DevHub runs it on, at a 0.12 release", () => {
		expect(product.nvimVersion).toMatch(/^0\.12\.\d+$/);
		expect(
			Object.keys(product.nvimDownloadSha256 as Record<string, string>).sort(),
		).toEqual(["darwin-arm64", "linux-arm64", "linux-x64"]);
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

	function delivery(
		sha256: Readonly<Record<string, string>> = {},
		tool: HostTool = "tmux",
		version = "3.7c",
	) {
		return new ReleaseToolDelivery({
			tool,
			version,
			directory: `.devhub-server/${tool}`,
			urlTemplate: tool === "tmux" ? TEMPLATE : BASH_TEMPLATE,
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
				await readFile(
					join(cache, toolTarballName("tmux", "linux-x64", "3.7c")),
				),
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
			readFile(join(cache, toolTarballName("tmux", "linux-x64", "3.7c"))),
		).rejects.toThrow();
	});

	it("throws away a cache entry that no longer matches the pin", async () => {
		await writeFile(
			join(cache, toolTarballName("tmux", "linux-x64", "3.7c")),
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

	// One cache directory may hold both tools: the key names the tool, so a
	// bash is never handed out as the tmux of the same platform, or the other
	// way round.
	it("keys the cache on the tool as well as the platform and version", async () => {
		await delivery({}, "tmux", "3.7c").tarball("linux-x64");
		served = new Uint8Array([5, 6, 7]);
		const bash = await delivery({}, "bash", "5.3.20").tarball("linux-x64");
		expect(bash.bytes).toEqual(served);
		expect(bash.topLevelDirectory).toBe("devhub-bash-linux-x64");
		expect(requests).toEqual([
			"https://example.com/releases/download/tmux-3.7c/devhub-tmux-linux-x64-3.7c.tar.gz",
			"https://example.com/releases/download/bash-5.3.20/devhub-bash-linux-x64-5.3.20.tar.gz",
		]);
		expect(
			new Uint8Array(
				await readFile(
					join(cache, toolTarballName("bash", "linux-x64", "5.3.20")),
				),
			),
		).toEqual(served);
		expect(
			new Uint8Array(
				await readFile(
					join(cache, toolTarballName("tmux", "linux-x64", "3.7c")),
				),
			),
		).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it("checks a bash against its own pin", async () => {
		await expect(
			delivery({ "linux-x64": "0".repeat(64) }, "bash", "5.3.20").tarball(
				"linux-x64",
			),
		).rejects.toThrow(/bash 5\.3\.20 tarball for linux-x64 .* pinned to/u);
	});

	// A build whose product.json names no release for a tool has no URL to
	// fetch; saying so beats a 404 for `devhub-bash-linux-x64-.tar.gz`.
	it("refuses, saying why, when the build states no release for the tool", async () => {
		await expect(delivery({}, "bash", "").tarball("linux-x64")).rejects.toThrow(
			/states no bash release/u,
		);
		expect(requests).toHaveLength(0);
	});
});
