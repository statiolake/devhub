/**
 * A host's tools come from inside the app (`out/host-tools`), checked against
 * the digests the build wrote, and never from the network.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_ROOT } from "../shell/appRoot.js";
import {
	BundledArchiveDelivery,
	bundledHostTool,
	toolBinaryPath,
	toolInstallDirectory,
	toolVersionArgument,
	type HostTool,
	type HostToolsManifest,
} from "./toolDelivery.js";

const sha = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");

describe("a tool from the app's out/host-tools", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "devhub-host-tools-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function bundle(
		files: Record<string, string>,
		pins: Record<string, string> = {},
	): Promise<void> {
		const platforms: Record<
			string,
			{ file: string; sha256: string; topLevelDirectory: string }
		> = {};
		for (const [platform, text] of Object.entries(files)) {
			await mkdir(join(root, platform), { recursive: true });
			const file = `${platform}/tmux-3.7c.tar.gz`;
			await writeFile(join(root, file), text);
			platforms[platform] = {
				file,
				sha256: pins[platform] ?? sha(text),
				topLevelDirectory: `devhub-tmux-${platform}`,
			};
		}
		const manifest: HostToolsManifest = {
			tools: { tmux: { version: "3.7c", binary: "bin/tmux", platforms } },
		};
		await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
	}

	it("hands over a platform's tarball as the build wrote it", async () => {
		await bundle({ "linux-x64": "x64 bytes", "linux-arm64": "arm bytes" });
		const delivery = bundledHostTool("tmux", ".devhub-server/tmux", root);
		expect(delivery.version).toBe("3.7c");
		expect(delivery.directory).toBe(".devhub-server/tmux");
		const tarball = await delivery.tarball("linux-arm64");
		expect(Buffer.from(tarball.bytes).toString()).toBe("arm bytes");
		expect(tarball.topLevelDirectory).toBe("devhub-tmux-linux-arm64");
		expect(tarball.verifiedSha256).toBe(sha("arm bytes"));
		expect(tarball.format).toBeUndefined();
	});

	it("refuses a copy that is not what the build pinned", async () => {
		await bundle({ "linux-x64": "damaged" }, { "linux-x64": sha("whole") });
		const delivery = new BundledArchiveDelivery("tmux", "d", root);
		await expect(delivery.tarball("linux-x64")).rejects.toThrow(/damaged/u);
	});

	it("names the platforms it has when asked for another", async () => {
		await bundle({ "linux-x64": "x" });
		const delivery = new BundledArchiveDelivery("tmux", "d", root);
		await expect(delivery.tarball("linux-riscv64")).rejects.toThrow(
			/bundles tmux for linux-x64, not linux-riscv64/u,
		);
	});

	it("names the build step when the bundle is not there", async () => {
		const delivery = new BundledArchiveDelivery("bash", "d", join(root, "no"));
		expect(delivery.version).toBe("");
		await expect(delivery.tarball("linux-x64")).rejects.toThrow(
			/build:binaries/u,
		);
	});

	it("says so when the bundle has no such tool", async () => {
		await bundle({ "linux-x64": "x" });
		const delivery = new BundledArchiveDelivery("node", "d", root);
		await expect(delivery.tarball("linux-x64")).rejects.toThrow(
			/bundles no node/u,
		);
	});
});

describe("how a tool is installed and asked", () => {
	it("keeps each tool under the server folder, by name", () => {
		expect(toolInstallDirectory(".devhub-server", "node")).toBe(
			".devhub-server/node",
		);
	});

	it("finds rg and fd at the top of their archives, the rest in bin/", () => {
		expect(toolBinaryPath("rg")).toBe("rg");
		expect(toolBinaryPath("fd")).toBe("fd");
		expect(toolBinaryPath("node")).toBe("bin/node");
		expect(toolBinaryPath("tmux")).toBe("bin/tmux");
	});

	it("asks each binary for its version the way that binary answers", () => {
		expect(toolVersionArgument("tmux")).toBe("-V");
		expect(toolVersionArgument("bash")).toBe("--version");
		expect(toolVersionArgument("nvim")).toBe("--version");
		expect(toolVersionArgument("devhub")).toBe("--help");
	});
});

describe("this build's out/host-tools", () => {
	const directory = join(APP_ROOT, "out", "host-tools");
	const manifestPath = join(directory, "manifest.json");
	const product = JSON.parse(
		readFileSync(join(APP_ROOT, "product.json"), "utf8"),
	) as Record<string, unknown>;

	// `pnpm test` runs `build:binaries` first.
	it.skipIf(!existsSync(manifestPath) && process.env.CI !== "true")(
		"holds every host tool for both Linux architectures, at the pinned versions",
		() => {
			const manifest = JSON.parse(
				readFileSync(manifestPath, "utf8"),
			) as HostToolsManifest;
			const tools: HostTool[] = ["tmux", "bash", "nvim", "node", "rg", "fd"];
			expect(Object.keys(manifest.tools).sort()).toEqual([...tools].sort());
			for (const tool of tools) {
				const entry = manifest.tools[tool];
				expect(entry?.version).toBe(product[`${tool}Version`]);
				expect(entry?.binary).toBe(toolBinaryPath(tool));
				expect(Object.keys(entry?.platforms ?? {}).sort()).toEqual([
					"linux-arm64",
					"linux-x64",
				]);
				for (const bundled of Object.values(entry?.platforms ?? {})) {
					expect(
						sha(readFileSync(join(directory, bundled.file))),
						bundled.file,
					).toBe(bundled.sha256);
				}
			}
		},
	);
});
