/**
 * The argv that makes a Codex profile speak `app-server` instead of its TUI.
 *
 * The profile's own arguments come first and the subcommand last, so that
 * global options (`-c key=value`, `--profile`) still apply. Whether every
 * argument a profile may carry is accepted before `app-server` is not yet
 * verified against a real Codex (design §8 stage 0).
 */
export function appServerArgs(
	profileArgs: readonly string[],
): readonly string[] {
	return [...profileArgs, "app-server"];
}
