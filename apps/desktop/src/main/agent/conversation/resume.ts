/**
 * Going on with an earlier session of an Agent's CLI.
 *
 * # One spelling
 *
 * A resumed Agent is an ordinary launch whose profile snapshot ends with what
 * the CLI's terminal mode is told — `--resume <id>` for Claude, `resume <id>`
 * for Codex — the same arguments "continue in terminal" has always appended.
 * They are in the snapshot, so an Agent's record says what it resumed, and a
 * restart of DevHub reads the same answer back from it.
 *
 * Structured mode reads that spelling where it has to differ: Claude's
 * stream-json takes `--resume` as it is, and Codex's `app-server` has no such
 * argument — it resumes by `thread/resume` — so `resumedSession` is the one
 * inverse, and the Codex launch takes the pair off its argv and hands the id
 * to its adapter.
 *
 * # What the CLIs keep
 *
 * The listing is each CLI's own, read on the Workspace's machine:
 *
 * - Codex answers `thread/list` on `app-server`, filtered to the Workspace's
 *   directory. A short-lived app-server is started for the one question.
 * - Claude has no listing command. It keeps each session as JSONL under
 *   `<config>/projects/<cwd with every non-alphanumeric character as ->/`,
 *   which is read here and never written.
 *
 * # History
 *
 * Codex's `thread/resume` answers with the thread's turns, which its adapter
 * already draws. Claude's stream-json with `--resume` prints nothing of the
 * past, so the session's file is read at launch and its conversation — the
 * chain of messages from its last one back to its first — is put at the head
 * of the journal as `devhub_history` lines, before the CLI prints anything.
 * The adapter reads them like every other line, live or replayed, so the
 * history is part of the conversation rather than a second source beside it.
 */

import type { AgentProfile } from "../../../model/domain.js";
import { OperationDeadline } from "../../terminal/command.js";
import { CancellationToken } from "../../terminal/ports.js";
import { RuntimeFileError, type Runtime } from "../../runtime/runtime.js";
import { isTaskNotificationText } from "./claude/decode.js";
import { appServerArgs } from "./codex/argv.js";
import { decodeLine, Reader, threadListResponse } from "./codex/decode.js";
import type { ThreadListParams } from "./codex/protocol/v2/ThreadListParams.js";
import type { ThreadSourceKind } from "./codex/protocol/v2/ThreadSourceKind.js";

/** One earlier session, as the resume picker lists it. */
export interface PastSession {
	/** Claude's session id, Codex's thread id: what the launch resumes. */
	readonly id: string;
	/** Its title, or its first message when it has none. */
	readonly title: string;
	/** When it last changed, in ms since the epoch, if the CLI says. */
	readonly updatedAt: number | undefined;
	/** The directory it ran in, if the CLI says. */
	readonly cwd: string | undefined;
	/**
	 * Whether an Agent in the Workspace listed for can go on with it. Claude
	 * resumes a session only in the directory it ran in (its file is kept
	 * under that directory's name), as its own `/resume` says of another
	 * project's; Codex resumes a thread in any directory it is given.
	 */
	readonly resumableHere: boolean;
}

/**
 * Which sessions a listing offers: the Workspace's directory's, or every
 * directory's on the machine — as the CLIs' own pickers offer both.
 */
export type SessionScope = "here" | "everywhere";

/** A listing's scope as a page said it, checked. */
export function sessionScope(scope: unknown): SessionScope {
	if (scope === "here" || scope === "everywhere") return scope;
	throw new Error(`${JSON.stringify(scope)} is not a scope of sessions`);
}

/** One message of a session's last exchanges, as the picker previews it. */
export interface PreviewLine {
	readonly role: "person" | "agent";
	readonly text: string;
}

/**
 * The session a launch was asked to resume cannot be read back: it is not
 * there, or not whole. The profile cannot start the Agent the way it was
 * asked to — a refusal of the launch, not of the machine it runs on.
 */
export class SessionNotResumable extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionNotResumable";
	}
}

type ResumableKind = Extract<AgentProfile["kind"], "claude" | "codex">;

/** How each CLI's terminal mode is told to go on with a session. */
export function resumeArgs(
	kind: AgentProfile["kind"],
	session: string,
): readonly string[] {
	switch (kind) {
		case "claude":
			return ["--resume", session];
		case "codex":
			return ["resume", session];
		default:
			throw new Error(`a ${kind} Agent has no sessions to resume`);
	}
}

/**
 * The CLI's argv for a session: `args` with every argument that picks a
 * session taken out, and `session` — the arguments that pick this one
 * (`resumeArgs`, a rewind's cut), or none for a new session — at the end.
 *
 * The one place a session is put into an argv: a launch that resumes, a
 * continue, a `/resume` and a rewind all compose theirs here, so an argv
 * that already picked a session (a resumed launch's record, a profile's own
 * `--continue`) never carries two for the CLI to choose between.
 */
export function withSession(
	kind: AgentProfile["kind"],
	args: readonly string[],
	session: readonly string[],
): readonly string[] {
	const kept: string[] = [];
	for (let at = 0; at < args.length; at += 1) {
		const taken = sessionArgumentsAt(kind, args, at);
		if (taken === 0) kept.push(args[at]!);
		else at += taken - 1;
	}
	return [...kept, ...session];
}

/** How many of `args` from `at` on pick a session: 0 when `args[at]` does not. */
function sessionArgumentsAt(
	kind: AgentProfile["kind"],
	args: readonly string[],
	at: number,
): number {
	const arg = args[at]!;
	const next = args[at + 1];
	const withValue = next !== undefined && !next.startsWith("-") ? 2 : 1;
	switch (kind) {
		case "claude":
			if (["--continue", "-c", "--resume-drops-turn"].includes(arg)) return 1;
			if (arg.startsWith("--resume=") || arg.startsWith("--resume-session-at="))
				return 1;
			if (arg === "--resume" || arg === "-r") return withValue;
			if (arg === "--resume-session-at") return 2;
			return 0;
		case "codex":
			if (arg !== "resume") return 0;
			if (next === "--last") return 2;
			return withValue;
		default:
			throw new Error(`a ${kind} Agent has no sessions to pick`);
	}
}

/** The session `resumeArgs` put at the end of `args`, if it put one there. */
export function resumedSession(
	kind: AgentProfile["kind"],
	args: readonly string[],
): string | undefined {
	if (kind !== "claude" && kind !== "codex") return undefined;
	const session = args.at(-1);
	if (args.length < 2 || session === undefined) return undefined;
	return args.at(-2) === resumeArgs(kind, session)[0] ? session : undefined;
}

/** A Codex launch's argv in `app-server` mode, and the thread it resumes. */
export function codexStructuredArgs(args: readonly string[]): {
	readonly args: readonly string[];
	readonly resumeThreadId: string | undefined;
} {
	const resumeThreadId = resumedSession("codex", args);
	return {
		args: appServerArgs(
			resumeThreadId === undefined ? args : args.slice(0, -2),
		),
		resumeThreadId,
	};
}

/** What a listing or a history needs of the profile: its command, as resolved on the machine. */
export type SessionProfile = Pick<
	AgentProfile,
	"kind" | "command" | "args" | "env"
>;

/**
 * The sessions of `profile`'s CLI on `runtime`, newest first: those that ran
 * in the directory `root`, or (`everywhere`) in any directory, each saying
 * whether an Agent in `root` can go on with it.
 */
export async function listPastSessions(
	runtime: Runtime,
	profile: SessionProfile,
	root: string,
	scope: SessionScope = "here",
): Promise<readonly PastSession[]> {
	const kind = resumableKind(profile.kind);
	const cwd = await runtime.realpath(root);
	return kind === "claude"
		? listClaudeSessions(runtime, profile, cwd, scope)
		: listCodexSessions(runtime, profile, {
				cwd,
				scope,
				sourceKinds: undefined,
			});
}

/**
 * The last few messages of session `id` — the person's words and the
 * Agent's answers, not tools — read on demand from the end of its file, so a
 * preview costs the same whatever the session's length. `cwd` is the
 * directory the listing said it ran in (Claude keeps a session under it).
 */
export async function previewPastSession(
	runtime: Runtime,
	profile: SessionProfile,
	id: string,
	cwd: string,
): Promise<readonly PreviewLine[]> {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		throw new Error(`${JSON.stringify(id)} is not a session id`);
	}
	const kind = resumableKind(profile.kind);
	const answer = await askMachine(
		runtime,
		`DevHub could not read the end of session ${id}`,
	)({
		argv:
			kind === "claude"
				? [
						"sh",
						"-c",
						TAIL_SCRIPT,
						"sh",
						`${await claudeProjectDirectory(runtime, profile, cwd)}/${id}.jsonl`,
					]
				: [
						"sh",
						"-c",
						CODEX_ROLLOUT_TAIL_SCRIPT,
						"sh",
						`${await codexHome(runtime, profile)}/sessions`,
						id,
					],
		env: await runtime.environment(),
		deadline: OperationDeadline.in(10_000),
		cancel: new CancellationToken(),
		limits: {
			stdoutBytes: PREVIEW_BYTES + 1024,
			stderrBytes: 16 * 1024,
			overflow: {
				kind: "fail",
				failure: () =>
					new Error(`the end of session ${id} was longer than read`),
			},
		},
	});
	if (answer.code !== 0) {
		throw new Error(
			`DevHub could not read the end of session ${id}${runtime.where}: ${answer.stderr.toString("utf8").trim() || `exit ${String(answer.code ?? answer.signal)}`}`,
		);
	}
	const text = answer.stdout.toString("utf8");
	return kind === "claude" ? claudePreview(text) : codexPreview(text);
}

/** How much of a session's end a preview reads. */
const PREVIEW_BYTES = 256 * 1024;
/** How many messages a preview shows. */
const PREVIEWED = 6;

/** The last `PREVIEW_BYTES` of the file `$1`, whole lines only. */
const TAIL_SCRIPT = `[ -f "$1" ] || { echo "there is no $1" >&2; exit 66; }
tail -c ${PREVIEW_BYTES} -- "$1"
`;

/**
 * The same of thread `$2`'s rollout under `$1`: Codex names each
 * `rollout-<time>-<thread id>.jsonl`, under a directory per day.
 */
const CODEX_ROLLOUT_TAIL_SCRIPT = `f=$(find "$1" -name "rollout-*-$2.jsonl" 2>/dev/null | head -n 1)
[ -n "$f" ] || { echo "there is no rollout of thread $2 under $1" >&2; exit 66; }
tail -c ${PREVIEW_BYTES} -- "$f"
`;

/** The JSON objects among the lines of a file's end; the first, likely cut, is not one. */
function tailRecords(text: string): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			// The first line of a file's end is cut wherever the read began.
			continue;
		}
		if (typeof value === "object" && value !== null && !Array.isArray(value))
			records.push(value as Record<string, unknown>);
	}
	return records;
}

/** A Claude session file's end, as its last messages. Exported for its tests. */
export function claudePreview(text: string): readonly PreviewLine[] {
	const lines: PreviewLine[] = [];
	for (const record of tailRecords(text)) {
		if (record["isSidechain"] === true || record["isMeta"] === true) continue;
		if (record["isCompactSummary"] === true) continue;
		const content = (record["message"] as { content?: unknown } | undefined)
			?.content;
		const said =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter(
								(block): block is { type: "text"; text: string } =>
									typeof block === "object" &&
									block !== null &&
									block.type === "text" &&
									typeof block.text === "string",
							)
							.map((block) => block.text)
							.join("\n")
					: "";
		if (said.trim().length === 0) continue;
		if (record["type"] === "user") lines.push({ role: "person", text: said });
		if (record["type"] === "assistant")
			lines.push({ role: "agent", text: said });
	}
	return lines.slice(-PREVIEWED).map(shortened);
}

/** A Codex rollout's end, as its last messages. Exported for its tests. */
export function codexPreview(text: string): readonly PreviewLine[] {
	const lines: PreviewLine[] = [];
	for (const record of tailRecords(text)) {
		if (record["type"] !== "event_msg") continue;
		const payload = record["payload"] as
			| { type?: unknown; message?: unknown }
			| undefined;
		if (typeof payload?.message !== "string") continue;
		if (payload.type === "user_message")
			lines.push({ role: "person", text: payload.message });
		if (payload.type === "agent_message")
			lines.push({ role: "agent", text: payload.message });
	}
	return lines.slice(-PREVIEWED).map(shortened);
}

function shortened(line: PreviewLine): PreviewLine {
	const text = line.text.trim();
	return {
		role: line.role,
		text: text.length > 600 ? `${text.slice(0, 599)}…` : text,
	};
}

/** Where Codex keeps its state: `CODEX_HOME`, the profile's before the machine's. */
async function codexHome(
	runtime: Runtime,
	profile: SessionProfile,
): Promise<string> {
	return (
		profile.env.get("CODEX_HOME") ??
		(await runtime.environment())["CODEX_HOME"] ??
		`${await runtime.home()}/.codex`
	);
}

// ---------------------------------------------------------------------------
// The session of a terminal Agent.

/** Where a terminal Claude Agent's SessionStart hook writes what Claude told it. */
function claudeSessionRecord(directory: string): string {
	return `${directory}/claude-session`;
}

/**
 * The arguments that have a terminal Claude Agent write down the session it
 * is in, each time one starts: a SessionStart hook, given through
 * `--settings` (added to the person's settings, not in place of them), that
 * copies what Claude hands it — `session_id` among it — into the Agent's own
 * directory `directory`. It fires on startup, on `--resume`, on `/clear` and
 * on `/resume` inside the TUI, so the record is the session on screen, and
 * it prints nothing (a SessionStart hook's output would be read as context).
 */
export function claudeSessionRecorder(directory: string): readonly string[] {
	const record = claudeSessionRecord(directory);
	const command = `cat >${shellQuote(`${record}.new`)} && mv -f ${shellQuote(`${record}.new`)} ${shellQuote(record)}`;
	return [
		"--settings",
		JSON.stringify({
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command }] }],
			},
		}),
	];
}

function shellQuote(word: string): string {
	return `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * The processes of a terminal Agent's pane — the pane's own (`$1`) and every
 * one under it, outermost first — and what each holds of its CLI's session:
 *
 * - `claude`: the record Claude keeps of each running process,
 *   `$3/<pid>.json` (`$3` is `<config>/sessions`), which names the session
 *   the process is in and follows `/clear` and `/resume` inside it;
 * - `codex`: each Codex rollout (`rollout-*.jsonl`) the process holds open —
 *   the threads it is writing — with its modification time and first line
 *   (`session_meta`: the thread's id and what started it).
 *
 * Each record is a header line — kind, pid, modification time, path, by tabs
 * — and the file's first line. The process tree is `ps` where there is one
 * and `/proc` where not (a slim container); open files are `/proc/<pid>/fd`
 * or else `lsof`.
 */
const PANE_PROCESSES_SCRIPT = `pane=$1 kind=$2 dir=$3
if command -v ps >/dev/null 2>&1; then
	table=$(ps -A -o pid= -o ppid=) || exit 70
elif [ -d /proc/self ]; then
	table=$(for s in /proc/[0-9]*/stat; do sed -n 's/^\\([0-9]*\\) (.*) [A-Za-z] \\([0-9]*\\) .*/\\1 \\2/p' "$s" 2>/dev/null; done)
else
	echo "there is neither ps nor /proc to find the processes under pane $pane" >&2
	exit 69
fi
if [ "$kind" = codex ] && [ ! -d /proc/self/fd ] && ! command -v lsof >/dev/null 2>&1; then
	echo "there is neither /proc nor lsof to find the files Codex holds open" >&2
	exit 69
fi
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
printf '%s\\n' "$table" | awk -v root="$pane" '
{ kids[$2] = kids[$2] " " $1 }
END { q[1] = root; n = 1; for (i = 1; i <= n; i++) { print q[i]; m = split(kids[q[i]], c, " "); for (j = 1; j <= m; j++) q[++n] = c[j] } }
' | while read -r pid; do
	if [ "$kind" = claude ]; then
		f="$dir/$pid.json"
		[ -f "$f" ] || continue
		printf 'claude\\t%s\\t\\t%s\\n' "$pid" "$f"
		tr -d '\\n' <"$f"
		echo
	else
		# A descriptor or a process that goes away while it is read is gone,
		# not a failure; lsof failing on a process that is still there is.
		if [ -d "/proc/$pid/fd" ]; then
			open=$(for fd in /proc/"$pid"/fd/*; do readlink "$fd" 2>/dev/null; done)
		elif listed=$(lsof -n -P -Fn -p "$pid"); then
			open=$(printf '%s\\n' "$listed" | sed -n 's/^n//p')
		else
			kill -0 "$pid" 2>/dev/null || continue
			echo "lsof could not list the files process $pid holds open" >&2
			exit 71
		fi
		printf '%s\\n' "$open" | sort -u | while IFS= read -r f; do
			case $f in
			*/rollout-*.jsonl) ;;
			*) continue ;;
			esac
			[ -f "$f" ] || continue
			printf 'codex\\t%s\\t%s\\t%s\\n' "$pid" "$(mtime "$f")" "$f"
			head -n 1 "$f" | head -c 1048576 | tr -d '\\n'
			echo
		done
	fi
done
`;

/** One record `PANE_PROCESSES_SCRIPT` printed. */
interface PaneRecord {
	readonly kind: "claude" | "codex";
	readonly pid: number;
	/** Seconds since the epoch; a Codex rollout's only. */
	readonly mtime: number | undefined;
	readonly path: string;
	readonly line: string;
}

/** What `PANE_PROCESSES_SCRIPT` printed, as records. Exported for its tests. */
export function parsePaneRecords(text: string): readonly PaneRecord[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length % 2 !== 0) {
		throw new Error(
			"the listing of a pane's processes ended between a record's two lines",
		);
	}
	const records: PaneRecord[] = [];
	for (let i = 0; i < lines.length; i += 2) {
		const [kind, pid, mtime, ...path] = lines[i]!.split("\t");
		if ((kind !== "claude" && kind !== "codex") || !/^\d+$/.test(pid ?? "")) {
			throw new Error(
				`the listing of a pane's processes has a record DevHub did not ask for: ${JSON.stringify(lines[i])}`,
			);
		}
		records.push({
			kind,
			pid: Number(pid),
			mtime: mtime === undefined || mtime === "" ? undefined : Number(mtime),
			path: path.join("\t"),
			line: lines[i + 1]!,
		});
	}
	return records;
}

/** Where Claude keeps its state: `CLAUDE_CONFIG_DIR`, the profile's before the machine's. */
async function claudeConfigDirectory(
	runtime: Runtime,
	profile: SessionProfile,
): Promise<string> {
	return (
		profile.env.get("CLAUDE_CONFIG_DIR") ??
		(await runtime.environment())["CLAUDE_CONFIG_DIR"] ??
		`${await runtime.home()}/.claude`
	);
}

/** Ask the machine what the processes of pane `panePid` hold of `kind`'s sessions. */
async function paneRecords(
	runtime: Runtime,
	kind: ResumableKind,
	panePid: number,
	directory: string,
): Promise<readonly PaneRecord[]> {
	const answer = await askMachine(
		runtime,
		`DevHub could not read the processes of the terminal Agent's pane (pid ${String(panePid)})`,
	)({
		argv: [
			"sh",
			"-c",
			PANE_PROCESSES_SCRIPT,
			"sh",
			String(panePid),
			kind,
			directory,
		],
		env: await runtime.environment(),
		deadline: OperationDeadline.in(15_000),
		cancel: new CancellationToken(),
		limits: {
			stdoutBytes: 16 * 1024 * 1024,
			stderrBytes: 16 * 1024,
			overflow: {
				kind: "fail",
				failure: () =>
					new Error(
						`the processes of pane ${String(panePid)} held more than DevHub will read`,
					),
			},
		},
	});
	if (answer.code !== 0) {
		throw new Error(
			`DevHub could not read the processes of the terminal Agent's pane (pid ${String(panePid)})${runtime.where}: ${answer.stderr.toString("utf8").trim() || `exit ${String(answer.code ?? answer.signal)}`}`,
		);
	}
	return parsePaneRecords(answer.stdout.toString("utf8"));
}

/**
 * The session a terminal Agent's CLI is in, for a GUI Agent to go on with,
 * found from the Agent's own processes — the pane's (`panePid`) and those
 * under it — so another terminal of the same CLI in the same directory is
 * never taken for it.
 *
 * Claude: the record Claude keeps of its running process,
 * `<config>/sessions/<pid>.json`, whose `sessionId` follows `/clear` and
 * `/resume` inside the TUI; the outermost Claude under the pane is the
 * Agent's (one it runs is under it). Where no process has that record, what
 * the Agent's SessionStart hook wrote down (`claudeSessionRecorder`) in its
 * directory `directory`. Both there and different is refused: DevHub does
 * not guess between two of Claude's own answers.
 *
 * Codex: the thread whose rollout the Agent's Codex holds open and which its
 * terminal mode started (`session_meta.source` is `cli`; a subagent's is
 * not) — the one written last when the TUI holds several (a thread switched
 * to with `/new` or `/resume` counts from its first turn).
 */
export async function terminalSession(
	runtime: Runtime,
	profile: SessionProfile,
	directory: string,
	panePid: number,
): Promise<string> {
	if (resumableKind(profile.kind) === "claude") {
		const sessions = `${await claudeConfigDirectory(runtime, profile)}/sessions`;
		const [outermost] = await paneRecords(runtime, "claude", panePid, sessions);
		const live =
			outermost === undefined
				? undefined
				: {
						path: outermost.path,
						session: claudeProcessSession(outermost, runtime),
					};
		const hooked = await claudeHookedSession(runtime, directory);
		if (live !== undefined && hooked !== undefined && live.session !== hooked) {
			throw new SessionNotResumable(
				`DevHub cannot tell which Claude session this terminal Agent is in: Claude's record of its process (${live.path}${runtime.where}) says ${live.session}, and its SessionStart hook last wrote ${hooked} (${claudeSessionRecord(directory)}).`,
			);
		}
		const session = live?.session ?? hooked;
		if (session === undefined) {
			throw new SessionNotResumable(
				`DevHub cannot tell which Claude session this terminal Agent is in: no process of its pane (pid ${String(panePid)}) has Claude's record in ${sessions}${runtime.where}, and its SessionStart hook wrote nothing to ${claudeSessionRecord(directory)} (hooks turned off, or the Agent started before DevHub gave it the hook).`,
			);
		}
		return session;
	}
	const threads = (await paneRecords(runtime, "codex", panePid, "")).flatMap(
		(record) => {
			const meta = jsonObject(record, runtime);
			const payload = meta["payload"] as Record<string, unknown> | undefined;
			if (
				meta["type"] !== "session_meta" ||
				typeof payload?.["id"] !== "string"
			) {
				throw new Error(
					`${record.path}${runtime.where} does not begin with a session_meta naming its thread`,
				);
			}
			return payload["source"] === "cli"
				? [{ id: payload["id"], mtime: record.mtime ?? 0 }]
				: [];
		},
	);
	const newest = threads.reduce<(typeof threads)[number] | undefined>(
		(best, thread) =>
			best === undefined || thread.mtime > best.mtime ? thread : best,
		undefined,
	);
	if (newest === undefined) {
		throw new SessionNotResumable(
			`The Codex of this terminal Agent (pane pid ${String(panePid)}${runtime.where}) has no thread open yet: Codex writes a thread from its first turn.`,
		);
	}
	return newest.id;
}

/** The `sessionId` of Claude's record of one of its processes. */
function claudeProcessSession(record: PaneRecord, runtime: Runtime): string {
	const session = jsonObject(record, runtime)["sessionId"];
	if (typeof session !== "string" || session.length === 0) {
		throw new Error(
			`Claude's record ${record.path}${runtime.where} names no sessionId`,
		);
	}
	return session;
}

/** A record's first line, which the CLI writes as one JSON object. */
function jsonObject(
	record: PaneRecord,
	runtime: Runtime,
): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(record.line);
		if (typeof value === "object" && value !== null && !Array.isArray(value))
			return value as Record<string, unknown>;
	} catch {
		// Said below, with the file it is in.
	}
	throw new Error(
		`${record.path}${runtime.where} does not begin with a JSON object`,
	);
}

/** What the Agent's SessionStart hook last wrote down, if it ever did. */
async function claudeHookedSession(
	runtime: Runtime,
	directory: string,
): Promise<string | undefined> {
	let text: string;
	try {
		text = await runtime.readTextFile(
			claudeSessionRecord(directory),
			64 * 1024,
		);
	} catch (failure: unknown) {
		if (failure instanceof RuntimeFileError && failure.code === "ENOENT") {
			return undefined;
		}
		throw failure;
	}
	const session = parsedLine("(the terminal Agent's)", text.trim())[
		"session_id"
	];
	if (typeof session !== "string" || session.length === 0) {
		throw new Error(
			`the session Claude wrote down in ${claudeSessionRecord(directory)}${runtime.where} names no session_id`,
		);
	}
	return session;
}

function resumableKind(kind: AgentProfile["kind"]): ResumableKind {
	if (kind === "claude" || kind === "codex") return kind;
	throw new Error(`a ${kind} profile has no sessions DevHub can list`);
}

/**
 * `runtime.exec`, with a failure to get an answer at all — a deadline, a
 * machine that is not there — said as what was being asked, not as the
 * runtime's own words about itself.
 */
function askMachine(
	runtime: Runtime,
	what: string,
): (request: Parameters<Runtime["exec"]>[0]) => ReturnType<Runtime["exec"]> {
	return async (request) => {
		try {
			return await runtime.exec(request);
		} catch (failure: unknown) {
			throw new Error(
				`${what}${runtime.where}: ${failure instanceof Error ? failure.message : String(failure)}`,
				{ cause: failure },
			);
		}
	};
}

/** How many sessions a listing offers. */
const LISTED = 50;

// ---------------------------------------------------------------------------
// Claude.

/**
 * Where Claude keeps the sessions it ran in `cwd` (a real path).
 *
 * `CLAUDE_CONFIG_DIR` moves the whole of `~/.claude`; the profile's own
 * environment wins over the machine's, as it does for the CLI itself.
 */
async function claudeProjectDirectory(
	runtime: Runtime,
	profile: SessionProfile,
	cwd: string,
): Promise<string> {
	const config = await claudeConfigDirectory(runtime, profile);
	return `${config}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

/**
 * The newest session files in `$1` — down to depth `$2`: 1 for one project's
 * directory, 2 for every project's under `projects/` — each as a record
 * separator and its id, the directory its file is in (`.` at depth 1), then
 * its last timestamp, the directory it ran in, its
 * last `ai-title` line, and how many candidate first messages follow (the
 * first few `user` lines that are not a tool result or a meta message, each
 * whole). A directory that is not there is one Claude never ran in: no
 * sessions.
 *
 * Newest by modification time, across directories: `stat` in GNU's spelling
 * or BSD's, through `find -exec +` so that no number of files is an argument
 * list too long. awk rather than reading every file here, because a session's
 * file can be tens of megabytes and only these few lines of it are wanted.
 */
const CLAUDE_LISTING_SCRIPT = `[ -d "$1" ] || exit 0
cd -- "$1" || exit 71
find . -mindepth "$2" -maxdepth "$2" -name '*.jsonl' -type f -exec sh -c 'stat -c "%Y %n" -- "$@" 2>/dev/null || stat -f "%m %N" -- "$@"' sh {} + |
	sort -rn | {
	n=0
	while IFS= read -r l; do
		f=\${l#* }
		n=$((n + 1))
		[ "$n" -le ${LISTED} ] || break
		b=\${f##*/}
		printf '\\036%s\\n%s\\n' "\${b%.jsonl}" "\${f%/*}"
		awk '
/"type":"ai-title"/ && length($0) < 4096 { title = $0 }
c < 5 && /"type":"user"/ && !/"tool_use_id"/ && !/"isMeta":true/ && !/"isSidechain":true/ && length($0) < 16384 { first[c++] = $0 }
match($0, /"timestamp":"[^"]*"/) { stamp = substr($0, RSTART + 13, RLENGTH - 14) }
cwd == "" && match($0, /"cwd":"([^"\\\\]|\\\\.)*"/) { cwd = substr($0, RSTART, RLENGTH) }
END { print stamp; print cwd; print title; print c + 0; for (i = 0; i < c; i++) print first[i] }
' "$f" || exit 72
	done
}
`;

async function listClaudeSessions(
	runtime: Runtime,
	profile: SessionProfile,
	cwd: string,
	scope: SessionScope,
): Promise<readonly PastSession[]> {
	const here = await claudeProjectDirectory(runtime, profile, cwd);
	const directory =
		scope === "here" ? here : here.slice(0, here.lastIndexOf("/"));
	const answer = await askMachine(
		runtime,
		`DevHub could not list Claude's sessions in ${directory}`,
	)({
		argv: [
			"sh",
			"-c",
			CLAUDE_LISTING_SCRIPT,
			"sh",
			directory,
			scope === "here" ? "1" : "2",
		],
		env: await runtime.environment(),
		deadline: OperationDeadline.in(15_000),
		cancel: new CancellationToken(),
		limits: {
			stdoutBytes: 8 * 1024 * 1024,
			stderrBytes: 16 * 1024,
			overflow: {
				kind: "fail",
				failure: () =>
					new Error(`the listing of ${directory} was longer than expected`),
			},
		},
	});
	if (answer.code !== 0) {
		throw new Error(
			`DevHub could not list Claude's sessions in ${directory}${runtime.where}: ${answer.stderr.toString("utf8").trim() || `exit ${String(answer.code ?? answer.signal)}`}`,
		);
	}
	return parseClaudeListing(
		answer.stdout.toString("utf8"),
		here.slice(here.lastIndexOf("/") + 1),
		cwd,
	);
}

/**
 * The listing script's output, as sessions; `project` is the name of the
 * Workspace's directory `cwd` under `projects/`, the one a session's file
 * must be in for Claude to resume it there — and where one that does not say
 * where it ran did. Exported for its tests.
 */
export function parseClaudeListing(
	output: string,
	project: string,
	cwd: string,
): readonly PastSession[] {
	const sessions: PastSession[] = [];
	for (const chunk of output.split("\u001e").slice(1)) {
		const [id, folder, stamp, cwdField, titleLine, count, ...candidates] =
			chunk.split("\n");
		if (id === undefined || folder === undefined || count === undefined) {
			throw new Error(
				`the listing of Claude's sessions is cut short: ${chunk}`,
			);
		}
		const first = candidates
			.slice(0, Number(count))
			.map((line) => promptOf(id, line))
			.find((text) => text !== undefined);
		const title =
			(titleLine ? titleOf(id, titleLine) : undefined) ?? first ?? undefined;
		// A file with no message a person wrote is a session nobody can go on
		// with — Claude's own `/resume` leaves those out too.
		if (title === undefined) continue;
		const updatedAt = stamp ? Date.parse(stamp) : Number.NaN;
		// Claude finds a session by the directory its file is kept under,
		// whatever its lines say.
		const resumableHere = folder === "." || folder === `./${project}`;
		const ran = cwdField
			? (JSON.parse(`{${cwdField}}`) as { cwd: string }).cwd
			: resumableHere
				? cwd
				: undefined;
		sessions.push({
			id,
			title: oneLine(title),
			updatedAt: Number.isNaN(updatedAt) ? undefined : updatedAt,
			cwd: ran,
			resumableHere,
		});
	}
	return sessions;
}

function parsedLine(id: string, line: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value === "object" && value !== null && !Array.isArray(value))
			return value as Record<string, unknown>;
	} catch {
		// Said below, with the session it is in.
	}
	throw new SessionNotResumable(
		`Claude's session ${id} has a line that is not a JSON object`,
	);
}

function titleOf(id: string, line: string): string | undefined {
	const record = parsedLine(id, line);
	return record["type"] === "ai-title" && typeof record["aiTitle"] === "string"
		? record["aiTitle"]
		: undefined;
}

/** The text a person wrote, if this `user` line is one. */
function promptOf(id: string, line: string): string | undefined {
	const record = parsedLine(id, line);
	if (record["type"] !== "user") return undefined;
	const message = record["message"] as { content?: unknown } | undefined;
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				block.type === "text" &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
	return text.length > 0 ? text : undefined;
}

function oneLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

/** The largest session file DevHub reads back as history. */
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;

/**
 * Claude session `session`'s conversation, as the journal lines its adapter
 * reads as history. Refused, with the reason, when the session is not there
 * or cannot be read whole.
 */
export async function claudeHistory(
	runtime: Runtime,
	profile: SessionProfile,
	root: string,
	session: string,
): Promise<readonly string[]> {
	const directory = await claudeProjectDirectory(
		runtime,
		profile,
		await runtime.realpath(root),
	);
	const path = `${directory}/${session}.jsonl`;
	let text: string;
	try {
		text = await runtime.readTextFile(path, MAX_HISTORY_BYTES + 1);
	} catch (failure: unknown) {
		if (failure instanceof RuntimeFileError && failure.code === "ENOENT") {
			throw new SessionNotResumable(
				`Claude has no session ${session} in ${root}${runtime.where}: there is no ${path}.`,
			);
		}
		throw failure;
	}
	if (Buffer.byteLength(text) > MAX_HISTORY_BYTES) {
		throw new SessionNotResumable(
			`Claude's session ${session} is larger than DevHub reads back (${MAX_HISTORY_BYTES / 1024 / 1024} MiB): ${path}${runtime.where}`,
		);
	}
	return claudeHistoryLines(session, text);
}

/**
 * The conversation a session file holds, as `devhub_history` lines.
 *
 * The file is a tree: every record names its parent, and a rewind leaves the
 * abandoned branch in the file. What Claude resumes is the chain from the
 * last message back to the first, so that is what is drawn — across a
 * compaction too, whose boundary names the message before it as its logical
 * parent. Of the chain, what a live conversation would have shown is kept:
 * the person's and the assistant's messages (not a subagent's, not a meta
 * message Claude adds, not the summary a compaction wrote), the system
 * events (the compaction itself, a command the CLI ran, an away summary —
 * the adapter decides which it draws, as it does live), a message the person
 * queued mid-turn, and a file the person attached or that changed outside
 * the conversation. The other attachments are the CLI's notes to the model
 * (reminders, listings, the environment), which nothing live shows either.
 */
export function claudeHistoryLines(
	session: string,
	text: string,
): readonly string[] {
	const records = text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => parsedLine(session, line));
	// Where each uuid is written. Claude writes some records again under the
	// same uuid (an attachment carried across a compaction), so a uuid can
	// name more than one line.
	const byUuid = new Map<string, number[]>();
	records.forEach((record, position) => {
		const uuid = record["uuid"];
		if (typeof uuid !== "string") return;
		const at = byUuid.get(uuid);
		if (at === undefined) byUuid.set(uuid, [position]);
		else at.push(position);
	});
	const isMessage = (record: Record<string, unknown>) =>
		(record["type"] === "user" || record["type"] === "assistant") &&
		record["isSidechain"] !== true;
	let leaf = records.length - 1;
	while (leaf >= 0 && !isMessage(records[leaf]!)) leaf -= 1;
	// A record's parent was written before it: of the lines a parent uuid
	// names, the chain goes on at the last one above the record. So the walk
	// only ever goes up the file, and ends.
	const chain: Record<string, unknown>[] = [];
	for (let at = leaf; at >= 0; ) {
		const record = records[at]!;
		chain.push(record);
		const parent = record["parentUuid"] ?? record["logicalParentUuid"];
		if (typeof parent !== "string") break;
		const written = byUuid.get(parent);
		if (written === undefined) break;
		const above = [...written].reverse().find((position) => position < at);
		if (above === undefined) {
			throw new SessionNotResumable(
				`Claude's session ${session} names ${parent} as the parent of ${String(record["uuid"])}, but writes it only after it`,
			);
		}
		at = above;
	}
	const history = (fields: Record<string, unknown>) =>
		JSON.stringify({ type: "devhub_history", record: fields });
	return chain.reverse().flatMap((record) => {
		if (record["isSidechain"] === true) return [];
		if (record["type"] === "system") return [history(systemEvent(record))];
		const attachment = record["attachment"] as
			| Record<string, unknown>
			| undefined;
		if (
			record["type"] === "attachment" &&
			(attachment?.["type"] === "file" ||
				attachment?.["type"] === "edited_text_file")
		)
			return [history({ type: "attachment", attachment })];
		// A message the person wrote while a turn ran, which the CLI took in
		// as it went: the person's words, like any other message of theirs.
		if (
			record["type"] === "attachment" &&
			attachment?.["type"] === "queued_command" &&
			taskNotification(record) === undefined
		) {
			return [
				history({
					type: "user",
					uuid: record["uuid"],
					message: { role: "user", content: attachment["prompt"] },
				}),
			];
		}
		// A background task's end, which Claude records as a user message it
		// adds, or as a queued command it took in mid-turn.
		const notification = taskNotification(record);
		if (notification !== undefined) {
			return [
				JSON.stringify({
					type: "devhub_history",
					record: {
						type: "user",
						uuid: record["uuid"],
						message: { role: "user", content: notification },
					},
				}),
			];
		}
		if (
			!isMessage(record) ||
			record["isMeta"] === true ||
			record["isCompactSummary"] === true
		)
			return [];
		return [
			JSON.stringify({
				type: "devhub_history",
				record: {
					type: record["type"],
					uuid: record["uuid"],
					message: record["message"],
					// Whether a call only started its task in the background, in the
					// field stream-json prints it in.
					...(record["toolUseResult"] === undefined
						? {}
						: { tool_use_result: record["toolUseResult"] }),
				},
			}),
		];
	});
}

/**
 * A session file's system record, in the shape stream-json prints the same
 * event: the compaction's metadata under the name and keys the wire uses.
 */
function systemEvent(record: Record<string, unknown>): Record<string, unknown> {
	const { compactMetadata, ...rest } = record;
	if (compactMetadata === undefined || compactMetadata === null) return rest;
	const metadata = compactMetadata as Record<string, unknown>;
	return {
		...rest,
		compact_metadata: {
			trigger: metadata["trigger"],
			pre_tokens: metadata["preTokens"],
		},
	};
}

/** The `<task-notification>` a top-level record of a session file carries, if it carries one. */
function taskNotification(record: Record<string, unknown>): string | undefined {
	if (record["isSidechain"] === true) return undefined;
	const content =
		record["type"] === "user"
			? (record["message"] as Record<string, unknown> | undefined)?.["content"]
			: record["type"] === "attachment"
				? (record["attachment"] as Record<string, unknown> | undefined)?.[
						"type"
					] === "queued_command"
					? (record["attachment"] as Record<string, unknown>)["prompt"]
					: undefined
				: undefined;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.flatMap((block: unknown) =>
							typeof block === "object" &&
							block !== null &&
							(block as Record<string, unknown>)["type"] === "text" &&
							typeof (block as Record<string, unknown>)["text"] === "string"
								? [(block as Record<string, unknown>)["text"] as string]
								: [],
						)
						.join("\n")
				: undefined;
	return text !== undefined && isTaskNotificationText(text) ? text : undefined;
}

// ---------------------------------------------------------------------------
// Codex.

/**
 * `app-server` answers on stdin that stays open: at end of input it exits
 * without answering what is still in flight. So the requests go in, and the
 * input is held open until the answer to `thread/list` (id 2) has come out —
 * or the server has ended — and then closed, which ends the server. The
 * answer is recognised by its top-level id, first or last in the object and
 * however the JSON is spaced; a pattern tied to one serializer's spacing left
 * the input open until the deadline.
 */
const CODEX_LISTING_SCRIPT = `d=$(mktemp -d) || exit 70
trap 'rm -rf "$d"' EXIT
{ cat; until [ -e "$d/done" ]; do sleep 0.1; done; } | "$@" | {
	while IFS= read -r l; do
		printf '%s\\n' "$l"
		printf '%s\\n' "$l" | grep -Eq '^[{][[:space:]]*"id"[[:space:]]*:[[:space:]]*2[[:space:]]*[,}]|[,{][[:space:]]*"id"[[:space:]]*:[[:space:]]*2[[:space:]]*[}][[:space:]]*$' && break
	done
	: >"$d/done"
}
`;

async function listCodexSessions(
	runtime: Runtime,
	profile: SessionProfile,
	asked: {
		readonly cwd: string;
		readonly scope: SessionScope;
		/** Only threads of these sources; absent, Codex's own default (the interactive ones). */
		readonly sourceKinds: readonly ThreadSourceKind[] | undefined;
		readonly limit?: number;
	},
): Promise<readonly PastSession[]> {
	const requests = [
		{
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "devhub", version: "0" } },
		},
		{ method: "initialized" },
		{
			id: 2,
			method: "thread/list",
			params: {
				...(asked.scope === "here" ? { cwd: asked.cwd } : {}),
				limit: asked.limit ?? LISTED,
				sortKey: "updated_at",
				...(asked.sourceKinds === undefined
					? {}
					: { sourceKinds: [...asked.sourceKinds] }),
			} satisfies ThreadListParams,
		},
	];
	const answer = await askMachine(
		runtime,
		`codex app-server did not list its threads`,
	)({
		argv: [
			"sh",
			"-c",
			CODEX_LISTING_SCRIPT,
			"sh",
			profile.command,
			// A resumed Agent's snapshot ends with the thread it resumed, which
			// app-server takes no argument for.
			...codexStructuredArgs(profile.args).args,
		],
		env: {
			...(await runtime.environment()),
			...Object.fromEntries(profile.env),
		},
		stdin: Buffer.from(
			requests.map((each) => `${JSON.stringify(each)}\n`).join(""),
		),
		deadline: OperationDeadline.in(30_000),
		cancel: new CancellationToken(),
		limits: {
			stdoutBytes: 16 * 1024 * 1024,
			stderrBytes: 16 * 1024,
			overflow: {
				kind: "fail",
				failure: () =>
					new Error("codex's thread list was longer than expected"),
			},
		},
	});
	return parseCodexListing(
		answer.stdout.toString("utf8"),
		answer.stderr.toString("utf8"),
	);
}

/** app-server's lines, as sessions. Exported for its tests. */
export function parseCodexListing(
	stdout: string,
	stderr: string,
): readonly PastSession[] {
	const reader = new Reader(undefined);
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		const message = decodeLine(reader, line);
		if (message.kind === "error" && (message.id === 1 || message.id === 2)) {
			throw new Error(
				`codex did not list its threads: ${message.message} (${message.code})`,
			);
		}
		if (message.kind === "response" && message.id === 2) {
			return threadListResponse(reader, message.result).map((thread) => ({
				id: thread.id,
				title: oneLine(thread.name ?? thread.preview),
				updatedAt: thread.updatedAt * 1000,
				cwd: thread.cwd,
				resumableHere: true,
			}));
		}
	}
	const said = stderr.trim().split("\n").at(-1)?.trim();
	throw new Error(
		`codex app-server ended without listing its threads${said ? `: ${said}` : "."}`,
	);
}
