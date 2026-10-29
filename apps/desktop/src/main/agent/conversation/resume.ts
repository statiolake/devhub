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
import { SessionNotResumable, SessionsUnreadable } from "./failures.js";
import { appServerArgs } from "./codex/argv.js";
import { decodeLine, Reader, threadListResponse } from "./codex/decode.js";
import type { ThreadListParams } from "./codex/protocol/v2/ThreadListParams.js";
import type { ThreadSourceKind } from "./codex/protocol/v2/ThreadSourceKind.js";
import { failureText } from "../../../model/wire.js";

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
	/** The git branch it was last on, if the CLI recorded one. */
	readonly branch: string | undefined;
	/**
	 * Whether an Agent in the Workspace listed for can go on with it. Claude
	 * resumes a session only in the directory it ran in (its file is kept
	 * under that directory's name), as its own `/resume` says of another
	 * project's; Codex resumes a thread in any directory it is given.
	 */
	readonly resumableHere: boolean;
	/**
	 * It ran in another worktree of the Workspace's repository: which one.
	 * Set only by a listing told about the repository (`ListingContext`).
	 */
	readonly worktree?: SessionWorktree;
	/** The name a person gave the Agent that ran it (`model/sessionNames.ts`). */
	readonly agentName?: string;
}

/** The worktree a session ran in, when it is not the Workspace's own. */
export interface SessionWorktree {
	/** Its folder: where it is, or was. */
	readonly root: string;
	/** The branch checked out there, or the one the CLI last recorded. */
	readonly branch?: string;
	/** The folder is still one of the repository's worktrees. */
	readonly present: boolean;
}

/**
 * What a listing knows beyond the CLI's own store: the repository the
 * Workspace is a checkout of, and the names people gave the Agents.
 */
export interface ListingContext {
	readonly repository?: RepositoryWorktrees;
	/** The name given to the Agent that ran this CLI's `session`, if one was. */
	readonly nameOf?: (session: string) => string | undefined;
}

/**
 * The repository's checkouts, as `git worktree list` gives them (real paths),
 * and the prefix DevHub's own worktrees of it start with
 * (`worktreeSiblingPrefix`) — which still says a session ran in one of them
 * once its folder has been removed.
 */
export interface RepositoryWorktrees {
	readonly worktrees: readonly {
		readonly path: string;
		readonly branch?: string;
	}[];
	readonly siblingPrefix: string;
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
	context: ListingContext = {},
): Promise<readonly PastSession[]> {
	const kind = resumableKind(profile.kind);
	const cwd = await runtime.realpath(root);
	const repository = context.repository;
	const listed =
		kind === "claude"
			? await listClaudeSessions(runtime, profile, cwd, scope, repository)
			: await listCodexSessions(runtime, profile, {
					cwd,
					scope,
					sourceKinds: undefined,
					repository,
				});
	const placed =
		repository === undefined
			? listed
			: placeSessions(kind, listed, cwd, repository, scope);
	const nameOf = context.nameOf;
	return nameOf === undefined
		? placed
		: placed.map((session) => {
				const agentName = nameOf(session.id);
				return agentName === undefined ? session : { ...session, agentName };
			});
}

/** `path` is `root` or a folder under it. */
function within(root: string, path: string): boolean {
	const base = root.replace(/\/+$/u, "");
	return path === base || path.startsWith(`${base}/`);
}

/**
 * Sessions of a repository's checkouts, each said to be the Workspace's own
 * or another worktree's. Exported for its tests.
 *
 * Which checkout a session ran in is the deepest worktree its directory is
 * in, so a worktree nested inside the repository's folder is its own. One in
 * none of them that ran under DevHub's worktree prefix ran in a worktree that
 * has since been removed: the folder under the prefix it ran in is that
 * worktree's. For Claude, a session kept under the Workspace's own directory
 * is the Workspace's whatever its lines say, since that is where Claude finds
 * it. Listing `here`, a session of none of the repository's checkouts is not
 * offered; listing `everywhere`, it is, as it was.
 */
export function placeSessions(
	kind: ResumableKind,
	sessions: readonly PastSession[],
	root: string,
	repository: RepositoryWorktrees,
	scope: SessionScope,
): readonly PastSession[] {
	const placed: PastSession[] = [];
	for (const session of sessions) {
		const cwd = session.cwd;
		const owner =
			cwd === undefined
				? undefined
				: repository.worktrees
						.filter((worktree) => within(worktree.path, cwd))
						.reduce<
							RepositoryWorktrees["worktrees"][number] | undefined
						>((deepest, worktree) => (deepest === undefined || worktree.path.length > deepest.path.length ? worktree : deepest), undefined);
		const here =
			kind === "claude"
				? session.resumableHere
				: owner !== undefined
					? owner.path === root
					: cwd !== undefined && within(root, cwd);
		if (here) {
			placed.push({ ...session, resumableHere: true });
			continue;
		}
		if (owner !== undefined) {
			const branch = owner.branch ?? session.branch;
			placed.push({
				...session,
				resumableHere: false,
				worktree: {
					root: owner.path,
					...(branch === undefined ? {} : { branch }),
					present: true,
				},
			});
			continue;
		}
		const prefix = repository.siblingPrefix;
		if (cwd !== undefined && cwd.startsWith(prefix)) {
			const segment = cwd.slice(prefix.length).split("/")[0] ?? "";
			if (segment.length > 0) {
				placed.push({
					...session,
					resumableHere: false,
					worktree: {
						root: `${prefix}${segment}`,
						...(session.branch === undefined ? {} : { branch: session.branch }),
						present: false,
					},
				});
				continue;
			}
		}
		if (scope === "everywhere") placed.push(session);
	}
	return placed;
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
		throw new SessionsUnreadable(
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
export async function codexHome(
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

/**
 * The processes of a terminal Agent's pane — the pane's own (`$1`) and every
 * one under it, outermost first — and what each holds of its CLI's session:
 *
 * - `claude`: the record Claude keeps of each running process,
 *   `$3/<pid>.json` (`$3` is `<config>/sessions`), which names the session
 *   the process is in and follows `/clear` and `/resume` inside it;
 * - `codex`: each Codex rollout (`rollout-*.jsonl`) the process holds open —
 *   the threads it is writing — with its modification time and first line
 *   (`session_meta`: the thread's id and what started it). Every process
 *   looked at is a `proc` record too (its command), and what could not be
 *   looked at a `note`, so that a pane with no thread says what was there.
 *
 * Each record is a header line — kind, pid, modification time, path (a
 * `proc`'s command, a `note`'s text), by tabs — and the file's first line
 * (empty for a `proc` or a `note`). The process tree is `ps` where there is
 * one and `/proc` where not (a slim container); open files are
 * `/proc/<pid>/fd` or else `lsof` (macOS; `$4` = `lsof` takes that way where
 * there is `/proc` too, for its tests).
 *
 * `lsof` is asked once for every process of the pane: one call is a fraction
 * of a second where one per process — Codex runs MCP servers and commands
 * under it — could take long enough on a busy Mac to run past the deadline.
 * It exits non-zero when one of them has gone (or is a zombie) by the time it
 * looks, which is a `note`, not a failure: the rest it listed still stand. A
 * descriptor or a process that goes away while it is read is gone, too.
 */
const PANE_PROCESSES_SCRIPT = `pane=$1 kind=$2 dir=$3 files=\${4:-}
if command -v ps >/dev/null 2>&1; then
	table=$(ps -A -o pid= -o ppid= -o comm=) || exit 70
elif [ -d /proc/self ]; then
	table=$(for s in /proc/[0-9]*/stat; do sed -n 's/^\\([0-9]*\\) (\\(.*\\)) [A-Za-z] \\([0-9]*\\) .*/\\1 \\3 \\2/p' "$s" 2>/dev/null; done)
else
	echo "there is neither ps nor /proc to find the processes under pane $pane" >&2
	exit 69
fi
if [ "$kind" = codex ] && [ ! -d /proc/self/fd ] && ! command -v lsof >/dev/null 2>&1; then
	echo "there is neither /proc nor lsof to find the files Codex holds open" >&2
	exit 69
fi
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
tree=$(printf '%s\\n' "$table" | awk -v root="$pane" '
{ cmd = $0; sub(/^[ \\t]*[0-9]+[ \\t]+[0-9]+[ \\t]*/, "", cmd); name[$1] = cmd; kids[$2] = kids[$2] " " $1 }
END { q[1] = root; n = 1; for (i = 1; i <= n; i++) { print q[i] " " name[q[i]]; m = split(kids[q[i]], c, " "); for (j = 1; j <= m; j++) q[++n] = c[j] } }
')
if [ "$kind" = claude ]; then
	printf '%s\\n' "$tree" | while read -r pid comm; do
		f="$dir/$pid.json"
		[ -f "$f" ] || continue
		printf 'claude\\t%s\\t\\t%s\\n' "$pid" "$f"
		tr -d '\\n' <"$f"
		echo
	done
	exit 0
fi
printf '%s\\n' "$tree" | while read -r pid comm; do
	printf 'proc\\t%s\\t\\t%s\\n\\n' "$pid" "$comm"
done
rollouts() { awk -v p="$1" '/\\/rollout-[^\\/]*\\.jsonl$/ { print p "\\t" $0 }'; }
if [ -d /proc/self/fd ] && [ "$files" != lsof ]; then
	open=$(printf '%s\\n' "$tree" | while read -r pid comm; do
		for fd in /proc/"$pid"/fd/*; do readlink "$fd" 2>/dev/null; done | rollouts "$pid"
	done)
else
	pids=$(printf '%s\\n' "$tree" | awk '{ printf "%s%s", (NR > 1 ? "," : ""), $1 }')
	listed=$(lsof -n -P -Fn -p "$pids" 2>/dev/null)
	status=$?
	open=$(printf '%s\\n' "$listed" | awk '/^p/ { p = substr($0, 2); next } /^n/ && p != "" { f = substr($0, 2); if (f ~ /\\/rollout-[^\\/]*\\.jsonl$/) print p "\\t" f }')
	[ "$status" -eq 0 ] || printf 'note\\t\\t\\tlsof exited %s listing the files of processes %s\\n\\n' "$status" "$pids"
fi
printf '%s\\n' "$open" | sort -u | while IFS='\t' read -r pid f; do
	[ -n "$f" ] && [ -f "$f" ] || continue
	printf 'codex\\t%s\\t%s\\t%s\\n' "$pid" "$(mtime "$f")" "$f"
	head -n 1 "$f" | head -c 1048576 | tr -d '\\n'
	echo
done
`;

/** One record `PANE_PROCESSES_SCRIPT` printed. */
interface PaneRecord {
	readonly kind: "claude" | "codex" | "proc" | "note";
	/** Absent for a `note` about no one process. */
	readonly pid: number | undefined;
	/** Seconds since the epoch; a Codex rollout's only. */
	readonly mtime: number | undefined;
	/** The file; a `proc`'s command, a `note`'s text. */
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
		if (
			(kind !== "claude" &&
				kind !== "codex" &&
				kind !== "proc" &&
				kind !== "note") ||
			!(/^\d+$/.test(pid ?? "") || (kind === "note" && pid === ""))
		) {
			throw new Error(
				`the listing of a pane's processes has a record DevHub did not ask for: ${JSON.stringify(lines[i])}`,
			);
		}
		records.push({
			kind,
			pid: pid === "" ? undefined : Number(pid),
			mtime: mtime === undefined || mtime === "" ? undefined : Number(mtime),
			path: path.join("\t"),
			line: lines[i + 1]!,
		});
	}
	return records;
}

/** Where Claude keeps its state: `CLAUDE_CONFIG_DIR`, the profile's before the machine's. */
export async function claudeConfigDirectory(
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
	files: "auto" | "lsof" = "auto",
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
			files === "lsof" ? "lsof" : "",
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
		throw new SessionsUnreadable(
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
 * `<config>/sessions/<pid>.json`, whose `sessionId` follows the session the
 * TUI is in — `/clear`, `/resume`, and a session it goes on in after a
 * compaction; the outermost Claude under the pane is the Agent's (one it runs
 * is under it). It is the one source: Claude's own word, read where Claude
 * keeps it. A pane none of whose processes has one — no Claude running in it,
 * or a Claude too old to keep the record — is refused, saying where DevHub
 * looked.
 *
 * Codex: the thread whose rollout the Agent's Codex holds open (its file
 * descriptor: Codex's own word, not a guess from times or directories) —
 * `codexPaneThread` says which when it holds several. Refused, saying what
 * was in the pane, when it holds none: it writes a thread from its first turn.
 *
 * Nothing of it is kept: each ask looks again, so a thread that was not open
 * yet a moment ago is found the next time.
 *
 * `files` = `lsof` reads open files with `lsof` (as on macOS) where there is
 * `/proc` too; for its tests.
 */
export async function terminalSession(
	runtime: Runtime,
	profile: SessionProfile,
	panePid: number,
	files: "auto" | "lsof" = "auto",
): Promise<string> {
	if (resumableKind(profile.kind) === "claude") {
		const sessions = `${await claudeConfigDirectory(runtime, profile)}/sessions`;
		const [outermost] = await paneRecords(runtime, "claude", panePid, sessions);
		if (outermost === undefined) {
			throw new SessionNotResumable(
				`DevHub cannot tell which Claude session this terminal Agent is in: no process of its pane (pid ${String(panePid)}${runtime.where}) has Claude's record of it in ${sessions}. Claude keeps one (<pid>.json) for as long as it runs in a terminal; there is none when Claude is no longer running in the pane, or when it is a version too old to keep one.`,
			);
		}
		return claudeProcessSession(outermost, runtime);
	}
	return codexPaneThread(
		await paneRecords(runtime, "codex", panePid, "", files),
		`pane pid ${String(panePid)}${runtime.where}`,
	);
}

/** `rollout-<time>-<thread id>.jsonl`: the thread's id, from the file's name. */
const ROLLOUT_NAME =
	/(?:^|\/)rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([^/]+)\.jsonl$/;

/**
 * Whether a `session_meta.source` is a subagent's — a thread Codex spawned
 * under the one the person is in (`thread_spawn`, a review, a compaction, a
 * memory consolidation). Spelled `subagent` in the rollouts Codex writes and
 * `subAgent` on the wire; either, as a key or a kind's name.
 */
function isSubagentSource(source: unknown): boolean {
	const subagent = (name: string) =>
		name.replace(/[_-]/g, "").toLowerCase().startsWith("subagent");
	if (typeof source === "string") return subagent(source);
	return (
		typeof source === "object" &&
		source !== null &&
		Object.keys(source).some(subagent)
	);
}

/**
 * The thread the Codex of a pane is in, from what its processes hold open
 * (`PANE_PROCESSES_SCRIPT`'s `codex` records); `where` names the pane in what
 * is said when there is none. Exported for its tests.
 *
 * Any thread but a subagent's: its rollout's `session_meta.source` is the
 * one that started it, so a thread begun in a GUI Agent (`vscode`,
 * `appServer`), in the Codex app or by `codex exec` and resumed in the TUI is
 * the TUI's as much as one it began itself (`cli`). Of several, the one
 * written last (a thread switched to with `/new` or `/resume` counts from its
 * first turn). A rollout whose first line cannot be read — Codex is writing
 * it this moment, or it is longer than DevHub reads — is still the thread its
 * file's name says, taken only when no other is readable.
 */
export function codexPaneThread(
	records: readonly PaneRecord[],
	where: string,
): string {
	const readable: { id: string; mtime: number }[] = [];
	const unread: { id: string; mtime: number }[] = [];
	const passed: string[] = [];
	for (const record of records) {
		if (record.kind !== "codex") continue;
		const named = ROLLOUT_NAME.exec(record.path)?.[1];
		const mtime = record.mtime ?? 0;
		const payload = sessionMeta(record.line);
		if (payload === undefined) {
			if (named !== undefined) unread.push({ id: named, mtime });
			passed.push(`${record.path} (its first line is not a session_meta)`);
			continue;
		}
		if (isSubagentSource(payload.source)) {
			passed.push(`${record.path} (a subagent's)`);
			continue;
		}
		readable.push({ id: payload.id, mtime });
	}
	const newest = (threads: readonly { id: string; mtime: number }[]) =>
		threads.reduce<(typeof threads)[number] | undefined>(
			(best, thread) =>
				best === undefined || thread.mtime > best.mtime ? thread : best,
			undefined,
		);
	const found = newest(readable) ?? newest(unread);
	if (found !== undefined) return found.id;
	const processes = records
		.filter((record) => record.kind === "proc")
		.map((record) => `${record.path || "?"} (${String(record.pid)})`);
	const notes = records
		.filter((record) => record.kind === "note")
		.map((record) => record.path);
	const codexRuns = processes.some((each) => /codex/i.test(each));
	throw new SessionNotResumable(
		[
			`The Codex of this terminal Agent (${where}) has no thread open yet: Codex writes a thread from its first turn.`,
			codexRuns
				? ""
				: "No process in the pane is Codex: it may have exited, or not have started yet.",
			`Processes looked at: ${processes.join(", ") || "none"}.`,
			passed.length > 0
				? `Rollouts open but not taken: ${passed.join("; ")}.`
				: "",
			notes.length > 0 ? `${notes.join("; ")}.` : "",
		]
			.filter((part) => part !== "")
			.join(" "),
	);
}

/** A rollout's first line's thread and source, when it is a `session_meta` naming one. */
function sessionMeta(
	line: string,
): { readonly id: string; readonly source: unknown } | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const meta = value as Record<string, unknown>;
	const payload = meta["payload"] as Record<string, unknown> | undefined;
	if (meta["type"] !== "session_meta" || typeof payload?.["id"] !== "string")
		return undefined;
	return { id: payload["id"], source: payload["source"] };
}

/** The `sessionId` of Claude's record of one of its processes. */
function claudeProcessSession(record: PaneRecord, runtime: Runtime): string {
	const session = jsonObject(record, runtime)["sessionId"];
	if (typeof session !== "string" || session.length === 0) {
		throw new SessionsUnreadable(
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
	throw new SessionsUnreadable(
		`${record.path}${runtime.where} does not begin with a JSON object`,
	);
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
			throw new SessionsUnreadable(
				`${what}${runtime.where}: ${failureText(failure)}`,
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
	return `${config}/projects/${claudeProjectName(cwd)}`;
}

/**
 * The newest session files in `$1` — down to depth `$2`: 1 for one project's
 * directory, 2 for every project's under `projects/` — each as a record
 * separator and its id, the directory its file is in (`.` at depth 1), then
 * its last timestamp, the directory it ran in, the git branch it was last on
 * (the last `gitBranch`), its last `custom-title` line
 * (the name a person gave it with `/rename` or `--name`), its last `ai-title`
 * line, and how many candidate first messages follow (the
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
depth=$2
shift 2
taken() { [ "$#" -le 1 ] && return 0; d=$1; shift; for p in "$@"; do case "$d" in $p) return 0 ;; esac; done; return 1; }
find . -mindepth "$depth" -maxdepth "$depth" -name '*.jsonl' -type f -exec sh -c 'stat -c "%Y %n" -- "$@" 2>/dev/null || stat -f "%m %N" -- "$@"' sh {} + |
	sort -rn | {
	n=0
	while IFS= read -r l; do
		f=\${l#* }
		g=\${f#./}
		taken "\${g%%/*}" "$@" || continue
		n=$((n + 1))
		[ "$n" -le ${LISTED} ] || break
		b=\${f##*/}
		printf '\\036%s\\n%s\\n' "\${b%.jsonl}" "\${f%/*}"
		awk '
/"type":"custom-title"/ && length($0) < 4096 { named = $0 }
/"type":"ai-title"/ && length($0) < 4096 { title = $0 }
c < 5 && /"type":"user"/ && !/"tool_use_id"/ && !/"isMeta":true/ && !/"isSidechain":true/ && length($0) < 16384 { first[c++] = $0 }
match($0, /"timestamp":"[^"]*"/) { stamp = substr($0, RSTART + 13, RLENGTH - 14) }
cwd == "" && match($0, /"cwd":"([^"\\\\]|\\\\.)*"/) { cwd = substr($0, RSTART, RLENGTH) }
match($0, /"gitBranch":"([^"\\\\]|\\\\.)*"/) { branch = substr($0, RSTART, RLENGTH) }
END { print stamp; print cwd; print branch; print named; print title; print c + 0; for (i = 0; i < c; i++) print first[i] }
' "$f" || exit 72
	done
}
`;

/**
 * The name Claude keeps a directory's sessions under, in `projects/`: every
 * character but a letter or a digit as `-`.
 */
export function claudeProjectName(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Which of `projects/`'s directories a listing of a repository's sessions
 * reads: every checkout's, and — as a pattern — every folder under DevHub's
 * worktree prefix, so a worktree that has been removed still has its
 * sessions listed. The pattern takes more than it should (a sibling named
 * `{repo}-x` escapes the same way); `placeSessions` keeps only the sessions
 * whose own lines say they ran in one of the repository's folders.
 */
export function claudeRepositoryProjects(
	cwd: string,
	repository: RepositoryWorktrees,
): readonly string[] {
	return [
		...new Set([
			claudeProjectName(cwd),
			...repository.worktrees.map((worktree) =>
				claudeProjectName(worktree.path),
			),
			`${claudeProjectName(repository.siblingPrefix)}*`,
		]),
	];
}

async function listClaudeSessions(
	runtime: Runtime,
	profile: SessionProfile,
	cwd: string,
	scope: SessionScope,
	repository?: RepositoryWorktrees,
): Promise<readonly PastSession[]> {
	const here = await claudeProjectDirectory(runtime, profile, cwd);
	// A repository's sessions are read across its checkouts' directories,
	// which are siblings under `projects/`.
	const across = scope === "here" && repository !== undefined;
	const directory =
		scope === "here" && !across ? here : here.slice(0, here.lastIndexOf("/"));
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
			scope === "here" && !across ? "1" : "2",
			...(across ? claudeRepositoryProjects(cwd, repository) : []),
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
		throw new SessionsUnreadable(
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
		const [
			id,
			folder,
			stamp,
			cwdField,
			branchField,
			namedLine,
			generatedLine,
			count,
			...candidates
		] = chunk.split("\n");
		if (id === undefined || folder === undefined || count === undefined) {
			throw new Error(
				`the listing of Claude's sessions is cut short: ${chunk}`,
			);
		}
		const first = candidates
			.slice(0, Number(count))
			.map((line) => promptOf(id, line))
			.find((text) => text !== undefined);
		const title = titleOf(id, namedLine, generatedLine, first);
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
		const branch = branchField
			? (JSON.parse(`{${branchField}}`) as { gitBranch: string }).gitBranch
			: "";
		sessions.push({
			id,
			title: oneLine(title),
			updatedAt: Number.isNaN(updatedAt) ? undefined : updatedAt,
			cwd: ran,
			// Claude records an empty branch where there is no repository.
			branch: branch === "" ? undefined : branch,
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

/**
 * A session's title, in the precedence the Agent SDK gives a session's
 * display name: the name a person gave it (its last `custom-title` line),
 * else the title Claude generated (its last `ai-title` line), else its first
 * prompt.
 */
function titleOf(
	id: string,
	namedLine: string | undefined,
	generatedLine: string | undefined,
	first: string | undefined,
): string | undefined {
	return (
		recordText(id, namedLine, "custom-title", "customTitle") ??
		recordText(id, generatedLine, "ai-title", "aiTitle") ??
		first
	);
}

/** The text under `key` of a listed line of type `type`, if there is one. */
function recordText(
	id: string,
	line: string | undefined,
	type: string,
	key: string,
): string | undefined {
	if (!line) return undefined;
	const record = parsedLine(id, line);
	return record["type"] === type && typeof record[key] === "string"
		? record[key]
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
 * Whether Claude still keeps session `session` for `root`: its file is there.
 *
 * What `Cmd+Q Shift+T` asks before it starts a closed Agent again on its
 * session (`model/recentlyClosed.ts`), so a session that is gone is said
 * rather than handed to a CLI that would refuse it in a pane. Codex keeps
 * threads where no cheap question finds them; its launch says so itself.
 */
export async function claudeSessionPresent(
	runtime: Runtime,
	profile: SessionProfile,
	root: string,
	session: string,
): Promise<boolean> {
	const directory = await claudeProjectDirectory(
		runtime,
		profile,
		await runtime.realpath(root),
	);
	return (await runtime.stat(`${directory}/${session}.jsonl`)) === "file";
}

/**
 * Copy `$1/$3.jsonl` (and the session's own folder of subagent and tool
 * records, `$1/$3/`, when there is one) into `$2`, unless `$2` has it already.
 */
const CARRY_SCRIPT = `[ -f "$1/$3.jsonl" ] || { echo "there is no $1/$3.jsonl" >&2; exit 66; }
[ -e "$2/$3.jsonl" ] && exit 0
mkdir -p -- "$2" || exit 73
cp -p -- "$1/$3.jsonl" "$2/$3.jsonl" || exit 74
[ ! -d "$1/$3" ] || [ -e "$2/$3" ] || cp -Rp -- "$1/$3" "$2/$3" || exit 75
`;

/**
 * Make Claude session `session`, which ran in `from`, one Claude can resume
 * in `to`.
 *
 * Claude finds a session by the directory it is kept under — the directory
 * it ran in, escaped (`claudeProjectDirectory`) — and resumes only what is
 * under the one it is started in, so a session whose worktree was removed
 * and made again somewhere else is not there for it. The session's file is
 * copied under `to`'s name, and the original is left where it was: it is the
 * CLI's record, and the folder it names may come back. Nothing is done when
 * `to` keeps it already — the same folder, or a copy made before.
 */
export async function carryClaudeSession(
	runtime: Runtime,
	profile: SessionProfile,
	from: string,
	to: string,
	session: string,
): Promise<void> {
	if (!/^[A-Za-z0-9_-]+$/.test(session)) {
		throw new Error(`${JSON.stringify(session)} is not a session id`);
	}
	const source = await claudeProjectDirectory(runtime, profile, from);
	const target = await claudeProjectDirectory(
		runtime,
		profile,
		await runtime.realpath(to),
	);
	if (source === target) return;
	const answer = await askMachine(
		runtime,
		`DevHub could not carry Claude's session ${session} over to ${to}`,
	)({
		argv: ["sh", "-c", CARRY_SCRIPT, "sh", source, target, session],
		env: await runtime.environment(),
		deadline: OperationDeadline.in(30_000),
		cancel: new CancellationToken(),
		limits: {
			stdoutBytes: 16 * 1024,
			stderrBytes: 16 * 1024,
			overflow: { kind: "truncate" },
		},
	});
	if (answer.code !== 0) {
		throw new SessionNotResumable(
			`DevHub could not carry Claude's session ${session} over to ${to}${runtime.where}: ${answer.stderr.toString("utf8").trim() || `exit ${String(answer.code ?? answer.signal)}`}`,
		);
	}
}

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
	// The CLI resumes it whatever its size: the conversation goes on, and
	// says that its past is not drawn.
	if (Buffer.byteLength(text) > MAX_HISTORY_BYTES) {
		return [
			historyWarning(
				`This session's file is larger than DevHub reads back (${MAX_HISTORY_BYTES / 1024 / 1024} MiB), so its earlier conversation is not drawn here. The CLI has all of it.`,
			),
		];
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
	const chain: Record<string, unknown>[] = [];
	const visited = new Set<number>();
	// The conversation as it stood when line `position` was written: the
	// last record of the main chain above it (not a subagent's) that the walk
	// has not drawn yet. The whole file's conversation is the one standing
	// below its last line.
	const standingAbove = (position: number): number | undefined => {
		for (let at = position - 1; at >= 0; at -= 1) {
			const record = records[at]!;
			if (
				typeof record["uuid"] === "string" &&
				record["isSidechain"] !== true &&
				!visited.has(at)
			)
				return at;
		}
		return undefined;
	};
	// Each record goes on at its parent (`parentUuid`, else a compaction
	// boundary's `logicalParentUuid`). Of the lines a parent uuid names, the
	// chain takes the last one above the record, as Claude writes some
	// records twice under one uuid; a parent written only after its child is
	// still its parent (the CLI finds a record by its uuid), so the last line
	// with that uuid then. When the parent names no record the walk has not
	// yet drawn — none at all, or one of the conversation after the record,
	// as a boundary's logical parent can be a reminder Claude wrote only
	// after the summary, under it — the record goes on at the conversation
	// standing above it in the file. The walk never draws a line twice, and
	// every session the CLI resumes is drawn back to its first record.
	let next = standingAbove(records.length);
	while (next !== undefined) {
		const at = next;
		const record = records[at]!;
		visited.add(at);
		chain.push(record);
		const parent = record["parentUuid"] ?? record["logicalParentUuid"];
		const written = typeof parent === "string" ? byUuid.get(parent) : undefined;
		const named =
			written === undefined
				? undefined
				: ([...written].reverse().find((position) => position < at) ??
					written.at(-1)!);
		next =
			named === undefined || visited.has(named) ? standingAbove(at) : named;
	}
	const history = (fields: Record<string, unknown>) =>
		JSON.stringify({ type: "devhub_history", record: fields });
	return [
		...chain.reverse().flatMap((record) => {
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
		}),
	];
}

/**
 * DevHub's own word at the head of a history it could not read whole, as a
 * warning the adapter draws (an `informational` system event).
 */
function historyWarning(content: string): string {
	return JSON.stringify({
		type: "devhub_history",
		record: {
			type: "system",
			subtype: "informational",
			level: "warning",
			content,
		},
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
const CODEX_LISTING_SCRIPT = `want=$1
shift
d=$(mktemp -d) || exit 70
trap 'rm -rf "$d"' EXIT
{ cat; until [ -e "$d/done" ]; do sleep 0.1; done; } | "$@" | {
	left=$want
	while IFS= read -r l; do
		printf '%s\\n' "$l"
		rest=
		for id in $left; do
			printf '%s\\n' "$l" | grep -Eq "^[{][[:space:]]*\\"id\\"[[:space:]]*:[[:space:]]*$id[[:space:]]*[,}]|[,{][[:space:]]*\\"id\\"[[:space:]]*:[[:space:]]*$id[[:space:]]*[}][[:space:]]*\\$" || rest="$rest $id"
		done
		left=$rest
		[ -n "$left" ] || break
	done
	: >"$d/done"
}
`;

/** How many threads the listing of a repository's removed worktrees looks through. */
const LISTED_ACROSS = 200;

/** The file Codex records the sessions it imported from another agent in. */
const CODEX_IMPORT_LEDGER = "external_agent_session_imports.json";

/**
 * The threads Codex made by importing another agent's sessions — Claude
 * Code's, through its "import from another agent" migration.
 *
 * Nothing on the thread itself says so: an imported thread is written like
 * one app-server started (its `source` is `appServer`, its `threadSource`
 * none). The one record is the import ledger Codex keeps beside its state,
 * `$CODEX_HOME/external_agent_session_imports.json`, whose `records` each
 * name the `imported_thread_id` an imported session became (codex-rs
 * `external-agent-migration/src/sessions/ledger.rs`). Those are not
 * sessions anybody ran in Codex, and the same conversation is already in the
 * list as the Claude session it came from, so the listings leave them out.
 *
 * A ledger that is not there is none imported; one that cannot be read or
 * parsed is treated the same, because it is a filter on a list, not a reason
 * to refuse the list.
 */
export async function codexImportedThreads(
	runtime: Runtime,
	profile: SessionProfile,
): Promise<ReadonlySet<string>> {
	try {
		const text = await runtime.readTextFile(
			`${await codexHome(runtime, profile)}/${CODEX_IMPORT_LEDGER}`,
			8 * 1024 * 1024,
		);
		return importedThreadIds(text);
	} catch {
		// Not a swallow: absent or unreadable both mean nothing to leave out.
		return new Set();
	}
}

/** The thread ids an import ledger's text names. Exported for its tests. */
export function importedThreadIds(text: string): ReadonlySet<string> {
	const ids = new Set<string>();
	const ledger: unknown = JSON.parse(text);
	const records =
		typeof ledger === "object" && ledger !== null
			? (ledger as Record<string, unknown>)["records"]
			: undefined;
	if (!Array.isArray(records)) return ids;
	for (const record of records as unknown[]) {
		const id =
			typeof record === "object" && record !== null
				? (record as Record<string, unknown>)["imported_thread_id"]
				: undefined;
		if (typeof id === "string" && id.length > 0) ids.add(id);
	}
	return ids;
}

async function listCodexSessions(
	runtime: Runtime,
	profile: SessionProfile,
	asked: {
		readonly cwd: string;
		readonly scope: SessionScope;
		/** Only threads of these sources; absent, Codex's own default (the interactive ones). */
		readonly sourceKinds: readonly ThreadSourceKind[] | undefined;
		readonly limit?: number;
		/**
		 * The repository the directory is a checkout of: `here` then lists
		 * every checkout's threads, and looks through the newest threads of
		 * every directory for those of its worktrees that have been removed.
		 */
		readonly repository?: RepositoryWorktrees;
	},
): Promise<readonly PastSession[]> {
	const imported = await codexImportedThreads(runtime, profile);
	// Left out by the server where it can be, before its limit is applied —
	// it takes up to a hundred — and by this side always.
	const excluded =
		imported.size > 0 && imported.size <= 100
			? { excludedThreadIds: [...imported] }
			: {};
	const across = asked.scope === "here" && asked.repository !== undefined;
	const cwds = across
		? [
				...new Set([
					asked.cwd,
					...asked.repository!.worktrees.map((worktree) => worktree.path),
				]),
			]
		: asked.cwd;
	const list = (id: number, params: ThreadListParams) => ({
		id,
		method: "thread/list",
		params: {
			...params,
			sortKey: "updated_at",
			...excluded,
			...(asked.sourceKinds === undefined
				? {}
				: { sourceKinds: [...asked.sourceKinds] }),
		} satisfies ThreadListParams,
	});
	const requests = [
		{
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "devhub", version: "0" } },
		},
		{ method: "initialized" },
		list(2, {
			...(asked.scope === "here" ? { cwd: cwds } : {}),
			limit: asked.limit ?? LISTED,
		}),
		...(across ? [list(3, { limit: LISTED_ACROSS })] : []),
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
			across ? "2 3" : "2",
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
	const stdout = answer.stdout.toString("utf8");
	const stderr = answer.stderr.toString("utf8");
	const listed = parseCodexListing(stdout, stderr);
	const merged = across
		? mergeListings(
				listed,
				// Only the threads under DevHub's worktree prefix: those of the
				// checkouts that are there were listed by directory already.
				parseCodexListing(stdout, stderr, 3).filter(
					(thread) =>
						thread.cwd !== undefined &&
						thread.cwd.startsWith(asked.repository!.siblingPrefix),
				),
			)
		: listed;
	return merged.filter((thread) => !imported.has(thread.id));
}

/** Two listings as one: each session once, newest first, as long as one listing. */
function mergeListings(
	first: readonly PastSession[],
	second: readonly PastSession[],
): readonly PastSession[] {
	const seen = new Set(first.map((session) => session.id));
	return [...first, ...second.filter((session) => !seen.has(session.id))]
		.sort(
			(a, b) =>
				(b.updatedAt ?? Number.NEGATIVE_INFINITY) -
				(a.updatedAt ?? Number.NEGATIVE_INFINITY),
		)
		.slice(0, LISTED);
}

/** app-server's lines, as sessions. Exported for its tests. */
export function parseCodexListing(
	stdout: string,
	stderr: string,
	/** Which request's answer: the listing's own, or a second one asked beside it. */
	id = 2,
): readonly PastSession[] {
	const reader = new Reader(undefined);
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		const message = decodeLine(reader, line);
		if (message.kind === "error" && (message.id === 1 || message.id === id)) {
			throw new SessionsUnreadable(
				`codex did not list its threads: ${message.message} (${message.code})`,
			);
		}
		if (message.kind === "response" && message.id === id) {
			const branches = threadBranches(reader, message.result);
			return threadListResponse(reader, message.result).map((thread) => ({
				id: thread.id,
				title: oneLine(thread.name ?? thread.preview),
				updatedAt: thread.updatedAt * 1000,
				cwd: thread.cwd,
				branch: branches.get(thread.id),
				resumableHere: true,
			}));
		}
	}
	const said = stderr.trim().split("\n").at(-1)?.trim();
	throw new SessionsUnreadable(
		`codex app-server ended without listing its threads${said ? `: ${said}` : "."}`,
	);
}

/**
 * The branch each listed thread was on, by id: `gitInfo.branch`, which Codex
 * leaves null (or the whole `gitInfo`) outside a repository.
 */
function threadBranches(
	reader: Reader,
	result: unknown,
): ReadonlyMap<string, string> {
	const branches = new Map<string, string>();
	const listed = reader.fields(result, "result");
	reader.array(listed, "data", "result", (each, at) => {
		const thread = reader.fields(each, at);
		const git = thread["gitInfo"];
		if (git === undefined || git === null) return;
		const branch = reader.nullableString(
			reader.fields(git, `${at}.gitInfo`),
			"branch",
			`${at}.gitInfo`,
		);
		if (branch !== null) branches.set(reader.string(thread, "id", at), branch);
	});
	return branches;
}
