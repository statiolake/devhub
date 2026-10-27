/**
 * A CLI's own settings file, read and replaced on the Agent's machine — the
 * file a default for new sessions is saved in (`model/cliDefaults.ts`):
 * Claude Code's `settings.json`, Codex's `config.toml`.
 *
 * A change is written atomically: the new text goes to a file beside it
 * under a name nobody else holds, which is then renamed over it, so the CLI
 * never reads half a file and a failed write leaves the old one whole.
 */

import { randomUUID } from "node:crypto";
import { OperationDeadline } from "../../terminal/command.js";
import { CancellationToken } from "../../terminal/ports.js";
import { RuntimeFileError, type Runtime } from "../../runtime/runtime.js";

/** Larger than any settings file a person writes by hand. */
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

/** A file's text, or undefined when it is not there. */
export async function settingsText(
	runtime: Runtime,
	path: string,
): Promise<string | undefined> {
	try {
		return await runtime.readTextFile(path, MAX_SETTINGS_BYTES);
	} catch (failure: unknown) {
		if (
			failure instanceof RuntimeFileError &&
			(failure.code === "ENOENT" || failure.code === "ENOTDIR")
		)
			return undefined;
		throw failure;
	}
}

/** `path` under the home directory, as a person reads it: `~/.codex/config.toml`. */
export async function homeRelative(
	runtime: Runtime,
	path: string,
): Promise<string> {
	const home = await runtime.home();
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Replace `directory/name` with `text`, making the directory if it is not
 * there. `what` names the file in a failure: "Claude Code's settings".
 */
export async function replaceSettingsFile(
	runtime: Runtime,
	directory: string,
	name: string,
	text: string,
	what: string,
): Promise<void> {
	const path = `${directory}/${name}`;
	await runtime.makeDirectory(directory);
	const temporary = `${path}.devhub-${randomUUID()}`;
	if (!(await runtime.writeNewTextFile(temporary, text, 0o600)))
		throw new Error(`${temporary} is taken${runtime.where}`);
	const moved = await runtime.exec({
		argv: ["mv", "-f", temporary, path],
		deadline: OperationDeadline.in(10_000),
		cancel: new CancellationToken(),
		limits: {
			stdoutBytes: 16 * 1024,
			stderrBytes: 16 * 1024,
			overflow: { kind: "truncate" },
		},
	});
	if (moved.code !== 0) {
		await runtime.removeTree(temporary).catch(() => undefined);
		throw new Error(
			`DevHub could not save ${what} ${path}${runtime.where}: ${moved.stderr.toString("utf8").trim() || `exit ${String(moved.code ?? moved.signal)}`}`,
		);
	}
}
