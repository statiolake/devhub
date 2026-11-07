/**
 * Which shell Claude Code gets on a machine.
 *
 * Claude Code will not start without bash or zsh: it takes `$SHELL` if that
 * is one of the two, then looks for zsh and bash on `PATH` and in the usual
 * directories, and accepts `CLAUDE_CODE_SHELL` only when it names a bash or a
 * zsh. busybox `sh` is not accepted, and the CLI's own refusal ("No suitable
 * shell found. Claude CLI requires a Posix shell environment…") names nothing
 * a person on a NAS could do about it.
 *
 * So, per machine, once a shell has been found:
 *
 * - **The machine has bash or zsh** — every Mac, nearly every Linux. Nothing
 *   is added: the CLI finds what it would have found, and DevHub does not
 *   second-guess the person's shell.
 * - **It has neither** — a Synology NAS, a busybox appliance. DevHub delivers
 *   the static bash it publishes (`scripts/build_bash.py`) the way it delivers
 *   tmux, and sets `CLAUDE_CODE_SHELL` and `SHELL` to it **for that Agent's
 *   process only**. Not the login shell, not tmux's `default-shell`, not a
 *   terminal's: those are the person's, and busybox `sh` serves them fine.
 * - **It has neither and the delivery failed** — an architecture DevHub
 *   publishes no bash for, a release that is not there. The Agent does not
 *   start, with a sentence naming the machine, why, and what to install.
 *
 * The decision is `claudeShellDecision`, pure; the probe is
 * `agentShellProbe`, a POSIX script run under the machine's login
 * environment.
 */

import { shellQuote } from "./quote.js";

/**
 * The fixed places Claude Code also looks, after `$SHELL` and `PATH`.
 *
 * Asked here too, so that a bash the CLI would find on its own is never one
 * DevHub replaces with its own.
 */
export const COMMON_SHELL_DIRECTORIES: readonly string[] = [
	"/bin",
	"/usr/bin",
	"/usr/local/bin",
	"/opt/homebrew/bin",
];

/**
 * A POSIX script that prints the shell Claude Code would pick, or nothing.
 *
 * In the CLI's own order: `$SHELL` when it is a bash or a zsh, then `zsh` and
 * `bash` by `command -v`, then each of `directories`. Always exits 0, so a
 * non-zero exit is the transport's failure and never "no shell".
 */
export function agentShellProbe(
	directories: readonly string[] = COMMON_SHELL_DIRECTORIES,
): string {
	const fixed = directories
		.flatMap((directory) => [`${directory}/zsh`, `${directory}/bash`])
		.map(shellQuote)
		.join(" ");
	return [
		`found() { [ -f "$1" ] && [ -x "$1" ] && { printf '%s\\n' "$1"; exit 0; }; }`,
		`case "\${SHELL:-}" in */bash | */zsh) found "$SHELL" ;; esac`,
		`for n in zsh bash; do p=$(command -v "$n" 2>/dev/null) || continue; case "$p" in /*) found "$p" ;; esac; done`,
		`for p in ${fixed}; do found "$p"; done`,
		`exit 0`,
	].join("\n");
}

/** The probe's answer: an absolute path, or `undefined` for none. */
export function parseAgentShellProbe(stdout: string): string | undefined {
	const line = stdout.trim().split("\n").pop()?.trim() ?? "";
	return line.startsWith("/") ? line : undefined;
}

/** What delivering DevHub's bash came to, when it had to be tried. */
export type DeliveredBash =
	| { readonly kind: "installed"; readonly path: string }
	| { readonly kind: "failed"; readonly reason: string };

export type ClaudeShellDecision =
	/** The machine's own bash or zsh; nothing to add. */
	| { readonly kind: "host"; readonly shell: string }
	/** DevHub's bash, for the Agent's process alone. */
	| {
			readonly kind: "delivered";
			readonly environment: Readonly<Record<string, string>>;
	  }
	/** Neither, and no way to bring one: the Agent must not start. */
	| { readonly kind: "refused"; readonly message: string };

/** Whether `found` (the probe's answer) leaves DevHub a bash to deliver. */
export function needsDeliveredBash(found: string | undefined): boolean {
	return found === undefined;
}

/**
 * The shell a Claude Agent on `machine` runs with.
 *
 * `found` is the probe's answer; `delivered` is what delivering DevHub's bash
 * came to, and is only asked for — and only read — when nothing was found.
 */
export function claudeShellDecision(
	machine: string,
	found: string | undefined,
	delivered: DeliveredBash | undefined,
): ClaudeShellDecision {
	if (found !== undefined) return { kind: "host", shell: found };
	if (delivered === undefined) {
		throw new Error(
			`${machine} has no bash or zsh and DevHub's own bash was never tried — ` +
				`a bug in DevHub`,
		);
	}
	if (delivered.kind === "installed") {
		return {
			kind: "delivered",
			environment: {
				CLAUDE_CODE_SHELL: delivered.path,
				SHELL: delivered.path,
			},
		};
	}
	return {
		kind: "refused",
		message: noShellRefusal(machine, delivered.reason),
	};
}

/** The sentence a Claude Agent that cannot start for want of a shell shows. */
export function noShellRefusal(machine: string, reason: string): string {
	return (
		`Claude Code needs bash or zsh on ${machine}, and ${machine} has neither ` +
		`(busybox sh is not enough). DevHub could not put its own bash there: ` +
		`${reason}. Install bash on ${machine} — on a Synology NAS with Entware, ` +
		`\`opkg install bash\` — and start the Agent again: DevHub uses a bash ` +
		`or zsh that is on that machine's PATH.`
	);
}
