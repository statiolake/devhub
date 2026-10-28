/**
 * The command line that puts `claude` into its structured mode.
 *
 * The profile's own command and arguments come first and are left as they
 * are — a `--permission-mode` or `--model` the owner put there is theirs to
 * keep — and the flags that make the conversation readable follow them.
 * `--bare` is never added: it reads an API key only, and a GUI Agent runs on
 * the owner's own sign-in exactly as the TUI does.
 *
 * Last comes DevHub's `--append-system-prompt` (`GUI_AGENT_INSTRUCTIONS`).
 * Claude keeps only the last `--append-system-prompt` it is given, so one the
 * profile already passes is taken out and its text put first in DevHub's: the
 * person's words are kept, and DevHub's follow them. An
 * `--append-system-prompt-file` adds to either and is left alone.
 */

import type { AgentSessionCommand } from "../../../terminal/ports.js";
import { GUI_AGENT_INSTRUCTIONS } from "../linkInstructions.js";

export const CLAUDE_STRUCTURED_FLAGS: readonly string[] = [
	"-p",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--verbose",
	"--include-partial-messages",
	"--forward-subagent-text",
	"--replay-user-messages",
	"--permission-prompt-tool",
	"stdio",
];

export function claudeStructuredCommand(
	cli: AgentSessionCommand,
): AgentSessionCommand {
	const { args, appended } = withoutAppendedPrompt(cli.args);
	return {
		...cli,
		args: [
			...args,
			...CLAUDE_STRUCTURED_FLAGS,
			APPEND_SYSTEM_PROMPT,
			[...appended, GUI_AGENT_INSTRUCTIONS].join("\n\n"),
		],
	};
}

const APPEND_SYSTEM_PROMPT = "--append-system-prompt";

/**
 * `args` without its `--append-system-prompt`s, and what they said. Only the
 * last counts to Claude, so only the last is kept.
 */
function withoutAppendedPrompt(args: readonly string[]): {
	readonly args: readonly string[];
	readonly appended: readonly string[];
} {
	const kept: string[] = [];
	let appended: string | undefined;
	for (let at = 0; at < args.length; at++) {
		const arg = args[at] ?? "";
		if (arg === APPEND_SYSTEM_PROMPT && at + 1 < args.length) {
			appended = args[at + 1];
			at++;
		} else if (arg.startsWith(`${APPEND_SYSTEM_PROMPT}=`)) {
			appended = arg.slice(APPEND_SYSTEM_PROMPT.length + 1);
		} else {
			kept.push(arg);
		}
	}
	return {
		args: kept,
		appended: appended === undefined || appended === "" ? [] : [appended],
	};
}

/**
 * The command line of the background usage reader's `claude`
 * (`main/shell/usageReaders.ts`): structured input and output, and nothing
 * that could make it a conversation. It is sent control requests only, never
 * a message, so it never starts a turn; `--no-session-persistence` keeps it
 * from writing a session, and `disableAllHooks` keeps the owner's hooks —
 * `SessionStart` among them — from running for a process that is not a
 * session anybody opened.
 */
export const CLAUDE_USAGE_FLAGS: readonly string[] = [
	"-p",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--verbose",
	"--no-session-persistence",
	"--settings",
	JSON.stringify({ disableAllHooks: true }),
];
