/**
 * What a workbench means when it says "relaunch".
 *
 * The policy is here, on its own, because it is the whole of the decision and
 * none of the machinery: given the request and the command line DevHub was
 * started with, there is exactly one right answer and it can be read without a
 * running application. `devhubLifecycleMainService.ts` carries it out.
 *
 * Two answers, and the request tells them apart by whether it edits the
 * process arguments — see that file for why the split falls there.
 */

import type { IRelaunchOptions } from "code-oss-dev/out/vs/platform/lifecycle/electron-main/lifecycleMainService.js";
import type { NativeParsedArgs } from "code-oss-dev/out/vs/platform/environment/common/argv.js";
import {
	OPTIONS,
	parseArgs,
} from "code-oss-dev/out/vs/platform/environment/node/argv.js";

export type RelaunchRequest =
	/** Reload every workbench with this command line; DevHub itself stays up. */
	| { readonly kind: "reload-workbenches"; readonly cli: NativeParsedArgs }
	/** Nothing short of a new process will do; ask the person first. */
	| { readonly kind: "restart-devhub" };

/** The keys of `IRelaunchOptions` this translation knows how to answer. */
const UNDERSTOOD_OPTIONS = new Set(["addArgs", "removeArgs"]);

export function readRelaunchRequest(
	options: IRelaunchOptions | undefined,
	args: NativeParsedArgs,
): RelaunchRequest {
	const unknown = Object.keys(options ?? {}).filter(
		(key) => !UNDERSTOOD_OPTIONS.has(key),
	);
	if (unknown.length > 0) {
		// Not a thing to fall back from: this is a caller upstream grew that
		// the translation has never read, and either answer would be a guess
		// presented as an answer. Failing names the caller in one step.
		throw new Error(
			`DevHub cannot translate a relaunch carrying ${unknown.join(", ")}`,
		);
	}

	const edits =
		(options?.addArgs?.length ?? 0) > 0 ||
		(options?.removeArgs?.length ?? 0) > 0;
	if (!edits) {
		return { kind: "restart-devhub" };
	}
	return {
		kind: "reload-workbenches",
		cli: editCommandLine(args, options ?? {}),
	};
}

/** DevHub's own command line, with the caller's additions and removals. */
function editCommandLine(
	args: NativeParsedArgs,
	options: IRelaunchOptions,
): NativeParsedArgs {
	const cli: NativeParsedArgs = { ...args, _: [...args._] };
	// `NativeParsedArgs` is a fixed set of named options, and both edits below
	// name one at runtime — which is the whole point of the request.
	const byName = cli as unknown as Record<string, unknown>;
	if (options.addArgs?.length) {
		const added = parseArgs(options.addArgs, OPTIONS);
		for (const [key, value] of Object.entries(added)) {
			if (key === "_") {
				// Positional arguments are folders and files to open. A relaunch
				// is about how the workbench runs, not about what it shows.
				continue;
			}
			byName[key] = value;
		}
	}
	for (const argument of options.removeArgs ?? []) {
		// Callers pass back what they once added: a flag as it was written on
		// the command line, or — the startup profiler — a plain file path.
		if (!argument.startsWith("-")) {
			cli._ = cli._.filter((positional) => positional !== argument);
			continue;
		}
		const name = argument.replace(/^--?/u, "").split("=")[0];
		delete byName[name];
	}
	return cli;
}
