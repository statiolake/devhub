/**
 * Which of the paths a GUI conversation's text names are files, on the
 * Agent's machine.
 *
 * The page finds the words that could be paths (`shell/conversation/
 * filePaths.ts`) and asks here before it draws any of them as a link, so that
 * a link is only ever drawn to something that is there. "There" is the
 * Agent's own machine — this Mac, or the host it runs on — because that is
 * the disk the Agent was talking about, and the question is asked through
 * that machine's `Runtime`: one `/bin/sh` for a whole batch, which is one
 * round trip over the host's ssh master rather than one per word.
 *
 * A path is spelled the three ways the Agent spells one: absolute, `~/…`
 * (that machine's home), or relative to the Agent's directory. A file is a
 * regular file or a symlink to one (`test -f`); a folder is not a link.
 */

import { posix } from "node:path";
import { OperationDeadline } from "../../terminal/command.js";
import { CancellationToken } from "../../terminal/ports.js";
import type { FileSelection } from "../../cli/openFiles.js";
import type { Runtime } from "../../runtime/runtime.js";

/** As much of a machine as the question needs. */
export type PathMachine = Pick<Runtime, "exec" | "home" | "where">;

/** At most this many paths to one `/bin/sh`, so its argv stays well inside `ARG_MAX`. */
const PER_SHELL = 250;
const TIMEOUT_MS = 15_000;

/** Prints `1` for each argument that is a file and `0` for each that is not, one per line. */
const SCRIPT = 'for p do if [ -f "$p" ]; then echo 1; else echo 0; fi; done';

/**
 * Each of `paths` as the absolute path of the file it names on `machine`, or
 * `null` when it names none. `cwd` is what a relative path is relative to; a
 * relative path with no `cwd` is a broken promise of the page's.
 */
export async function resolvePathCandidates(
	machine: PathMachine,
	cwd: string | undefined,
	paths: readonly string[],
): Promise<readonly (string | null)[]> {
	const home = paths.some((path) => path.startsWith("~/"))
		? await machine.home()
		: undefined;
	const absolute = paths.map((path) => absoluteOf(path, cwd, home));
	const answers: (string | null)[] = [];
	for (let at = 0; at < absolute.length; at += PER_SHELL) {
		const batch = absolute.slice(at, at + PER_SHELL);
		const files = await filesAmong(machine, batch);
		batch.forEach((path, index) => {
			answers.push(files[index] ? path : null);
		});
	}
	return answers;
}

function absoluteOf(
	path: string,
	cwd: string | undefined,
	home: string | undefined,
): string {
	if (path.includes("\0") || path === "") {
		throw new Error(`${JSON.stringify(path)} is not a path`);
	}
	if (path.startsWith("/")) return posix.normalize(path);
	if (path.startsWith("~/")) {
		if (home === undefined) throw new Error(`no home to resolve ${path} in`);
		return posix.join(home, path.slice(2));
	}
	if (cwd === undefined || !cwd.startsWith("/")) {
		throw new Error(
			`${path} is relative, and the conversation named no directory it is relative to`,
		);
	}
	return posix.join(cwd, path);
}

async function filesAmong(
	machine: PathMachine,
	paths: readonly string[],
): Promise<readonly boolean[]> {
	const result = await machine.exec({
		argv: ["/bin/sh", "-c", SCRIPT, "devhub-path-links", ...paths],
		deadline: OperationDeadline.in(TIMEOUT_MS),
		cancel: new CancellationToken(),
		limits: {
			// Two bytes a path, and room to spare.
			stdoutBytes: paths.length * 2 + 64,
			stderrBytes: 8 * 1024,
			overflow: { kind: "truncate" },
		},
	});
	if (result.code !== 0) {
		throw new Error(
			`DevHub could not ask${machine.where} which paths in the conversation are files (exit ${String(result.code ?? result.signal)}): ${result.stderr.toString("utf8").trim()}`,
		);
	}
	const lines = result.stdout.toString("utf8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length !== paths.length) {
		throw new Error(
			`asked${machine.where} about ${paths.length} paths, /bin/sh answered ${lines.length}`,
		);
	}
	return lines.map((line) => line === "1");
}

/**
 * Where a link's range puts the editor: a line (and column) is a caret there;
 * lines from–to are selected whole, the last to its end — a column past a
 * line's end is its end, as the editor clamps it.
 */
export function fileSelection(range: unknown): FileSelection | undefined {
	if (range === undefined) return undefined;
	const wire = range as Partial<Record<string, unknown>> | null;
	const whole = (value: unknown): value is number =>
		Number.isInteger(value) && (value as number) >= 1;
	if (wire?.["kind"] === "line" && whole(wire["line"]) && whole(wire["column"]))
		return { line: wire["line"], column: wire["column"] };
	if (
		wire?.["kind"] === "lines" &&
		whole(wire["from"]) &&
		whole(wire["to"]) &&
		wire["to"] >= wire["from"]
	)
		return {
			line: wire["from"],
			column: 1,
			end: { line: wire["to"], column: Number.MAX_SAFE_INTEGER },
		};
	throw new Error(`${JSON.stringify(range)} is not a place in a file`);
}
