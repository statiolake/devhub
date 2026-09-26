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
	claudeSessionRecorder,
	listPastSessions,
	parseCodexListing,
	previewPastSession,
	terminalSession,
	resumeArgs,
	resumedSession,
	withSession,
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

	it("is refused, naming both, when a record's parent is written only after it", () => {
		const line = (fields: Record<string, unknown>) =>
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "x" },
				...fields,
			});
		expect(() =>
			claudeHistoryLines(
				SESSION,
				[
					line({ uuid: "u1", parentUuid: null }),
					line({ uuid: "u3", parentUuid: "u2" }),
					line({ uuid: "u2", parentUuid: "u1" }),
					line({ uuid: "u4", parentUuid: "u3" }),
				].join("\n"),
			),
		).toThrow("names u2 as the parent of u3, but writes it only after it");
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
	*'"thread/list"'*) { sleep 0.3; printf '%s\\n' '{"method":"note","params":{}}' '{"id": 2, "result": {"data":[{"id":"t-new","preview":"Fix it","name":"Named","updatedAt":20,"cwd":"/work/project"},{"id":"t-old","preview":"First\\nmessage","name":null,"updatedAt":10,"cwd":"/work/elsewhere"}],"nextCursor":null,"backwardsCursor":null}}'; } & pending=$! ;;
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
		await expect(
			listPastSessions(runtime, CODEX, "/work/project"),
		).rejects.toThrow(
			"codex app-server did not list its threads: terminal runtime timed out",
		);
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

	/** Run the SessionStart hook DevHub gives a terminal Claude, as Claude runs it. */
	async function hookWrites(agent: string, session: string): Promise<void> {
		await mkdir(agent, { recursive: true });
		const [flag, settings] = claudeSessionRecorder(agent);
		expect(flag).toBe("--settings");
		const hook = (
			JSON.parse(settings!) as {
				hooks: { SessionStart: { hooks: { command: string }[] }[] };
			}
		).hooks.SessionStart[0]!.hooks[0]!.command;
		// Under a shell, the event's JSON on stdin.
		await new Promise<void>((resolve, reject) => {
			const child = execFile("/bin/sh", ["-c", hook], (error) =>
				error ? reject(error) : resolve(),
			);
			child.stdin!.end(
				JSON.stringify({ session_id: session, source: "clear", cwd: "/w" }),
			);
		});
	}

	it("is Claude's record of the process under the Agent's pane, each pane its own", async () => {
		const first = await pane(await fakeClaude("s-first"));
		const second = await pane(await fakeClaude("s-second"));
		const agent = join(dir, "agent");
		expect(await terminalSession(fakeRuntime(dir), CLAUDE, agent, first)).toBe(
			"s-first",
		);
		expect(await terminalSession(fakeRuntime(dir), CLAUDE, agent, second)).toBe(
			"s-second",
		);
	});

	it("is what Claude's SessionStart hook wrote down when no process of the pane has Claude's record", async () => {
		const agent = join(dir, "agent's dir");
		await hookWrites(agent, "s-live");
		const quiet = await pane(': >"$READY"; exec sleep 30');
		expect(await terminalSession(fakeRuntime(dir), CLAUDE, agent, quiet)).toBe(
			"s-live",
		);
	});

	it("agrees with the hook when both are there, and is refused, naming both, when they differ", async () => {
		const agent = join(dir, "agent");
		const running = await pane(await fakeClaude("s-now"));
		await hookWrites(agent, "s-now");
		expect(
			await terminalSession(fakeRuntime(dir), CLAUDE, agent, running),
		).toBe("s-now");
		await hookWrites(agent, "s-before");
		await expect(
			terminalSession(fakeRuntime(dir), CLAUDE, agent, running),
		).rejects.toThrow(
			/says s-now, and its SessionStart hook last wrote s-before/,
		);
	});

	it("is refused, saying where DevHub looked, when neither is there", async () => {
		const quiet = await pane(': >"$READY"; exec sleep 30');
		await expect(
			terminalSession(fakeRuntime(dir), CLAUDE, join(dir, "none"), quiet),
		).rejects.toThrow(
			/no process of its pane \(pid \d+\) has Claude's record in .*sessions, and its SessionStart hook wrote nothing/,
		);
	});

	it("is the Codex thread the Agent's process holds open, each pane its own, never a subagent's", async () => {
		const first = await pane(await fakeCodex("t-first", "t-helper"));
		const second = await pane(await fakeCodex("t-second"));
		expect(await terminalSession(fakeRuntime(dir), CODEX, "", first)).toBe(
			"t-first",
		);
		expect(await terminalSession(fakeRuntime(dir), CODEX, "", second)).toBe(
			"t-second",
		);
	});

	it("is refused when the Agent's Codex holds no thread open yet", async () => {
		const quiet = await pane(': >"$READY"; exec sleep 30');
		await expect(
			terminalSession(fakeRuntime(dir), CODEX, "", quiet),
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
