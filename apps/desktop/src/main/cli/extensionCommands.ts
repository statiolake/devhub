/**
 * `--install-extension`, `--uninstall-extension` and `--list-extensions`.
 *
 * None of the work here is DevHub's. The three operations are VS Code's own
 * `ExtensionManagementCLI` — the same class `code --install-extension` runs —
 * driven against the *running* app's extension management service. That is the
 * one difference from upstream, and it is the point: `code` answers these
 * options in a separate short-lived process, which resolves the gallery, writes
 * the extensions directory and exits without the running instance ever hearing
 * about it. DevHub has one instance and one extensions directory by design, so
 * a second process writing that directory is exactly the split-brain the
 * single-instance rule exists to prevent.
 *
 * Driving the running app instead is what makes the gallery configuration
 * (DevHub's is Open VSX, from `product-overrides.json`), the allow-list, the
 * signature check and the built-in protections apply — because they are the
 * ones the app itself is already using, not a second set assembled by a CLI
 * process from the same files.
 *
 * The install and uninstall halves run in the shared process, which is where
 * `IExtensionManagementService` lives and the only place that touches the
 * extensions directory; the gallery lookup that turns an id into an extension
 * runs in the main process, exactly as it runs in a workbench window. See
 * `extensionServices.ts` for the wiring.
 *
 * `ExtensionManagementCLI` reports by logging and fails by throwing. Both are
 * kept: the transcript is what the person typing the command reads, and it is
 * returned on success and attached to the failure on the way out — an install
 * that failed for four extensions has four reasons, and they are all in there.
 */

import { AbstractMessageLogger } from "code-oss-dev/out/vs/platform/log/common/log.js";
import { LogLevel } from "code-oss-dev/out/vs/platform/log/common/log.js";
import type { ILogger } from "code-oss-dev/out/vs/platform/log/common/log.js";
import type { ExtensionManagementCLI } from "code-oss-dev/out/vs/platform/extensionManagement/common/extensionManagementCLI.js";
import type { InstallOptions } from "code-oss-dev/out/vs/platform/extensionManagement/common/extensionManagement.js";
import { URI } from "code-oss-dev/out/vs/base/common/uri.js";
import { canonicalise } from "./canonical.js";
import { expandPath } from "./resolve.js";

/**
 * How VS Code's own CLI tells an extension id from a `.vsix` (see
 * `asExtensionIdOrVSIX` in `vs/code/node/cliProcessMain.ts`). Copied because
 * that private method is not exported; identical because a target that means
 * one thing to `code` has to mean the same thing to `devhub`.
 */
const VSIX = /\.vsix$/i;

/** What a caller needs to reach VS Code's extension management. */
export interface ExtensionCliHost {
	/** VS Code's own extension CLI, writing its report into `logger`. */
	cli(logger: ILogger): ExtensionManagementCLI;
	/** The default profile's extensions resource; every call names it. */
	profileLocation(): URI;
}

/** Collects what the CLI would have printed, in order. */
class Transcript extends AbstractMessageLogger {
	readonly lines: string[] = [];

	constructor() {
		super();
		this.setLevel(LogLevel.Info);
	}

	protected log(_level: LogLevel, message: string): void {
		this.lines.push(message);
	}

	text(): string {
		return this.lines.join("\n");
	}
}

/**
 * Run one operation and turn it into the answer the CLI prints.
 *
 * A failure carries the transcript with it. Without that, "Failed Installing
 * Extensions: publisher.name" would arrive with the four lines saying *why*
 * left behind in a process the person cannot see.
 */
async function report(
	host: ExtensionCliHost,
	run: (cli: ExtensionManagementCLI, transcript: Transcript) => Promise<void>,
): Promise<string> {
	const transcript = new Transcript();
	try {
		await run(host.cli(transcript), transcript);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const said = transcript.text();
		throw new Error(said.length > 0 ? `${said}\n${reason}` : reason);
	}
	return transcript.text();
}

export async function installExtensions(
	host: ExtensionCliHost,
	targets: readonly string[],
	force: boolean,
	cwd: string,
	home: string,
): Promise<string> {
	const resolved = await Promise.all(
		targets.map(async (target) => {
			if (!VSIX.test(target)) return target;
			// A `.vsix` is a path, and a path from a command line may be relative
			// or start with `~`. It is canonicalised by the same rule every other
			// path DevHub is given goes through.
			const file = await canonicalise(expandPath(target, cwd, home));
			if (!file.exists) {
				throw new Error(`there is no file at ${file.path}.`);
			}
			return URI.file(file.path);
		}),
	);
	const options: InstallOptions = { profileLocation: host.profileLocation() };
	return report(host, (cli) =>
		// The second list is `--install-builtin-extension`, which DevHub does not
		// offer: a built-in is what the app ships, not what a person installs.
		cli.installExtensions(resolved, [], options, force),
	);
}

export async function uninstallExtensions(
	host: ExtensionCliHost,
	ids: readonly string[],
	force: boolean,
): Promise<string> {
	return report(host, (cli) =>
		cli.uninstallExtensions([...ids], force, host.profileLocation()),
	);
}

export async function listExtensions(
	host: ExtensionCliHost,
	showVersions: boolean,
): Promise<string> {
	return report(host, async (cli, transcript) => {
		// `--category` is upstream's third argument and DevHub does not offer it,
		// so it is `undefined` rather than the empty string, which upstream reads
		// as "list the categories instead".
		await cli.listExtensions(showVersions, undefined, host.profileLocation());
		if (transcript.lines.length === 0) {
			transcript.info("No extensions are installed.");
		}
	});
}
