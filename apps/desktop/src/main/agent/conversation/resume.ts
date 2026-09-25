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
 * The session a terminal Agent's CLI is in, for a GUI Agent to go on with.
 *
 * Claude: what its SessionStart hook wrote down (`claudeSessionRecorder`) in
 * the Agent's directory `directory`. Codex, which has no such hook: the
 * newest thread its terminal mode (`cli`) keeps for `root` — the one the
 * Agent's TUI writes to, provided it is the only Codex TUI in that directory,
 * which the caller checks.
 */
export async function terminalSession(
	runtime: Runtime,
	profile: SessionProfile,
	root: string,
	directory: string,
): Promise<string> {
	if (resumableKind(profile.kind) === "claude") {
		let text: string;
		try {
			text = await runtime.readTextFile(
				claudeSessionRecord(directory),
				64 * 1024,
			);
		} catch (failure: unknown) {
			if (failure instanceof RuntimeFileError && failure.code === "ENOENT") {
				throw new SessionNotResumable(
					"This terminal Agent has not said which Claude session it is in: Claude tells DevHub when a session starts, and this one started before DevHub asked it to (or its hooks are turned off). Use New Agent › Resume a Claude session… instead.",
				);
			}
			throw failure;
		}
		const record = parsedLine("(the terminal Agent's)", text.trim());
		const session = record["session_id"];
		if (typeof session !== "string" || session.length === 0) {
			throw new Error(
				`the session Claude wrote down in ${claudeSessionRecord(directory)}${runtime.where} names no session_id`,
			);
		}
		return session;
	}
	const [newest] = await listCodexSessions(runtime, profile, {
		cwd: await runtime.realpath(root),
		scope: "here",
		sourceKinds: ["cli"],
		limit: 1,
	});
	if (newest === undefined) {
		throw new SessionNotResumable(
			`Codex keeps no terminal thread for ${root}${runtime.where} yet: the terminal Agent names one with its first turn.`,
		);
	}
	return newest.id;
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
	const config =
		profile.env.get("CLAUDE_CONFIG_DIR") ??
		(await runtime.environment())["CLAUDE_CONFIG_DIR"] ??
		`${await runtime.home()}/.claude`;
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
 * parent. Of the chain, only the messages are kept: the person's and the
 * assistant's, not a subagent's (sidechain), not a meta message Claude adds,
 * not the summary a compaction wrote.
 */
export function claudeHistoryLines(
	session: string,
	text: string,
): readonly string[] {
	const records = text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => parsedLine(session, line));
	const byUuid = new Map<string, Record<string, unknown>>();
	for (const record of records) {
		if (typeof record["uuid"] === "string") byUuid.set(record["uuid"], record);
	}
	const isMessage = (record: Record<string, unknown>) =>
		(record["type"] === "user" || record["type"] === "assistant") &&
		record["isSidechain"] !== true;
	const leaf = [...records].reverse().find(isMessage);
	const chain: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	for (let at = leaf; at !== undefined; ) {
		const uuid = at["uuid"] as string;
		if (seen.has(uuid)) {
			throw new SessionNotResumable(
				`Claude's session ${session} has a cycle at ${uuid}`,
			);
		}
		seen.add(uuid);
		chain.push(at);
		const parent = at["parentUuid"] ?? at["logicalParentUuid"];
		at = typeof parent === "string" ? byUuid.get(parent) : undefined;
	}
	return chain
		.reverse()
		.filter(
			(record) =>
				isMessage(record) &&
				record["isMeta"] !== true &&
				record["isCompactSummary"] !== true,
		)
		.map((record) =>
			JSON.stringify({
				type: "devhub_history",
				record: {
					type: record["type"],
					uuid: record["uuid"],
					message: record["message"],
				},
			}),
		);
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
