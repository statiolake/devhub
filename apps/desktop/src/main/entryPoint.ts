/**
 * Running a program that DevHub writes onto a machine and then executes.
 *
 * Two of DevHub's own programs are shipped as one bundled file and run by a
 * generated `/bin/sh` script: the terminal launcher's asking program
 * (`terminal/devhubTerminal.ts`) and the `devhub` command
 * (`cli/devhubCli.ts`). Both used to decide for themselves whether they were
 * the entry point:
 *
 *     fileURLToPath(import.meta.url) === resolve(process.argv[1])
 *
 * which is a comparison of two names for one file, and names for one file are
 * not one name. Node's ESM loader resolves `import.meta.url` through symlinks;
 * `process.argv[1]` is the path the script was *called* by. On a host whose
 * `$HOME` is `/home/<user>` and canonically `/volume1/home/<user>` — the
 * ordinary Synology layout — those two strings differ for the same file, the
 * guard said "not the entry", `main()` never ran, and the process exited 0
 * having printed nothing. Every DevHub terminal tab on that host closed
 * instantly with no message, and `devhub` there answered every command with
 * silence and success.
 *
 * A guard that can be wrong about this cannot be made right by comparing
 * better names. The entry point of a bundle is a fact about how the bundle was
 * built, so it is stated where that fact lives: `devhubCliEntry.ts` and
 * `devhubTerminalEntry.ts` exist only to call `runEntry`, they are what the
 * build points esbuild at and what the generated scripts name, and they have
 * no condition in them at all. A module that is imported — by its tests, or by
 * the app — is not one of those files and runs nothing, which is the same
 * guarantee the guard was reaching for, without a guess in it.
 *
 * What is left here is the reporting, once, for both: a failure is one line on
 * stderr naming the program, and a non-zero status. Nothing about this may
 * exit 0 having done nothing — that is the shape of the bug above, and the
 * shape every silent failure takes.
 */

/**
 * Run a program's `main`, and report whatever it did.
 *
 * `name` is what the line on stderr calls the program, which is what a person
 * sees in a terminal tab that has just closed or in a `devhub` that refused.
 *
 * `process.exitCode` rather than `process.exit`, so that anything already
 * written to stdout is flushed before the process ends: a `devhub-terminal`
 * whose argv was cut in half is a shell command line that means something else.
 */
export function runEntry(
	name: string,
	main: () => Promise<number>,
	report: (line: string) => void = (line) => {
		console.error(line);
	},
): Promise<void> {
	return main().then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			report(
				`${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exitCode = 1;
		},
	);
}
