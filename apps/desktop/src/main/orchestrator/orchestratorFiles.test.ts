/**
 * The Files tab's bridge: confined to the orchestrator's root, listing what
 * is worth listing, reading files as the tab draws them, and saying when
 * something changed.
 */

import { EventEmitter } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeOpen } from "../cli/route.js";
import type { CanonicalPath } from "../cli/resolve.js";
import {
	insideRoot,
	isNoise,
	listFolder,
	readRootFile,
	watchRoot,
} from "./orchestratorFiles.js";

/** A root with a decision, a skill, noise, and a folder beside it. */
function fixture(): { root: string; outside: string } {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "devhub-orch-files-")));
	const root = join(base, "orchestrator");
	const outside = join(base, "secrets");
	mkdirSync(join(root, ".claude/skills/triage"), { recursive: true });
	mkdirSync(join(root, ".git/objects"), { recursive: true });
	mkdirSync(join(root, "node_modules/x"), { recursive: true });
	mkdirSync(join(root, "notes"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(root, "decisions.md"), "# 決定\n\n- B で進める\n");
	writeFileSync(join(root, ".claude/skills/triage/SKILL.md"), "# triage\n");
	writeFileSync(join(root, ".DS_Store"), "");
	writeFileSync(join(root, "notes/plan.ts"), "export const x = 1;\n");
	writeFileSync(join(root, "build.log"), "noise\n");
	writeFileSync(join(outside, "token.txt"), "s3cret\n");
	symlinkSync(outside, join(root, "leak"));
	symlinkSync(join(outside, "token.txt"), join(root, "leak.txt"));
	symlinkSync(join(root, "notes"), join(root, "notes-link"));
	return { root, outside };
}

const none = () => Promise.resolve(new Set<string>());

describe("confinement to the root", () => {
	it("refuses .., absolute paths and symlinks that lead out", async () => {
		const { root } = fixture();
		await expect(insideRoot(root, "../secrets/token.txt")).rejects.toThrow(
			/leads out/u,
		);
		await expect(insideRoot(root, "notes/../../secrets")).rejects.toThrow(
			/leads out/u,
		);
		await expect(insideRoot(root, "/etc/passwd")).rejects.toThrow(
			/from its root/u,
		);
		await expect(insideRoot(root, "leak/token.txt")).rejects.toThrow(
			/leads out/u,
		);
		await expect(insideRoot(root, "leak.txt")).rejects.toThrow(/leads out/u);
		await expect(readRootFile(root, "leak.txt")).rejects.toThrow(/leads out/u);
		await expect(listFolder(root, "leak", none)).rejects.toThrow(/leads out/u);
		await expect(insideRoot(root, 7)).rejects.toThrow(/not a path/u);
	});

	it("allows the root, its files, and a symlink that stays inside", async () => {
		const { root } = fixture();
		expect(await insideRoot(root, "")).toBe(root);
		expect(await insideRoot(root, "./decisions.md")).toBe(
			join(root, "decisions.md"),
		);
		expect(await insideRoot(root, "notes-link/plan.ts")).toBe(
			join(root, "notes-link/plan.ts"),
		);
	});
});

describe("the listing", () => {
	it("leaves out noise and what escapes, keeps dot-folders, folders first", async () => {
		const { root } = fixture();
		const listed = await listFolder(root, "", none);
		expect(
			listed.entries.map((entry) => `${entry.kind}:${entry.path}`),
		).toEqual([
			"directory:.claude",
			"directory:notes",
			"directory:notes-link",
			"file:build.log",
			"file:decisions.md",
		]);
		const skills = await listFolder(root, ".claude/skills", none);
		expect(skills.path).toBe(".claude/skills");
		expect(skills.entries).toEqual([
			{
				name: "triage",
				path: ".claude/skills/triage",
				kind: "directory",
			},
		]);
	});

	it("leaves out what git ignores", async () => {
		const { root } = fixture();
		const ignored = vi.fn(() => Promise.resolve(new Set(["build.log"])));
		const listed = await listFolder(root, "", ignored);
		expect(listed.entries.map((entry) => entry.name)).not.toContain(
			"build.log",
		);
		expect(ignored).toHaveBeenCalledWith(
			root,
			expect.arrayContaining(["build.log", ".claude/", "decisions.md"]),
		);
	});

	it("knows noise by name", () => {
		expect(isNoise(".git")).toBe(true);
		expect(isNoise("node_modules")).toBe(true);
		expect(isNoise(".decisions.md.swp")).toBe(true);
		expect(isNoise(".claude")).toBe(false);
		expect(isNoise("decisions.md")).toBe(false);
	});
});

describe("reading a file", () => {
	it("reads Markdown, text with its language, images and binaries", async () => {
		const { root } = fixture();
		writeFileSync(join(root, "chart.svg"), "<svg/>");
		writeFileSync(join(root, "blob.bin"), Buffer.from([1, 0, 2]));
		expect(await readRootFile(root, "decisions.md")).toMatchObject({
			kind: "markdown",
			text: "# 決定\n\n- B で進める\n",
		});
		expect(await readRootFile(root, "notes/plan.ts")).toMatchObject({
			kind: "text",
			language: "typescript",
		});
		expect(await readRootFile(root, "chart.svg")).toMatchObject({
			kind: "image",
			dataUrl: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
		});
		expect(await readRootFile(root, "blob.bin")).toMatchObject({
			kind: "binary",
		});
		await expect(readRootFile(root, "notes")).rejects.toThrow(/folder/u);
	});
});

describe("watching the root", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("says what changed, once, a moment later — and not .git", () => {
		vi.useFakeTimers();
		const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
		let emit: (event: string, name: string | null) => void = () => undefined;
		const watchImpl = vi.fn(
			(
				_root: string,
				_options: unknown,
				listener: (event: string, name: string | null) => void,
			) => {
				emit = listener;
				return watcher;
			},
		);
		const changed = vi.fn();
		const stop = watchRoot("/r", changed, {
			debounceMs: 200,
			watchImpl: watchImpl as never,
		});
		emit("change", "decisions.md");
		emit("rename", ".git/index.lock");
		emit("change", "decisions.md");
		emit("rename", ".claude/skills/new/SKILL.md");
		expect(changed).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(changed).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledWith([
			"decisions.md",
			".claude/skills/new/SKILL.md",
		]);
		emit("rename", ".git/HEAD");
		vi.advanceTimersByTime(200);
		expect(changed).toHaveBeenCalledTimes(1);
		stop();
		expect(watcher.close).toHaveBeenCalled();
	});
});

describe("エディタで開く", () => {
	it("lands in the root's own Workspace, the way devhub <file> does", async () => {
		const { root } = fixture();
		const target = await insideRoot(root, "decisions.md");
		const workspace = {
			workspaceId: "orch",
			root: root as CanonicalPath,
			machine: "local",
			agents: [],
		};
		expect(
			routeOpen(target as CanonicalPath, "local", [
				{
					workspaceId: "other",
					root: "/elsewhere" as CanonicalPath,
					machine: "local",
					agents: [],
				},
				workspace,
			]),
		).toEqual({ kind: "workspace", reason: "containing", workspace });
	});
});
