/**
 * One quoting rule for the whole app.
 *
 * `ssh host -- a b c` does **not** deliver an argv. OpenSSH joins the words
 * with spaces and hands the string to the remote login shell, so a runtime
 * that runs anything on another machine has to compose that command line
 * itself — and the moment there are two functions that do it, one of them is
 * the one that gets a branch name with a quote in it wrong.
 *
 * So it is here, in the runtime module, beside the interface whose whole
 * promise is that `exec` takes an argv and never a shell string. The local
 * runtime never calls it: locally the argv is handed to `spawn`, which is the
 * same guarantee obtained for free. It is written and tested now because the
 * contract — *any* bytes in, one shell word out — is what the remote runtime
 * will be built on, and a contract discovered later is a contract negotiated
 * around a bug.
 *
 * The rule is the single-quote rule, and it is the only POSIX quoting rule
 * with no exceptions: inside `'…'` every byte is literal, including `$`,
 * backslash, newline and `!`, and the one byte that cannot appear is the
 * single quote itself — which is written by leaving the string, escaping one
 * quote, and going back in. Nothing here needs to know what the bytes mean,
 * which is why nothing here can be wrong about a byte it has not met.
 *
 * `launcher.ts` and `install.ts` build shell scripts with the same helper for
 * the same reason: a path a person chose is not a token DevHub gets to assume
 * anything about.
 */

/**
 * Quote one value as exactly one POSIX shell word, whatever is in it.
 *
 * The empty string quotes to `''` rather than to nothing, which is the case
 * that a naive "quote if it looks dangerous" rule always gets wrong: an
 * unquoted empty argument disappears from the command line entirely, turning
 * `git commit -m ""` into `git commit -m` and a message into a missing one.
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Quote a whole argv into one command line.
 *
 * The join is a plain space because every word is already exactly one word;
 * that is the property `shellQuote` exists to establish, and it is what makes
 * this function boring enough to be the only one.
 */
export function shellQuoteArgv(argv: readonly string[]): string {
	return argv.map(shellQuote).join(" ");
}
