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

import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
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
import { errorWire } from "../../../model/wire.js";
import {
	claudeHistory,
	claudeHistoryLines,
	codexStructuredArgs,
	listPastSessions,
	parseCodexListing,
	previewPastSession,
	terminalSession,
	resumeArgs,
	resumedSession,
	withSession,
	type SessionProfile,
} from "./resume.js";
import { SessionNotResumable } from "./failures.js";

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

describe("the CLI's argv for a session", () => {
	it("replaces every argument that picks a session, rather than adding to them", () => {
		expect(
			withSession(
				"claude",
				["--model", "x", "--resume", "old", "--verbose"],
				["--resume", "new"],
			),
		).toEqual(["--model", "x", "--verbose", "--resume", "new"]);
		expect(
			withSession(
				"claude",
				[
					"--continue",
					"-r",
					"a",
					"--resume=b",
					"--resume-session-at",
					"m1",
					"--resume-session-at=m2",
					"--resume-drops-turn",
					"-c",
					"--model",
					"x",
				],
				["--resume", "s", "--resume-session-at", "m3"],
			),
		).toEqual(["--model", "x", "--resume", "s", "--resume-session-at", "m3"]);
		expect(
			withSession("codex", ["-c", "a=b", "resume", "old"], ["resume", "new"]),
		).toEqual(["-c", "a=b", "resume", "new"]);
		expect(
			withSession("codex", ["resume", "--last", "-m", "x"], ["resume", "t"]),
		).toEqual(["-m", "x", "resume", "t"]);
	});

	it("starts a new session when nothing picks one", () => {
		expect(
			withSession("claude", ["--resume", "old", "--model", "x"], []),
		).toEqual(["--model", "x"]);
	});

	it("is what a launch resuming a session runs, which reads its session back", () => {
		const args = withSession(
			"claude",
			["--resume", "old"],
			resumeArgs("claude", "new"),
		);
		expect(args).toEqual(["--resume", "new"]);
		expect(resumedSession("claude", args)).toBe("new");
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
		// (s1), the CLI's note to the model (t1) or the summary (u5); the
		// boundary (c1) is the compaction, which is drawn.
		expect(records).toEqual(["u2", "a1", "a2", "u3", "a3", "c1", "u6", "a5"]);
		expect(JSON.parse(lines[0]!)).toEqual({
			type: "devhub_history",
			record: {
				type: "user",
				uuid: "u2",
				message: { role: "user", content: "List the files in src" },
			},
		});
	});

	it("goes up the file past a record Claude wrote twice under one uuid, across the compaction once", async () => {
		// HAND-WRITTEN (claude-session-rewritten-uuid.handwritten.jsonl), in
		// the shape of a long real session: an attachment written again under
		// its uuid after a compaction, whose boundary names the first copy as
		// its logical parent. Taking the second copy there closed a loop.
		const lines = claudeHistoryLines(
			SESSION,
			await readFile(
				join(
					dirname(FIXTURE),
					"claude-session-rewritten-uuid.handwritten.jsonl",
				),
				"utf8",
			),
		);
		expect(
			lines.map(
				(line) =>
					(JSON.parse(line) as { record: { uuid: string } }).record.uuid,
			),
		).toEqual(["u1", "a1", "c1", "u6", "a6"]);
	});

	it("follows a parent written only after its child, as the CLI's own resume reads the file by uuid, rather than refusing the session", () => {
		const line = (fields: Record<string, unknown>) =>
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "x" },
				...fields,
			});
		const lines = claudeHistoryLines(
			SESSION,
			[
				line({ uuid: "u1", parentUuid: null }),
				line({ uuid: "u3", parentUuid: "u2" }),
				line({ uuid: "u2", parentUuid: "u1" }),
				line({ uuid: "u4", parentUuid: "u3" }),
			].join("\n"),
		);
		expect(
			lines.map(
				(each) =>
					(JSON.parse(each) as { record: { uuid: string } }).record.uuid,
			),
		).toEqual(["u1", "u2", "u3", "u4"]);
	});

	it("goes on across a compaction whose logical parent was written after it, under its summary, to the conversation above it in the file", async () => {
		// HAND-WRITTEN (claude-session-logical-parent-after.handwritten.jsonl),
		// in the link structure of real compacted sessions: the boundary's
		// logicalParentUuid names a reminder the CLI wrote only after the
		// summary, parented under it, so following it re-enters the chain after
		// the compaction. What came before is the conversation standing above
		// the boundary, a queued message of the person's included.
		const lines = claudeHistoryLines(
			SESSION,
			await readFile(
				join(
					dirname(FIXTURE),
					"claude-session-logical-parent-after.handwritten.jsonl",
				),
				"utf8",
			),
		).map((each) => JSON.parse(each) as { record: Record<string, unknown> });
		expect(
			lines.map((each) => each.record["uuid"] ?? each.record["type"]),
		).toEqual(["u1", "a1", "q1", "c1", "attachment", "u6", "a6"]);
	});

	it("goes on across a compaction whose logical parent is not in the file, to the conversation above it", () => {
		const line = (fields: Record<string, unknown>) =>
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "x" },
				...fields,
			});
		const lines = claudeHistoryLines(
			SESSION,
			[
				line({ uuid: "u1", parentUuid: null }),
				line({ uuid: "u2", parentUuid: "u1" }),
				JSON.stringify({
					type: "system",
					subtype: "compact_boundary",
					uuid: "c1",
					parentUuid: null,
					logicalParentUuid: "gone",
				}),
				line({ uuid: "u3", parentUuid: "c1" }),
			].join("\n"),
		);
		expect(
			lines.map(
				(each) =>
					(JSON.parse(each) as { record: { uuid: string } }).record.uuid,
			),
		).toEqual(["u1", "u2", "c1", "u3"]);
	});

	it("reads every record of a chain that loops back once, without a warning, rather than refusing the session", () => {
		const line = (fields: Record<string, unknown>) =>
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "x" },
				...fields,
			});
		const lines = claudeHistoryLines(
			SESSION,
			[
				line({ uuid: "u1", parentUuid: "u3" }),
				line({ uuid: "u2", parentUuid: "u1" }),
				line({ uuid: "u3", parentUuid: "u2" }),
				line({ uuid: "u4", parentUuid: "u3" }),
			].join("\n"),
		).map((each) => JSON.parse(each) as { record: Record<string, unknown> });
		expect(lines.map((each) => each.record["uuid"])).toEqual([
			"u1",
			"u2",
			"u3",
			"u4",
		]);
	});

	it("resumes a session too large to read back, saying its history is not drawn, rather than refusing it", async () => {
		const runtime = {
			...fakeRuntime("/home/testuser"),
			readTextFile: () => Promise.resolve("x".repeat(33 * 1024 * 1024)),
		} as Runtime;
		const lines = await claudeHistory(runtime, CLAUDE, "/work/project", "big");
		expect(lines.map((each) => JSON.parse(each) as unknown)).toEqual([
			{
				type: "devhub_history",
				record: {
					type: "system",
					subtype: "informational",
					level: "warning",
					content:
						"This session's file is larger than DevHub reads back (32 MiB), so its earlier conversation is not drawn here. The CLI has all of it.",
				},
			},
		]);
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
				cwd: "/work/my.project",
				resumableHere: true,
			},
			{
				id: SESSION,
				title: "List and read the source files",
				updatedAt: Date.parse("2026-09-20T10:03:01.000Z"),
				cwd: "/home/testuser/project",
				// The branch its last line was on.
				branch: "main",
				resumableHere: true,
			},
		]);
	});

	it("reads every project's sessions when asked for all of them, newest first across directories, and says which can go on here", async () => {
		const projects = join(dir, ".claude", "projects");
		const mine = join(projects, "-work-mine");
		const other = join(projects, "-work-other");
		await mkdir(mine, { recursive: true });
		await mkdir(other, { recursive: true });
		const session = (cwd: string, text: string, stamp: string) =>
			JSON.stringify({
				type: "user",
				uuid: "x",
				cwd,
				timestamp: stamp,
				message: { content: text },
			});
		await writeFile(
			join(mine, "m1.jsonl"),
			session("/work/mine", "Mine", "2026-09-20T00:00:00.000Z"),
		);
		await writeFile(
			join(other, "o1.jsonl"),
			session("/work/other", "Other's", "2026-09-22T00:00:00.000Z"),
		);
		await touch(join(mine, "m1.jsonl"), 1_000);
		await touch(join(other, "o1.jsonl"), 2_000);

		const everywhere = await listPastSessions(
			fakeRuntime(dir),
			CLAUDE,
			"/work/mine",
			"everywhere",
		);
		expect(everywhere).toEqual([
			{
				id: "o1",
				title: "Other's",
				updatedAt: Date.parse("2026-09-22T00:00:00.000Z"),
				cwd: "/work/other",
				resumableHere: false,
			},
			{
				id: "m1",
				title: "Mine",
				updatedAt: Date.parse("2026-09-20T00:00:00.000Z"),
				cwd: "/work/mine",
				resumableHere: true,
			},
		]);
		expect(
			(await listPastSessions(fakeRuntime(dir), CLAUDE, "/work/mine")).map(
				(each) => each.id,
			),
		).toEqual(["m1"]);
	});

	it("titles a Claude session by the name a person gave it, else by Claude's title, else by its first prompt", async () => {
		const project = join(dir, ".claude", "projects", "-work-titles");
		await mkdir(project, { recursive: true });
		const prompt = {
			type: "user",
			uuid: "u1",
			timestamp: "2026-09-20T00:00:00.000Z",
			message: { content: "The first prompt" },
		};
		const aiTitle = (text: string) => ({
			type: "ai-title",
			aiTitle: text,
			sessionId: "s",
		});
		const customTitle = (text: string) => ({
			type: "custom-title",
			customTitle: text,
			sessionId: "s",
		});
		const files: Record<string, readonly object[]> = {
			// Renamed twice, and Claude titled it again after: the latest name.
			named: [
				prompt,
				aiTitle("Generated one"),
				customTitle("Given name"),
				customTitle("Given name, renamed"),
				aiTitle("Generated two"),
			],
			// Never renamed: Claude's latest title.
			generated: [prompt, aiTitle("Generated one"), aiTitle("Generated two")],
			// Neither: the first prompt.
			bare: [prompt],
		};
		let age = 0;
		for (const [id, lines] of Object.entries(files)) {
			const file = join(project, `${id}.jsonl`);
			await writeFile(
				file,
				lines.map((each) => JSON.stringify(each)).join("\n"),
			);
			await touch(file, (age += 1_000));
		}

		const titles = (
			await listPastSessions(fakeRuntime(dir), CLAUDE, "/work/titles")
		).map((each) => [each.id, each.title]);
		expect(titles).toEqual([
			["bare", "The first prompt"],
			["generated", "Generated two"],
			["named", "Given name, renamed"],
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
		// A fake that answers the list a moment later — in JSON spaced the way
		// another serializer spaces it — and at end of input
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
	*'"thread/list"'*) { sleep 0.3; printf '%s\\n' '{"method":"note","params":{}}' '{"id": 2, "result": {"data":[{"id":"t-new","preview":"Fix it","name":"Named","updatedAt":20,"cwd":"/work/project","gitInfo":{"sha":null,"branch":"feature/128-wip","originUrl":null}},{"id":"t-old","preview":"First\\nmessage","name":null,"updatedAt":10,"cwd":"/work/elsewhere"}],"nextCursor":null,"backwardsCursor":null}}'; } & pending=$! ;;
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
			{
				id: "t-new",
				title: "Named",
				updatedAt: 20_000,
				cwd: "/work/project",
				branch: "feature/128-wip",
				resumableHere: true,
			},
			{
				id: "t-old",
				title: "First message",
				updatedAt: 10_000,
				cwd: "/work/elsewhere",
				resumableHere: true,
			},
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

	it("says what was being asked when the machine gives no answer at all", async () => {
		const runtime = {
			...fakeRuntime(dir),
			exec: () => Promise.reject(new Error("terminal runtime timed out")),
		} as Runtime;
		expect(
			await drawnAs(listPastSessions(runtime, CODEX, "/work/project")),
		).toMatchObject({
			code: "sessions_unreadable",
			detail:
				"codex app-server did not list its threads: terminal runtime timed out",
		});
	});

	it("says the machine's words when it answers Claude's listing with a failure", async () => {
		const runtime = {
			...fakeRuntime(dir),
			exec: () =>
				Promise.resolve({
					code: 71,
					signal: null,
					stdout: Buffer.alloc(0),
					stderr: Buffer.from("cd: permission denied"),
				}),
		} as Runtime;
		expect(
			await drawnAs(listPastSessions(runtime, CLAUDE, "/work/project")),
		).toMatchObject({
			code: "sessions_unreadable",
			detail: expect.stringContaining(
				"DevHub could not list Claude's sessions in",
			) as string,
		});
	});

	it("says what Codex said when it refuses, or that it ended without answering", () => {
		expect(
			drawnAsSync(() =>
				parseCodexListing(
					'{"id":1,"result":{}}\n{"id":2,"error":{"code":-32600,"message":"no such cwd"}}\n',
					"",
				),
			),
		).toMatchObject({
			code: "sessions_unreadable",
			detail: "codex did not list its threads: no such cwd (-32600)",
		});
		expect(
			drawnAsSync(() => parseCodexListing("", "error: not logged in\n")),
		).toMatchObject({
			code: "sessions_unreadable",
			detail:
				"codex app-server ended without listing its threads: error: not logged in",
		});
	});
});

describe("a session's preview", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "devhub-preview-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("is the last messages of a Claude session, read from the end of its file", async () => {
		const project = join(dir, ".claude", "projects", "-work-project");
		await mkdir(project, { recursive: true });
		const filler = JSON.stringify({
			type: "progress",
			data: "x".repeat(300_000),
		});
		await writeFile(
			join(project, `${SESSION}.jsonl`),
			`${filler}\n${await readFile(FIXTURE, "utf8")}`,
		);
		const preview = await previewPastSession(
			fakeRuntime(dir),
			CLAUDE,
			SESSION,
			"/work/project",
		);
		expect(preview.at(-1)).toEqual({ role: "agent", text: "It is empty." });
		expect(preview.some((line) => line.role === "person")).toBe(true);
		expect(preview.length).toBeLessThanOrEqual(6);
	});

	it("is the last messages of a Codex rollout, found by its thread id", async () => {
		const day = join(dir, ".codex", "sessions", "2026", "09", "20");
		await mkdir(day, { recursive: true });
		const line = (type: string, message: string) =>
			JSON.stringify({ type: "event_msg", payload: { type, message } });
		await writeFile(
			join(day, "rollout-2026-09-20T10-00-00-t-1.jsonl"),
			[
				JSON.stringify({ type: "session_meta", payload: { id: "t-1" } }),
				line("user_message", "Fix the title"),
				JSON.stringify({
					type: "response_item",
					payload: { type: "reasoning" },
				}),
				line("agent_message", "Fixed."),
			].join("\n"),
		);
		expect(
			await previewPastSession(fakeRuntime(dir), CODEX, "t-1", "/work/project"),
		).toEqual([
			{ role: "person", text: "Fix the title" },
			{ role: "agent", text: "Fixed." },
		]);
	});

	it("says it could not read the session's end, as its own failure, when the file is not there", async () => {
		expect(
			await drawnAs(
				previewPastSession(fakeRuntime(dir), CLAUDE, SESSION, "/work/project"),
			),
		).toMatchObject({
			code: "sessions_unreadable",
			detail: expect.stringContaining(
				`DevHub could not read the end of session ${SESSION}`,
			) as string,
		});
	});

	it("refuses an id that is not one, before asking the machine", async () => {
		await expect(
			previewPastSession(fakeRuntime(dir), CLAUDE, "../x", "/work/project"),
		).rejects.toThrow(/not a session id/);
	});
});

describe("the session of a terminal Agent", () => {
	let dir: string;
	const panes: ChildProcess[] = [];
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "devhub-terminal-session-"));
	});
	afterEach(async () => {
		for (const pane of panes.splice(0)) pane.kill("SIGKILL");
		await rm(dir, { recursive: true, force: true });
	});

	/**
	 * A pane running `command` under a shell that does not exec it, as a
	 * profile's wrapper would: the CLI is a child of the pane's process, not
	 * the process itself. Ready once the command has touched `ready`.
	 */
	async function pane(command: string): Promise<number> {
		const ready = join(dir, `ready-${String(panes.length)}`);
		const child = spawn("/bin/sh", ["-c", `${command}; :`], {
			env: { ...process.env, READY: ready },
			stdio: "ignore",
		});
		panes.push(child);
		for (let tries = 0; ; tries += 1) {
			try {
				await readFile(ready);
				return child.pid!;
			} catch (error: unknown) {
				if (tries > 200) throw error;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
	}

	/**
	 * A fake `claude` that keeps Claude's record of its process the way
	 * 2.1.282 does: `<config>/sessions/<its pid>.json`, naming its session.
	 */
	async function fakeClaude(session: string): Promise<string> {
		const script = join(dir, `claude-${session}`);
		await writeFile(
			script,
			`#!/bin/sh
mkdir -p "$CLAUDE_CONFIG_DIR/sessions"
printf '{"pid":%s,"sessionId":"%s","cwd":"/w","kind":"interactive"}' $$ "${session}" >"$CLAUDE_CONFIG_DIR/sessions/$$.json"
: >"$READY"
exec sleep 30
`,
		);
		await chmod(script, 0o755);
		return `CLAUDE_CONFIG_DIR='${join(dir, ".claude")}' '${script}'`;
	}

	/**
	 * A fake `codex` that holds its rollouts open as the TUI does while it
	 * writes a thread: one of its terminal mode's (`source: cli`) and, when
	 * asked, a subagent's beside it.
	 */
	async function fakeCodex(thread: string, subagent?: string): Promise<string> {
		const day = join(dir, ".codex", "sessions", "2026", "09", "26");
		await mkdir(day, { recursive: true });
		const rollout = (id: string, source: unknown) => {
			const path = join(day, `rollout-2026-09-26T10-00-00-${id}.jsonl`);
			return writeFile(
				path,
				`${JSON.stringify({ type: "session_meta", payload: { id, source, cwd: "/w" } })}\n`,
			).then(() => path);
		};
		const main = await rollout(thread, "cli");
		const side =
			subagent === undefined
				? undefined
				: await rollout(subagent, { subagent: { thread_spawn: {} } });
		const script = join(dir, `codex-${thread}`);
		await writeFile(
			script,
			`#!/bin/sh
exec 3<'${main}'
${side === undefined ? "" : `exec 4<'${side}'`}
: >"$READY"
exec sleep 30
`,
		);
		await chmod(script, 0o755);
		return `'${script}'`;
	}

	it("is Claude's record of the process under the Agent's pane, each pane its own", async () => {
		const first = await pane(await fakeClaude("s-first"));
		const second = await pane(await fakeClaude("s-second"));
		expect(await terminalSession(fakeRuntime(dir), CLAUDE, first)).toBe(
			"s-first",
		);
		expect(await terminalSession(fakeRuntime(dir), CLAUDE, second)).toBe(
			"s-second",
		);
	});

	// The owner's case: Claude went on in a new session (after a compaction)
	// without a SessionStart, so what a hook last wrote down — DevHub gave
	// terminal Claudes one until it was taken out, and its file is still in
	// their directories — named the session before. Claude's record followed;
	// it is the one source, and a file beside it is not read.
	it("follows Claude's record when the session changes under a running Claude, whatever an old hook's file says", async () => {
		const running = await pane(await fakeClaude("s-before"));
		const agent = join(dir, "agent");
		await mkdir(agent, { recursive: true });
		await writeFile(
			join(agent, "claude-session"),
			JSON.stringify({ session_id: "s-before", source: "startup" }),
		);
		const sessions = join(dir, ".claude", "sessions");
		const [record] = await readdir(sessions);
		const kept = JSON.parse(
			await readFile(join(sessions, record!), "utf8"),
		) as Record<string, unknown>;
		await writeFile(
			join(sessions, record!),
			JSON.stringify({ ...kept, sessionId: "s-continued" }),
		);
		expect(await terminalSession(fakeRuntime(dir), CLAUDE, running)).toBe(
			"s-continued",
		);
	});

	it("is refused, saying where DevHub looked and why there may be nothing, when no process of the pane has Claude's record", async () => {
		const quiet = await pane(': >"$READY"; exec sleep 30');
		const refusal = terminalSession(fakeRuntime(dir), CLAUDE, quiet);
		await expect(refusal).rejects.toBeInstanceOf(SessionNotResumable);
		await expect(refusal).rejects.toThrow(
			/no process of its pane \(pid \d+\) has Claude's record of it in .*sessions\. .*no longer running in the pane, or when it is a version too old to keep one/,
		);
	});

	it("says it could not read the pane's processes, as its own failure, when the machine does not answer", async () => {
		const runtime = {
			...fakeRuntime(dir),
			exec: () => Promise.reject(new Error("terminal runtime timed out")),
		} as Runtime;
		expect(await drawnAs(terminalSession(runtime, CLAUDE, 1))).toMatchObject({
			code: "sessions_unreadable",
			detail: expect.stringContaining(
				"DevHub could not read the processes of the terminal Agent's pane (pid 1): terminal runtime timed out",
			) as string,
		});
	});

	it("says Claude's record is not what DevHub reads, as its own failure, when it names no session", async () => {
		const sessions = join(dir, ".claude", "sessions");
		const running = await pane(
			`mkdir -p '${sessions}'; printf '{"pid":%s}' $$ >'${sessions}'/$$.json; : >"$READY"; exec sleep 30`,
		);
		expect(
			await drawnAs(terminalSession(fakeRuntime(dir), CLAUDE, running)),
		).toMatchObject({
			code: "sessions_unreadable",
			detail: expect.stringMatching(/names no sessionId$/) as string,
		});
	});

	it("is the Codex thread the Agent's process holds open, each pane its own, never a subagent's", async () => {
		const first = await pane(await fakeCodex("t-first", "t-helper"));
		const second = await pane(await fakeCodex("t-second"));
		expect(await terminalSession(fakeRuntime(dir), CODEX, first)).toBe(
			"t-first",
		);
		expect(await terminalSession(fakeRuntime(dir), CODEX, second)).toBe(
			"t-second",
		);
	});

	it("is refused when the Agent's Codex holds no thread open yet", async () => {
		const quiet = await pane(': >"$READY"; exec sleep 30');
		await expect(
			terminalSession(fakeRuntime(dir), CODEX, quiet),
		).rejects.toThrow(/has no thread open yet/);
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
/** What a failure is drawn as: its code, and the sentence its raiser wrote. */
async function drawnAs(settled: Promise<unknown>) {
	return errorWire(
		await settled.then(
			() => {
				throw new Error("it did not fail");
			},
			(failure: unknown) => failure,
		),
	);
}

function drawnAsSync(run: () => unknown) {
	try {
		run();
	} catch (failure: unknown) {
		return errorWire(failure);
	}
	throw new Error("it did not fail");
}

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
