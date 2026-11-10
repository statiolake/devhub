import { execFileSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectUnit,
	configFiles,
	FileVerdicts,
	hasTokenShape,
	isSecretName,
	tarUnits,
	ustarSplit,
} from "./carryTree.js";

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "devhub-carry-tree-"));
});
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

async function put(path: string, content: string | Uint8Array, mode = 0o644) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
	await chmod(path, mode);
}

describe("a carried unit", () => {
	it("leaves .git, tests, maps and secrets behind, and keeps every binary", async () => {
		const plugin = join(scratch, "plugin");
		await put(join(plugin, "lua", "p", "init.lua"), "return {}");
		await put(join(plugin, ".git", "config"), "[remote] url = https://token@x");
		await put(join(plugin, "tests", "spec.lua"), "x");
		await put(join(plugin, "test", "spec.lua"), "x");
		await put(join(plugin, "lua", "p", "test", "helper.lua"), "deep: kept");
		await put(join(plugin, "dist", "index.js.map"), "{}");
		await put(join(plugin, ".env.local"), "TOKEN=1");
		await put(join(plugin, ".DS_Store"), "junk");
		await put(join(plugin, "secret.lua"), `local t = "ghp_${"a".repeat(36)}"`);
		// A Mach-O and an ELF for different platforms, as a plugin that bundles
		// every platform has them: both are carried, the host picks its own.
		const macho = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
		const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
		await put(join(plugin, "bin", "darwin-arm64", "tool"), macho, 0o755);
		await put(join(plugin, "bin", "linux-amd64", "tool"), elf, 0o755);
		const unit = await collectUnit(
			"plugin/p",
			plugin,
			{ trim: true },
			new FileVerdicts(),
		);
		const files = unit.entries
			.filter((e) => e.kind === "file")
			.map((e) => e.path);
		expect(files.sort()).toEqual([
			"bin/darwin-arm64/tool",
			"bin/linux-amd64/tool",
			"lua/p/init.lua",
			"lua/p/test/helper.lua",
		]);
		expect(unit.dropped).toEqual(
			expect.arrayContaining([
				{ path: ".env.local", reason: "secret" },
				{ path: "secret.lua", reason: "secret" },
			]),
		);
		expect(
			unit.entries.find((e) => e.path === "bin/linux-amd64/tool")?.mode,
		).toBe(0o755);
	});

	it("keeps a symlink inside the unit and drops one that leaves it", async () => {
		const plugin = join(scratch, "plugin");
		await put(join(plugin, "a.lua"), "a");
		await symlink("a.lua", join(plugin, "b.lua"));
		await symlink(join(scratch, "elsewhere"), join(plugin, "out"));
		const unit = await collectUnit(
			"plugin/p",
			plugin,
			{ trim: true },
			new FileVerdicts(),
		);
		expect(unit.entries.find((e) => e.path === "b.lua")).toMatchObject({
			kind: "symlink",
			target: "a.lua",
		});
		expect(unit.dropped).toEqual([{ path: "out", reason: "symlink-outside" }]);
	});

	it("has a digest that moves with content and mode, and not with the clock", async () => {
		const plugin = join(scratch, "plugin");
		await put(join(plugin, "a.lua"), "one");
		const verdicts = new FileVerdicts();
		const first = await collectUnit(
			"plugin/p",
			plugin,
			{ trim: true },
			verdicts,
		);
		const again = await collectUnit(
			"plugin/p",
			plugin,
			{ trim: true },
			verdicts,
		);
		expect(again.digest).toBe(first.digest);
		await put(join(plugin, "a.lua"), "two");
		const edited = await collectUnit(
			"plugin/p",
			plugin,
			{ trim: true },
			verdicts,
		);
		expect(edited.digest).not.toBe(first.digest);
		await chmod(join(plugin, "a.lua"), 0o755);
		const executable = await collectUnit(
			"plugin/p",
			plugin,
			{ trim: true },
			verdicts,
		);
		expect(executable.digest).not.toBe(edited.digest);
	});

	it("takes the config's files from git when it is a work tree, and the lockfile by name", async () => {
		const repo = join(scratch, "dotfiles");
		const config = join(repo, "neovim");
		await put(join(config, "init.lua"), "require('x')");
		await put(join(config, "lua", "x.lua"), "return 1");
		await put(join(config, "lua51", "big.so"), "build output");
		await put(join(config, "lazy-lock.json"), "{}");
		await put(
			join(repo, ".gitignore"),
			"neovim/lua51\nneovim/lazy-lock.json\n",
		);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		git("init", "-q");
		git("add", ".");
		const only = await configFiles(
			config,
			join(config, "lazy-lock.json"),
			process.env,
		);
		expect([...(only ?? [])].sort()).toEqual([
			"init.lua",
			"lazy-lock.json",
			"lua/x.lua",
		]);
		const unit = await collectUnit(
			"config",
			config,
			{ trim: false, only },
			new FileVerdicts(),
		);
		expect(
			unit.entries
				.filter((e) => e.kind === "file")
				.map((e) => e.path)
				.sort(),
		).toEqual(["init.lua", "lazy-lock.json", "lua/x.lua"]);
	});

	it("takes the whole config when it is not in git", async () => {
		expect(await configFiles(scratch, undefined, process.env)).toBeUndefined();
	});
});

describe("the filters", () => {
	it("know the names secrets live under", () => {
		for (const name of [
			".env",
			".env.work",
			"id_ed25519",
			"x.pem",
			"hosts.yml",
			"aws_credentials",
			".netrc",
		]) {
			expect(isSecretName(name)).toBe(true);
		}
		for (const name of [
			"init.lua",
			"keymaps.lua",
			"identity.lua",
			"environment.lua",
		]) {
			expect(isSecretName(name)).toBe(false);
		}
	});

	it("know a token by its shape and not a word that looks like one", () => {
		expect(hasTokenShape(Buffer.from(`x = "ghp_${"A".repeat(36)}"`))).toBe(
			true,
		);
		expect(hasTokenShape(Buffer.from(`AKIA${"A".repeat(16)}`))).toBe(true);
		expect(hasTokenShape(Buffer.from("local task-runner = 'sk-'"))).toBe(false);
		expect(
			hasTokenShape(Buffer.from("-- -----BEGIN PRIVATE KEY----- is a marker")),
		).toBe(false);
		expect(hasTokenShape(new Uint8Array([0, 1, 2]))).toBe(false);
	});
});

describe("the stream", () => {
	it("unpacks with tar into exactly the unit, long names, links and modes included", async () => {
		const plugin = join(scratch, "plugin");
		const deep = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}`;
		await put(join(plugin, deep, `${"n".repeat(90)}.lua`), "long");
		await put(join(plugin, "run.sh"), "#!/bin/sh\n", 0o755);
		await mkdir(join(plugin, "empty"));
		await symlink("run.sh", join(plugin, "link"));
		const veryLong = "x".repeat(120);
		await put(join(plugin, `${veryLong}.lua`), "pax");
		const unit = await collectUnit(
			"plugin/p",
			plugin,
			{ trim: true },
			new FileVerdicts(),
		);
		const bytes = await tarUnits([{ prefix: "u/0", unit }], {
			manifest: "m\n",
		});
		const out = join(scratch, "out");
		await mkdir(out);
		execFileSync("tar", ["xzf", "-", "-C", out], { input: bytes });
		const root = join(out, "u", "0");
		expect(
			await readFile(join(root, deep, `${"n".repeat(90)}.lua`), "utf8"),
		).toBe("long");
		expect(await readFile(join(root, `${veryLong}.lua`), "utf8")).toBe("pax");
		expect((await stat(join(root, "run.sh"))).mode & 0o777).toBe(0o755);
		expect((await stat(join(root, "empty"))).isDirectory()).toBe(true);
		expect(await readlink(join(root, "link"))).toBe("run.sh");
		expect(await readFile(join(out, "manifest"), "utf8")).toBe("m\n");
		const listing = execFileSync("tar", ["tvzf", "-"], {
			input: bytes,
		}).toString();
		expect(listing).not.toMatch(/\._|\.git\//u);
		expect(listing).toMatch(/0\/0|root\/root|0 *0/u);
	});

	it("splits a name into ustar's prefix and name, or says it cannot", () => {
		expect(ustarSplit("a/b")).toEqual({ prefix: "", name: "a/b" });
		const long = `${"a".repeat(80)}/${"b".repeat(80)}`;
		expect(ustarSplit(long)).toEqual({
			prefix: "a".repeat(80),
			name: "b".repeat(80),
		});
		expect(ustarSplit("c".repeat(120))).toBeUndefined();
	});
});
