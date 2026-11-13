/**
 * Reading transcripts on a machine: which there are, and the bytes of each
 * from where the index left off.
 *
 * Through the machine's `Runtime`, so an SSH host's are read the way every
 * other file of the host is — two small `sh` scripts over the connection
 * DevHub already has, never a copy of a whole file:
 *
 * - **list**: every transcript under the CLI's folder written to in the
 *   retention (`find -mtime`), with its size and modification time — `stat`
 *   in GNU's spelling or BSD's;
 * - **read**: for each file asked for, its bytes from an offset, at most so
 *   many (`tail -c +N | head -c M`), each after a record separator (0x1E) and
 *   its path. JSON never has a raw 0x1E in it (a control character is
 *   escaped in a string), so the separator cannot be inside a file's lines.
 */

import { OperationDeadline } from "../terminal/command.js";
import { CancellationToken } from "../terminal/ports.js";
import type { Runtime } from "../runtime/runtime.js";
import type { TokenCli } from "../../model/tokenTranscripts.js";

/** One CLI's folder on one machine: Claude's config dir, `CODEX_HOME`. */
export interface TranscriptRoot {
	readonly machine: string;
	readonly cli: TokenCli;
	readonly root: string;
}

export interface ListedFile {
	readonly path: string;
	readonly size: number;
	readonly mtimeMs: number;
}

export interface ReadRequest {
	readonly path: string;
	readonly offset: number;
	readonly length: number;
}

export interface TranscriptMachine {
	list(root: TranscriptRoot, days: number): Promise<readonly ListedFile[]>;
	read(requests: readonly ReadRequest[]): Promise<ReadonlyMap<string, Buffer>>;
}

/**
 * `$1` the folder to search, `$2` the name pattern, `$3` the days. A folder
 * that is not there is a CLI that never ran there: nothing.
 */
const LIST_SCRIPT = `[ -d "$1" ] || exit 0
find "$1" -type f \\( -name "$2" -o -name 'agent-*.meta.json' \\) -mtime "-$3" -exec /bin/sh -c 'stat -c "%s %Y %n" -- "$@" 2>/dev/null || stat -f "%z %m %N" -- "$@"' sh {} +
`;

const READ_SCRIPT = `while [ "$#" -ge 3 ]; do
	printf '\\036%s\\n' "$1"
	tail -c "+$(($2 + 1))" -- "$1" 2>/dev/null | head -c "$3"
	shift 3
done
`;

const where = (root: TranscriptRoot) =>
	root.cli === "claude"
		? { folder: `${root.root}/projects`, pattern: "*.jsonl" }
		: { folder: `${root.root}/sessions`, pattern: "rollout-*.jsonl" };

/** `size mtime path` lines, as the list script prints them. */
export function parseListing(output: string): ListedFile[] {
	const files: ListedFile[] = [];
	for (const line of output.split("\n")) {
		const match = /^(\d+) (\d+) (.+)$/u.exec(line);
		if (!match) continue;
		files.push({
			path: match[3]!,
			size: Number(match[1]),
			mtimeMs: Number(match[2]) * 1000,
		});
	}
	return files;
}

/** The read script's output, by path. */
export function parseReads(output: Buffer): Map<string, Buffer> {
	const reads = new Map<string, Buffer>();
	let at = output.indexOf(0x1e);
	while (at >= 0) {
		const next = output.indexOf(0x1e, at + 1);
		const part = output.subarray(at + 1, next < 0 ? output.length : next);
		const newline = part.indexOf(0x0a);
		if (newline > 0)
			reads.set(
				part.subarray(0, newline).toString("utf8"),
				part.subarray(newline + 1),
			);
		at = next;
	}
	return reads;
}

/** How much one `read` answers with, at most. */
export const READ_BUDGET_BYTES = 24 * 1024 * 1024;

export function runtimeTranscriptMachine(runtime: Runtime): TranscriptMachine {
	const run = async (
		script: string,
		args: readonly string[],
		maxBytes: number,
	): Promise<Buffer> => {
		const answer = await runtime.exec({
			argv: ["/bin/sh", "-c", script, "sh", ...args],
			env: await runtime.environment(),
			deadline: OperationDeadline.in(30_000),
			cancel: new CancellationToken(),
			limits: {
				stdoutBytes: maxBytes,
				stderrBytes: 16 * 1024,
				overflow: { kind: "truncate" },
			},
		});
		if (answer.code !== 0)
			throw new Error(
				answer.stderr.toString("utf8").trim() ||
					`exit ${String(answer.code ?? answer.signal)}`,
			);
		return answer.stdout;
	};
	return {
		async list(root, days) {
			const { folder, pattern } = where(root);
			const output = await run(
				LIST_SCRIPT,
				[folder, pattern, String(days)],
				16 * 1024 * 1024,
			);
			return parseListing(output.toString("utf8"));
		},
		async read(requests) {
			if (requests.length === 0) return new Map();
			const total = requests.reduce((sum, one) => sum + one.length, 0);
			const output = await run(
				READ_SCRIPT,
				requests.flatMap((one) => [
					one.path,
					String(one.offset),
					String(one.length),
				]),
				total + requests.length * 4096 + 1024,
			);
			return parseReads(output);
		},
	};
}
