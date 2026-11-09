import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BundledToolDelivery } from "./bundledTool.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("the devhub command delivered from inside the app", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "devhub-bundled-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function build(binaries: Record<string, string>, sums = binaries) {
		for (const [platform, text] of Object.entries(binaries)) {
			await mkdir(join(root, platform), { recursive: true });
			await writeFile(join(root, platform, "devhub"), text);
		}
		const lines = Object.entries(sums).map(
			([platform, text]) => `${sha(text)}  ${platform}/devhub`,
		);
		await writeFile(join(root, "SHA256SUMS"), `${lines.join("\n")}\n`);
	}

	it("hands over the binary for a platform, checked against the build's digest", async () => {
		await build({ "linux-x64": "x64", "linux-arm64": "arm" });
		const delivery = new BundledToolDelivery(
			"devhub",
			".devhub-server/devhub",
			root,
		);
		const payload = await delivery.tarball("linux-arm64");
		expect(payload.format).toBe("binary");
		expect(Buffer.from(payload.bytes).toString()).toBe("arm");
		expect(payload.verifiedSha256).toBe(sha("arm"));
		expect(delivery.directory).toBe(".devhub-server/devhub");
	});

	it("is versioned by the build, so a changed binary installs beside the old one", async () => {
		await build({ "linux-x64": "one" });
		const first = new BundledToolDelivery("devhub", "d", root).version;
		expect(first).toMatch(/^[0-9a-f]{12}$/u);
		expect(new BundledToolDelivery("devhub", "d", root).version).toBe(first);
		await build({ "linux-x64": "two" });
		expect(new BundledToolDelivery("devhub", "d", root).version).not.toBe(
			first,
		);
	});

	it("refuses a damaged copy and a platform the build has none for", async () => {
		await build({ "linux-x64": "tampered" }, { "linux-x64": "original" });
		const delivery = new BundledToolDelivery("devhub", "d", root);
		await expect(delivery.tarball("linux-x64")).rejects.toThrow(/damaged/u);
		await expect(delivery.tarball("freebsd-x64")).rejects.toThrow(
			/no devhub for freebsd-x64/u,
		);
	});

	it("names the build step when the build did not run", async () => {
		const delivery = new BundledToolDelivery("devhub", "d", join(root, "none"));
		expect(delivery.version).toBe("");
		await expect(delivery.tarball("linux-x64")).rejects.toThrow(
			/build:devhub-cli/u,
		);
	});
});
