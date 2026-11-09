/**
 * Which shell Claude Code gets on a machine: DevHub's own bash, always.
 *
 * Claude Code runs its Bash tool in the shell `CLAUDE_CODE_SHELL` names (a
 * bash or a zsh), else `$SHELL`, else whichever zsh or bash it finds on
 * `PATH`. DevHub runs only the binaries it carries or delivers, never whatever
 * happens to be installed (`docs/bundled-binaries.md`), so a Claude Agent is
 * given DevHub's bash as `CLAUDE_CODE_SHELL`, **for that Agent's process
 * only** (not `SHELL`: tmux sets a pane's `SHELL` to its `default-shell`
 * whatever the session's environment says, and `CLAUDE_CODE_SHELL` is what
 * Claude Code reads first):
 *
 * - **this Mac**: the bash inside the app (`out/bash`, `bundledBash.ts`);
 * - **an SSH host**: the static bash DevHub publishes
 *   (`scripts/build_bash.py`), delivered the way tmux is, under
 *   `~/.devhub-server/bash/<version>`.
 *
 * The login shell, tmux's `default-shell` and every terminal stay the
 * person's: their zsh in their panes is theirs. When the delivery fails — an
 * architecture DevHub publishes no bash for, a release that is not there —
 * the Agent does not start, with a sentence naming the machine and why.
 */

/** What delivering DevHub's bash came to. */
export type DeliveredBash =
	| { readonly kind: "installed"; readonly path: string }
	| { readonly kind: "failed"; readonly reason: string };

/** The environment a Claude Agent runs with for `bash`, DevHub's own. */
export function claudeShellEnvironment(
	bash: string,
): Readonly<Record<string, string>> {
	return { CLAUDE_CODE_SHELL: bash };
}

/**
 * The environment a Claude Agent on `machine` runs with, or a throw whose
 * sentence names the machine and the reason.
 */
export function deliveredClaudeShell(
	machine: string,
	delivered: DeliveredBash,
): Readonly<Record<string, string>> {
	if (delivered.kind === "installed") {
		return claudeShellEnvironment(delivered.path);
	}
	throw new Error(noShellRefusal(machine, delivered.reason));
}

/** The sentence a Claude Agent that cannot start for want of a shell shows. */
export function noShellRefusal(machine: string, reason: string): string {
	return (
		`Claude Code on ${machine} runs in DevHub's own bash, and DevHub could ` +
		`not put it there: ${reason}. DevHub does not fall back to a bash or zsh ` +
		`installed on ${machine}; check that ${machine} can be reached and that ` +
		`DevHub publishes a bash for its architecture, then start the Agent again.`
	);
}
