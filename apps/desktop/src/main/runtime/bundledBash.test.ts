/**
 * The bash inside DevHub (`out/bash`, `build:binaries`) and the Claude Agents on
 * this machine that run in it.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devhubProduct } from "../product.js";
import {
	bundledBash,
	bundledBashMissing,
	bundledBashPath,
} from "./bundledBash.js";
import { LocalRuntime } from "./local.js";

describe("the bundled bash", () => {
	// `pnpm test` runs `build:binaries` first.
	it("is in out/bash and is the pinned version", () => {
		const bash = bundledBash();
		expect(bash).toBe(bundledBashPath());
		const said = spawnSync(bash ?? "", ["-c", 'printf %s "$BASH_VERSION"'], {
			encoding: "utf8",
			env: {},
		});
		expect(said.status).toBe(0);
		expect(said.stdout.startsWith(devhubProduct().bashVersion ?? "?")).toBe(
			true,
		);
	});

	it("is what a local Claude Agent gets as CLAUDE_CODE_SHELL", async () => {
		const bash = bundledBashPath();
		expect(await new LocalRuntime().claudeShell()).toEqual({
			CLAUDE_CODE_SHELL: bash,
		});
	});

	it("says what to run when a build has none", async () => {
		const empty = await mkdtemp(join(tmpdir(), "devhub-no-bash-"));
		try {
			expect(bundledBash(empty)).toBeUndefined();
			expect(bundledBashMissing(empty)).toContain("build:binaries");
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});
});
