/**
 * Which hosts DevHub's Neovim is delivered to: Neovim's own Linux builds,
 * which need glibc 2.34 (`libc.ts`).
 */

import { describe, expect, it } from "vitest";
import {
	NEOVIM_MINIMUM_GLIBC,
	neovimHostRefusal,
	parseGlibcVersion,
	type NeovimHostFacts,
} from "./libc.js";

const host: NeovimHostFacts = {
	machine: "box",
	platform: "Linux",
	architecture: "x64",
	libc: "glibc",
	glibc: [2, 39],
	version: "0.12.6",
};

describe("a host for DevHub's Neovim", () => {
	it("reads getconf's answer", () => {
		expect(parseGlibcVersion("glibc 2.39\n")).toEqual([2, 39]);
		expect(parseGlibcVersion("")).toBeUndefined();
	});

	it("is a glibc Linux on x86_64 or arm64, 2.34 or later", () => {
		expect(NEOVIM_MINIMUM_GLIBC).toEqual([2, 34]);
		expect(neovimHostRefusal(host)).toBeUndefined();
		expect(
			neovimHostRefusal({ ...host, architecture: "arm64", glibc: [2, 34] }),
		).toBeUndefined();
		expect(neovimHostRefusal({ ...host, glibc: [3, 0] })).toBeUndefined();
		// One that cannot say is tried: what came out is asked to run.
		expect(neovimHostRefusal({ ...host, glibc: undefined })).toBeUndefined();
	});

	it("refuses an older glibc, musl and what nothing is pinned for, by name", () => {
		expect(neovimHostRefusal({ ...host, glibc: [2, 31] })).toBe(
			"box has glibc 2.31, and the Neovim 0.12.6 DevHub installs there is Neovim's own Linux build, which needs glibc 2.34 or later",
		);
		expect(
			neovimHostRefusal({ ...host, libc: "musl", glibc: undefined }),
		).toMatch(/^box runs on musl \(Alpine\).*glibc 2\.34 or later$/u);
		expect(neovimHostRefusal({ ...host, architecture: "armv7l" })).toMatch(
			/^box is Linux armv7l, and DevHub delivers its Neovim to Linux hosts/u,
		);
		expect(
			neovimHostRefusal({ ...host, platform: "Darwin", architecture: "arm64" }),
		).toMatch(/^box is Darwin arm64/u);
	});
});
