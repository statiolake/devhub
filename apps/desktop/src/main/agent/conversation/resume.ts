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

/** One earlier session, as the resume picker lists it. */
export interface PastSession {
	/** Claude's session id, Codex's thread id: what the launch resumes. */
	readonly id: string;
	/** Its title, or its first message when it has none. */
	readonly title: string;
	/** When it last changed, in ms since the epoch, if the CLI says. */
	readonly updatedAt: number | undefined;
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

/** The sessions of `profile`'s CLI in the directory `root` on `runtime`, newest first. */
export async function listPastSessions(
	runtime: Runtime,
	profile: SessionProfile,
	root: string,
): Promise<readonly PastSession[]> {
	const kind = resumableKind(profile.kind);
	const cwd = await runtime.realpath(root);
	return kind === "claude"
		? listClaudeSessions(runtime, profile, cwd)
		: listCodexSessions(runtime, profile, cwd);
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
 * The newest session files in `$1`, each as a record separator and its id,
 * then its last timestamp, its last `ai-title` line, and how many candidate
 * first messages follow (the first few `user` lines that are not a tool
 * result or a meta message, each whole). A directory that is not there is a
 * Workspace Claude never ran in: no sessions.
 *
 * awk rather than reading every file here, because a session's file can be
 * tens of megabytes and only these few lines of it are wanted.
 */
const CLAUDE_LISTING_SCRIPT = `[ -d "$1" ] || exit 0
cd -- "$1" || exit 71
ls -t | {
	n=0
	while IFS= read -r f; do
		case $f in *.jsonl) ;; *) continue ;; esac
		n=$((n + 1))
		[ "$n" -le ${LISTED} ] || break
		printf '\\036%s\\n' "\${f%.jsonl}"
		awk '
/"type":"ai-title"/ && length($0) < 4096 { title = $0 }
c < 5 && /"type":"user"/ && !/"tool_use_id"/ && !/"isMeta":true/ && !/"isSidechain":true/ && length($0) < 16384 { first[c++] = $0 }
match($0, /"timestamp":"[^"]*"/) { stamp = substr($0, RSTART + 13, RLENGTH - 14) }
END { print stamp; print title; print c + 0; for (i = 0; i < c; i++) print first[i] }
' "$f" || exit 72
	done
}
`;

async function listClaudeSessions(
	runtime: Runtime,
	profile: SessionProfile,
	cwd: string,
): Promise<readonly PastSession[]> {
	const directory = await claudeProjectDirectory(runtime, profile, cwd);
	const answer = await askMachine(
		runtime,
		`DevHub could not list Claude's sessions in ${directory}`,
	)({
		argv: ["sh", "-c", CLAUDE_LISTING_SCRIPT, "sh", directory],
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
	return parseClaudeListing(answer.stdout.toString("utf8"));
}

/** The listing script's output, as sessions. Exported for its tests. */
export function parseClaudeListing(output: string): readonly PastSession[] {
	const sessions: PastSession[] = [];
	for (const chunk of output.split("\u001e").slice(1)) {
		const [id, stamp, titleLine, count, ...candidates] = chunk.split("\n");
		if (id === undefined || count === undefined) {
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
		sessions.push({
			id,
			title: oneLine(title),
			updatedAt: Number.isNaN(updatedAt) ? undefined : updatedAt,
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
	cwd: string,
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
			params: { cwd, limit: LISTED, sortKey: "updated_at" },
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
			...appServerArgs(profile.args),
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
			}));
		}
	}
	const said = stderr.trim().split("\n").at(-1)?.trim();
	throw new Error(
		`codex app-server ended without listing its threads${said ? `: ${said}` : "."}`,
	);
}
