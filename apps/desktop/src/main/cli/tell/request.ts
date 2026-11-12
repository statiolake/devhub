/**
 * `devhub --tell`'s words, as the app receives them, made into a command.
 *
 * The `devhub` command (`cli/`, Go) parses nothing after `--tell`: it sends
 * the words as typed, the directory they were typed in and that machine's
 * home, and — when this says a `-` stood for text — what was piped in. This
 * is the half of the old TypeScript command that read them: the parser, the
 * paths made absolute where they were typed, and the text put where `-`
 * stood. It runs here, beside the service that executes the verbs, so the
 * vocabulary has one reader (`docs/devhub-cli.md`).
 *
 * The paths are strings, never looked at on this disk: on a host they are
 * paths on the host, and the service resolves them on the machine the
 * request names.
 */

import { posix } from "node:path";
import { expandPath } from "../resolve.js";
import {
	parseTellArguments,
	STDIN_TEXT,
	TELL_USAGE,
	type TellAttachment,
	type TellCommand,
} from "./command.js";

export type TellWords =
	| {
			readonly kind: "tell";
			readonly command: TellCommand;
			readonly json: boolean;
			readonly as?: string;
	  }
	/** `--tell help`: the usage, which is an answer rather than a command. */
	| { readonly kind: "help"; readonly usage: string }
	/** A command line DevHub refuses: printed with the hint, exit 2. */
	| { readonly kind: "invalid"; readonly message: string }
	/**
	 * A `-` stands for text and nothing piped in was sent: the command is to
	 * read its stdin and ask again. Asked for rather than read whenever a `-`
	 * appears, so a `devhub` whose stdin is a pipe nobody writes to never
	 * blocks on it for a `-` that was not text.
	 */
	| { readonly kind: "needs-stdin" }
	/**
	 * The words attach files (`--attach PATH`, `attachment add PATH`): the
	 * command is to read these, on its machine, and ask again with `files`.
	 */
	| { readonly kind: "needs-files"; readonly paths: readonly string[] };

export function tellFromWords(
	argv: readonly string[],
	cwd: string,
	home: string,
	stdin: string | undefined,
	files?: Readonly<Record<string, string>>,
): TellWords {
	const parsed = parseTellArguments(argv);
	if (parsed.kind === "invalid") return parsed;
	if (parsed.command.verb === "help") {
		return { kind: "help", usage: TELL_USAGE };
	}
	let command: TellCommand = parsed.command;
	if (readsStdin(command)) {
		if (stdin === undefined) return { kind: "needs-stdin" };
		command = withStdinText(command, stdin);
	}
	command = expandTellPaths(command, cwd, home);
	const wanted = attachedPaths(command);
	if (wanted.length > 0) {
		const missing = wanted.filter((path) => files?.[path] === undefined);
		if (missing.length > 0) return { kind: "needs-files", paths: wanted };
		command = withAttachedFiles(command, files!);
	}
	return {
		kind: "tell",
		command,
		json: parsed.json,
		...(parsed.as === undefined ? {} : { as: parsed.as }),
	};
}

function attachmentsOf(command: TellCommand): readonly TellAttachment[] {
	switch (command.verb) {
		case "escalation-new":
		case "attachment-add":
			return command.attachments ?? [];
		default:
			return [];
	}
}

/** The files the command attaches, by absolute path, each once. */
function attachedPaths(command: TellCommand): readonly string[] {
	return [
		...new Set(
			attachmentsOf(command).flatMap((one) =>
				one.kind === "path" ? [one.path] : [],
			),
		),
	];
}

/** Each attached path, with the bytes the command read of it. */
function withAttachedFiles(
	command: TellCommand,
	files: Readonly<Record<string, string>>,
): TellCommand {
	const filled = (all: readonly TellAttachment[] | undefined) =>
		all?.map(
			(one): TellAttachment =>
				one.kind === "path"
					? { ...one, kind: "file", base64: files[one.path]! }
					: one,
		);
	switch (command.verb) {
		case "escalation-new":
			return { ...command, attachments: filled(command.attachments)! };
		case "attachment-add":
			return { ...command, attachments: filled(command.attachments)! };
		default:
			return command;
	}
}

function expandAttachments(
	all: readonly TellAttachment[] | undefined,
	cwd: string,
	home: string,
): readonly TellAttachment[] | undefined {
	return all?.map((one) =>
		one.kind === "path"
			? { ...one, path: posix.normalize(expandPath(one.path, cwd, home)) }
			: one,
	);
}

/** The paths a `--tell` names, made absolute where the command was typed. */
function expandTellPaths(
	command: TellCommand,
	cwd: string,
	home: string,
): TellCommand {
	switch (command.verb) {
		case "workspace-open":
			return { ...command, path: expandPath(command.path, cwd, home) };
		case "issue-assign":
			return command.repo === undefined
				? command
				: { ...command, repo: expandPath(command.repo, cwd, home) };
		case "orchestrator-start":
			return command.root === undefined
				? command
				: { ...command, root: expandPath(command.root, cwd, home) };
		case "link":
			return command.kind === "file" && command.target !== undefined
				? { ...command, target: expandPath(command.target, cwd, home) }
				: command;
		case "escalation-new":
			return command.attachments === undefined
				? command
				: {
						...command,
						attachments: expandAttachments(command.attachments, cwd, home)!,
					};
		case "attachment-add":
			return {
				...command,
				attachments: expandAttachments(command.attachments, cwd, home)!,
			};
		case "sessions":
		case "agent-resume":
			return {
				...command,
				...(command.workspace === undefined
					? {}
					: {
							workspace: expandWorkspacePath(command.workspace, cwd, home),
						}),
				...(command.folder === undefined
					? {}
					: { folder: posix.normalize(expandPath(command.folder, cwd, home)) }),
			};
		case "agents":
		case "agent-new":
		case "agent-wait-many":
		case "session-meta":
			return command.workspace === undefined
				? command
				: {
						...command,
						workspace: expandWorkspacePath(command.workspace, cwd, home),
					};
		default:
			return command;
	}
}

/**
 * A `<w>` spelled as a relative path (`.`, `./x`, `~/x`) made absolute
 * against the cwd it was typed in. Ids, names and absolute roots pass through.
 */
export function expandWorkspacePath(
	workspace: string,
	cwd: string,
	home: string,
): string {
	return workspace === "." ||
		workspace === ".." ||
		workspace.startsWith("./") ||
		workspace.startsWith("../") ||
		workspace === "~" ||
		workspace.startsWith("~/")
		? posix.normalize(expandPath(workspace, cwd, home))
		: workspace;
}

/**
 * Text given as `-` is what is piped in: a prompt or a message too long, or
 * too full of quotes, for a command line. One trailing newline is the pipe's,
 * not the text's.
 */
export function withStdinText(
	command: TellCommand,
	stdin: string,
): TellCommand {
	const text = stdin.replace(/\n$/, "");
	switch (command.verb) {
		case "agent-send":
		case "orchestrator-emit":
			return command.text === STDIN_TEXT ? { ...command, text } : command;
		case "task-edit":
			return command.memo === STDIN_TEXT ? { ...command, memo: text } : command;
		case "agent-resume":
		case "agent-new":
		case "issue-assign":
		case "orchestrator-start":
			return command.prompt === STDIN_TEXT
				? { ...command, prompt: text }
				: command;
		case "escalation-new":
			return command.body === STDIN_TEXT ? { ...command, body: text } : command;
		default:
			return command;
	}
}

function readsStdin(command: TellCommand): boolean {
	switch (command.verb) {
		case "agent-send":
		case "orchestrator-emit":
			return command.text === STDIN_TEXT;
		case "task-edit":
			return command.memo === STDIN_TEXT;
		case "agent-resume":
		case "agent-new":
		case "issue-assign":
		case "orchestrator-start":
			return command.prompt === STDIN_TEXT;
		case "escalation-new":
			return command.body === STDIN_TEXT;
		default:
			return false;
	}
}
