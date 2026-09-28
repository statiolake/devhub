/**
 * The command line that puts `claude` into its structured mode.
 *
 * The profile's own command and arguments come first and are left as they
 * are — a `--permission-mode` or `--model` the owner put there is theirs to
 * keep — and the flags that make the conversation readable follow them.
 * `--bare` is never added: it reads an API key only, and a GUI Agent runs on
 * the owner's own sign-in exactly as the TUI does.
 */

import type { AgentSessionCommand } from "../../../terminal/ports.js";

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
	return { ...cli, args: [...cli.args, ...CLAUDE_STRUCTURED_FLAGS] };
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
