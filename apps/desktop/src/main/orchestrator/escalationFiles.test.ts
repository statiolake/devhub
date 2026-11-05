import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EscalationFileError,
	importEscalationFiles,
} from "./escalationFiles.js";

function world() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "devhub-esc-files-")));
	const worktree = join(base, "worktrees/web");
	const orchestrator = join(base, "orchestrator");
	const elsewhere = join(base, "elsewhere");
	const store = join(base, "userData/devhub/escalations");
	for (const dir of [join(worktree, "out"), orchestrator, elsewhere])
		mkdirSync(dir, { recursive: true });
	writeFileSync(join(worktree, "out/list.png"), "PNG-BYTES");
	writeFileSync(join(worktree, "out/flow.svg"), "<svg/>");
	writeFileSync(join(elsewhere, "secret.png"), "NOPE");
	symlinkSync(join(elsewhere, "secret.png"), join(worktree, "out/leak.png"));
	return {
		base,
		worktree,
		store,
		place: {
			storeRoot: store,
			id: 7,
			baseDir: worktree,
			allowedRoots: [worktree, orchestrator],
		},
	};
}

describe("an escalation's pictures, kept with it", () => {
	it("copies relative and absolute images — in prose and in a table — and points at the copies", () => {
		const { worktree, store, place } = world();
		const body = [
			"![一覧](out/list.png)",
			"",
			"| 画面 | 図 |",
			"|---|---|",
			`| ![](out/list.png) | #![流れ](${worktree}/out/flow.svg) |`,
			"",
			"See [the page](https://example.com/a.png) and ![remote](https://example.com/x.png).",
		].join("\n");
		const { markdown, files } = importEscalationFiles(body, place);
		const png = join(store, "7/1-list.png");
		const svg = join(store, "7/1-flow.svg");
		expect(files).toEqual([
			{ from: join(worktree, "out/list.png"), to: png },
			{ from: join(worktree, "out/flow.svg"), to: svg },
		]);
		expect(readFileSync(png, "utf8")).toBe("PNG-BYTES");
		expect(readFileSync(svg, "utf8")).toBe("<svg/>");
		expect(markdown).toBe(
			[
				`![一覧 (out/list.png)](<${png}>)`,
				"",
				"| 画面 | 図 |",
				"|---|---|",
				`| ![out/list.png](<${png}>) | #![流れ (${worktree}/out/flow.svg)](<${svg}>) |`,
				"",
				"See [the page](https://example.com/a.png) and ![remote](https://example.com/x.png).",
			].join("\n"),
		);
		// Asked again with the copy: nothing more is taken.
		expect(importEscalationFiles(markdown, place).files).toEqual([]);
	});

	it("leaves code alone", () => {
		const { place } = world();
		const body = "```md\n![x](out/list.png)\n```\n\n`![y](out/list.png)`";
		expect(importEscalationFiles(body, place)).toEqual({
			markdown: body,
			files: [],
		});
	});

	it("refuses a file outside the allowed folders, a symlink out of them included", () => {
		const { base, place } = world();
		expect(() =>
			importEscalationFiles(`![s](${base}/elsewhere/secret.png)`, place),
		).toThrow(/outside the open workspaces/u);
		expect(() => importEscalationFiles("![s](out/leak.png)", place)).toThrow(
			EscalationFileError,
		);
		expect(() =>
			importEscalationFiles("![s](../../elsewhere/secret.png)", place),
		).toThrow(/outside/u);
		expect(() => importEscalationFiles("![s](out/gone.png)", place)).toThrow(
			/is not there/u,
		);
		expect(() =>
			importEscalationFiles("![s](out/list.png)", {
				...place,
				baseDir: undefined,
			}),
		).toThrow(/relative/u);
	});

	it("keeps to a size per file and in all", () => {
		const { worktree, place } = world();
		writeFileSync(join(worktree, "out/big.png"), Buffer.alloc(2048));
		expect(() =>
			importEscalationFiles("![b](out/big.png)", { ...place, maxFile: 1024 }),
		).toThrow(/at most 0\.0 MB|files of at most/u);
		expect(() =>
			importEscalationFiles("![a](out/list.png) ![b](out/flow.svg)", {
				...place,
				maxTotal: 10,
			}),
		).toThrow(/come to/u);
	});
});
