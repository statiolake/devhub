/**
 * Listing a CLI's earlier sessions, and reading one back as history.
 *
 * `claude-session-file.handwritten.jsonl` is HAND-WRITTEN, not a capture: a
 * session file in the shape Claude writes (one record per line, each naming
 * its parent), composed to hold every case the history has to get right — a
 * meta message, a tool call and its result, a rewound branch, a subagent's
 * line, a compaction with its summary, and an `ai-title`.
 *
 * The listing scripts run for real, under `sh`, against files and a fake
 * `codex` made in a temporary directory.
 */

import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../runtime/runtime.js";
import { RuntimeFileError } from "../../runtime/runtime.js";
import {
	claudeHistory,
	claudeHistoryLines,
	codexStructuredArgs,
	listPastSessions,
	parseCodexListing,
	resumeArgs,
	resumedSession,
	type SessionProfile,
} from "./resume.js";

const FIXTURE = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"claude-session-file.handwritten.jsonl",
);
const SESSION = "00000000-0000-4000-8000-00000000000a";

describe("the one spelling of a resume", () => {
	it("is the terminal mode's arguments, and reads back from the end of an argv", () => {
		expect(resumeArgs("claude", "s1")).toEqual(["--resume", "s1"]);
		expect(resumeArgs("codex", "t1")).toEqual(["resume", "t1"]);
		expect(resumedSession("claude", ["--model", "x", "--resume", "s1"])).toBe(
			"s1",
		);
		expect(resumedSession("codex", ["-c", "a=b", "resume", "t1"])).toBe("t1");
		expect(resumedSession("claude", ["--model", "x"])).toBeUndefined();
		expect(resumedSession("codex", ["--resume", "t1"])).toBeUndefined();
		expect(resumedSession("cursor", ["--resume", "s1"])).toBeUndefined();
	});

	it("becomes thread/resume for Codex's app-server, which has no such argument", () => {
		expect(codexStructuredArgs(["-c", "a=b", "resume", "t1"])).toEqual({
			args: ["-c", "a=b", "app-server"],
			resumeThreadId: "t1",
		});
		expect(codexStructuredArgs(["-c", "a=b"])).toEqual({
			args: ["-c", "a=b", "app-server"],
			resumeThreadId: undefined,
		});
	});
});

describe("a Claude session read back as history", () => {
	it("is the chain from the last message back, across a compaction, without what nobody wrote", async () => {
		const lines = claudeHistoryLines(SESSION, await readFile(FIXTURE, "utf8"));
		const records = lines.map(
			(line) =>
				(JSON.parse(line) as { type: string; record: { uuid: string } }).record
					.uuid,
		);
		// Not the meta caveat (u1), the rewound branch (u4, a4), the subagent
		// (s1), the attachment (t1), the boundary (c1) or the summary (u5).
		expect(records).toEqual(["u2", "a1", "a2", "u3", "a3", "u6", "a5"]);
		expect(JSON.parse(lines[0]!)).toEqual({
			type: "devhub_history",
			record: {
				type: "user",
				uuid: "u2",
				message: { role: "user", content: "List the files in src" },
			},
		});
	});

	it("is refused with the path when the session is not there", async () => {
		const runtime = fakeRuntime("/home/testuser");
		await expect(
			claudeHistory(runtime, CLAUDE, "/work/project", "missing-session"),
		).rejects.toThrow(
			"/home/testuser/.claude/projects/-work-project/missing-session.jsonl",
		);
	});

	it("refuses a file that is not JSON lines rather than drawing part of it", () => {
		expect(() => claudeHistoryLines(SESSION, "{}\nnot json\n")).toThrow(
			/not a JSON object/,
		);
	});
});

describe("listing a Workspace's sessions", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "devhub-resume-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads Claude's sessions of that directory, newest first, titled", async () => {
		const project = join(dir, ".claude", "projects", "-work-my-project");
		await mkdir(project, { recursive: true });
		await writeFile(
			join(project, `${SESSION}.jsonl`),
			await readFile(FIXTURE, "utf8"),
		);
		const untitled = [
			{ type: "user", uuid: "x1", isMeta: true, message: { content: "meta" } },
			{
				type: "user",
				uuid: "x2",
				timestamp: "2026-09-21T08:00:00.000Z",
				message: { content: [{ type: "text", text: "Second\n  session" }] },
			},
		];
		await writeFile(
			join(project, "second.jsonl"),
			untitled.map((each) => JSON.stringify(each)).join("\n"),
		);
		// A session nobody wrote in is not offered, as Claude's own /resume does.
		await writeFile(join(project, "empty.jsonl"), "");
		await touch(join(project, `${SESSION}.jsonl`), 1_000);
		await touch(join(project, "second.jsonl"), 2_000);
		await touch(join(project, "empty.jsonl"), 3_000);

		const sessions = await listPastSessions(
			fakeRuntime(dir),
			CLAUDE,
			"/work/my.project",
		);
		expect(sessions).toEqual([
			{
				id: "second",
				title: "Second session",
				updatedAt: Date.parse("2026-09-21T08:00:00.000Z"),
			},
			{
				id: SESSION,
				title: "List and read the source files",
				updatedAt: Date.parse("2026-09-20T10:03:01.000Z"),
			},
		]);
	});

	it("has none for a directory Claude never ran in", async () => {
		expect(
			await listPastSessions(fakeRuntime(dir), CLAUDE, "/work/elsewhere"),
		).toEqual([]);
	});

	it("asks Codex's app-server, holding its input open until it has answered", async () => {
		const codex = join(dir, "codex");
		const requests = join(dir, "requests");
		// A fake that answers the list a moment later, and at end of input
		// quits without answering what is still in flight — which is what
		// app-server does, and why the input has to stay open.
		await writeFile(
			codex,
			`#!/bin/sh
[ "$*" = "-c a=b app-server" ] || { echo "argv: $*" >&2; exit 2; }
while IFS= read -r line; do
	printf '%s\\n' "$line" >>"${requests}"
	case $line in
	*'"initialize"'*) printf '%s\\n' '{"id":1,"result":{"userAgent":"fake"}}' ;;
	*'"thread/list"'*) { sleep 0.3; printf '%s\\n' '{"method":"note","params":{}}' '{"id":2,"result":{"data":[{"id":"t-new","preview":"Fix it","name":"Named","updatedAt":20},{"id":"t-old","preview":"First\\nmessage","name":null,"updatedAt":10}],"nextCursor":null,"backwardsCursor":null}}'; } & pending=$! ;;
	esac
done
[ -z "$pending" ] || kill "$pending" 2>/dev/null
`,
		);
		await chmod(codex, 0o755);
		const sessions = await listPastSessions(
			fakeRuntime(dir),
			{ ...CODEX, command: codex, args: ["-c", "a=b"] },
			"/work/project",
		);
		expect(sessions).toEqual([
			{ id: "t-new", title: "Named", updatedAt: 20_000 },
			{ id: "t-old", title: "First message", updatedAt: 10_000 },
		]);
		const asked = (await readFile(requests, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { method: string; params?: unknown });
		expect(asked.map((each) => each.method)).toEqual([
			"initialize",
			"initialized",
			"thread/list",
		]);
		expect(asked[2]!.params).toEqual({
			cwd: "/work/project",
			limit: 50,
			sortKey: "updated_at",
		});
	});

	it("says what Codex said when it refuses, or that it ended without answering", () => {
		expect(() =>
			parseCodexListing(
				'{"id":1,"result":{}}\n{"id":2,"error":{"code":-32600,"message":"no such cwd"}}\n',
				"",
			),
		).toThrow("codex did not list its threads: no such cwd (-32600)");
		expect(() => parseCodexListing("", "error: not logged in\n")).toThrow(
			"codex app-server ended without listing its threads: error: not logged in",
		);
	});
});

const CLAUDE: SessionProfile = {
	kind: "claude",
	command: "claude",
	args: [],
	env: new Map(),
};
const CODEX: SessionProfile = {
	kind: "codex",
	command: "codex",
	args: [],
	env: new Map(),
};

async function touch(path: string, seconds: number): Promise<void> {
	const { utimes } = await import("node:fs/promises");
	await utimes(path, seconds, seconds);
}

/**
 * The parts of a machine these read: its home, a realpath that maps `/work`
 * under it, a file read, and `exec` run here for real.
 */
function fakeRuntime(home: string): Runtime {
	const runtime: Partial<Runtime> = {
		where: "",
		home: () => Promise.resolve(home),
		environment: () =>
			Promise.resolve({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
		realpath: (path) => Promise.resolve(path),
		readTextFile: async (path) => {
			try {
				return await readFile(path, "utf8");
			} catch (error: unknown) {
				throw new RuntimeFileError(path, (error as { code?: string }).code);
			}
		},
		exec: (request) =>
			new Promise((resolve) => {
				const child = execFile(
					request.argv[0]!,
					request.argv.slice(1),
					{ env: request.env as NodeJS.ProcessEnv, encoding: "buffer" },
					(error, stdout, stderr) =>
						resolve({
							code: error ? ((error as { code?: number }).code ?? 1) : 0,
							signal: null,
							stdout,
							stderr,
						}),
				);
				child.stdin!.end(request.stdin ?? Buffer.alloc(0));
			}),
	};
	return runtime as Runtime;
}
