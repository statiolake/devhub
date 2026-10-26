/**
 * The person's Neovim configuration, read and packed for a host: symlinks
 * followed (the dotfiles case), `.git` and caches left out, the digest stable
 * for the same contents and different for different ones, and the tarball one
 * that a real `tar` unpacks into the same tree.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	configDigest,
	MAX_FILE_BYTES,
	neovimConfigDirectory,
	readNeovimConfig,
	type PackedNeovimConfig,
} from "./neovimConfig.js";
import { makeScratchDir } from "../../model/testScratch.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function scratch(): string {
	const directory = makeScratchDir("nvim-config");
	directories.push(directory);
	return directory;
}

/** A dotfiles checkout, and `~/.config/nvim` a link into it. */
function dotfiles(): { home: string; checkout: string } {
	const home = scratch();
	const checkout = join(home, "dotfiles", "nvim");
	mkdirSync(join(checkout, "lua", "plugins"), { recursive: true });
	mkdirSync(join(checkout, ".git", "objects"), { recursive: true });
	writeFileSync(join(checkout, "init.lua"), 'require("plugins")\n');
	writeFileSync(join(checkout, "lua", "plugins", "init.lua"), "return {}\n");
	writeFileSync(join(checkout, "lazy-lock.json"), "{}\n");
	writeFileSync(join(checkout, ".git", "objects", "big"), "history");
	writeFileSync(join(checkout, ".DS_Store"), "litter");
	mkdirSync(join(home, ".config"), { recursive: true });
	symlinkSync(checkout, join(home, ".config", "nvim"));
	return { home, checkout };
}

function packed(
	config: Awaited<ReturnType<typeof readNeovimConfig>>,
): PackedNeovimConfig {
	if (config.kind !== "config") throw new Error("expected a configuration");
	return config;
}

describe("the Neovim configuration DevHub copies to a host", () => {
	it("is $XDG_CONFIG_HOME/nvim, or ~/.config/nvim", () => {
		expect(neovimConfigDirectory({}, "/Users/me")).toBe(
			"/Users/me/.config/nvim",
		);
		expect(
			neovimConfigDirectory({ XDG_CONFIG_HOME: "/Users/me/xdg" }, "/Users/me"),
		).toBe("/Users/me/xdg/nvim");
		// A relative XDG_CONFIG_HOME is invalid by the spec, and ignored.
		expect(neovimConfigDirectory({ XDG_CONFIG_HOME: "xdg" }, "/Users/me")).toBe(
			"/Users/me/.config/nvim",
		);
	});

	it("is none when there is no directory", async () => {
		const home = scratch();
		expect(await readNeovimConfig(join(home, ".config", "nvim"))).toEqual({
			kind: "none",
			digest: "none",
			looked: join(home, ".config", "nvim"),
		});
	});

	it("follows the dotfiles symlink and leaves .git and litter out", async () => {
		const { home, checkout } = dotfiles();
		const config = packed(
			await readNeovimConfig(join(home, ".config", "nvim")),
		);
		expect(config.source).toBe(checkout);
		expect(config.files).toBe(3);
		const out = scratch();
		writeFileSync(join(out, "c.tar.gz"), config.tarball);
		execFileSync("tar", ["xzf", join(out, "c.tar.gz"), "-C", out]);
		expect(readFileSync(join(out, "init.lua"), "utf8")).toBe(
			'require("plugins")\n',
		);
		expect(readFileSync(join(out, "lua", "plugins", "init.lua"), "utf8")).toBe(
			"return {}\n",
		);
		expect(() => statSync(join(out, ".git"))).toThrow();
		expect(() => statSync(join(out, ".DS_Store"))).toThrow();
	});

	it("follows a link inside, walks a loop once, and says what it skipped", async () => {
		const { home, checkout } = dotfiles();
		const elsewhere = join(home, "shared.lua");
		writeFileSync(elsewhere, "-- shared\n");
		symlinkSync(elsewhere, join(checkout, "lua", "shared.lua"));
		symlinkSync(checkout, join(checkout, "lua", "loop"));
		symlinkSync(join(home, "missing"), join(checkout, "dangling.lua"));
		writeFileSync(join(checkout, "huge.bin"), Buffer.alloc(MAX_FILE_BYTES + 1));
		const config = packed(
			await readNeovimConfig(join(home, ".config", "nvim")),
		);
		const out = scratch();
		writeFileSync(join(out, "c.tar.gz"), config.tarball);
		execFileSync("tar", ["xzf", join(out, "c.tar.gz"), "-C", out]);
		expect(readFileSync(join(out, "lua", "shared.lua"), "utf8")).toBe(
			"-- shared\n",
		);
		expect(() => statSync(join(out, "lua", "loop"))).toThrow();
		expect(config.skipped).toEqual([
			"dangling.lua (a link to nothing)",
			"huge.bin (8 MB)",
		]);
	});

	it("keeps an executable bit and names longer than ustar's hundred bytes", async () => {
		const { home, checkout } = dotfiles();
		const deep = join(checkout, "a".repeat(60), "b".repeat(60));
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(deep, "c.lua"), "-- deep\n");
		writeFileSync(join(checkout, "tool.sh"), "#!/bin/sh\n");
		chmodSync(join(checkout, "tool.sh"), 0o755);
		const config = packed(
			await readNeovimConfig(join(home, ".config", "nvim")),
		);
		const out = scratch();
		writeFileSync(join(out, "c.tar.gz"), config.tarball);
		execFileSync("tar", ["xzf", join(out, "c.tar.gz"), "-C", out]);
		expect(
			readFileSync(join(out, "a".repeat(60), "b".repeat(60), "c.lua"), "utf8"),
		).toBe("-- deep\n");
		expect(statSync(join(out, "tool.sh")).mode & 0o111).not.toBe(0);
	});

	it("hashes what the copy means: the same contents the same, any change differently", async () => {
		const { home, checkout } = dotfiles();
		const path = join(home, ".config", "nvim");
		const first = packed(await readNeovimConfig(path));
		expect(packed(await readNeovimConfig(path)).digest).toBe(first.digest);
		writeFileSync(join(checkout, "init.lua"), 'require("other")\n');
		const edited = packed(await readNeovimConfig(path));
		expect(edited.digest).not.toBe(first.digest);
		chmodSync(join(checkout, "init.lua"), 0o755);
		expect(packed(await readNeovimConfig(path)).digest).not.toBe(edited.digest);
	});

	it("does not depend on the order entries are listed in", () => {
		const a = {
			path: "a",
			directory: false,
			executable: false,
			mtimeSeconds: 1,
			bytes: Buffer.from("1"),
		};
		const b = { ...a, path: "b", mtimeSeconds: 2, bytes: Buffer.from("2") };
		expect(configDigest([a, b])).toBe(configDigest([b, a]));
		// The time a file was touched is not what it says.
		expect(configDigest([a, b])).toBe(
			configDigest([{ ...a, mtimeSeconds: 99 }, b]),
		);
	});
});
