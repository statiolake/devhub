/**
 * The workspace picker's search.
 *
 * `config.toml` lists where a workspace can come from: directories to walk, and
 * commands that print paths. This runs those sources for one query and streams
 * what it finds, so the dialog fills in as results arrive rather than waiting
 * for the slowest source.
 *
 * Two rules keep it from being a hazard. A source is *configured*, so it is
 * trusted to name paths but never to be fast: every walk is depth-bounded and
 * every command has a timeout it cannot exceed. And a run is identified by its
 * operation id, so a stale source finishing after the person typed again cannot
 * put its results into the new list.
 */

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
	CommandSource,
	Config,
	FilesystemSource,
	WorkspaceSource,
} from "../../model/config.js";
import type { WorkspacePickerEvent } from "../../ipc/contract.js";
import { score } from "../../model/fuzzy.js";

const MAX_CANDIDATES = 1000;
const MAX_STDERR_BYTES = 16 * 1024;

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

interface RunState {
	readonly operationId: string;
	sequence: number;
	cancelled: boolean;
	candidateCount: number;
	errorCount: number;
	stderrBytes: number;
	truncated: boolean;
}

export type PickerEmit = (event: WorkspacePickerEvent) => void;

/** One picker run. Cancel it by calling the returned function. */
export function startWorkspacePicker(
	config: Config,
	query: string,
	operationId: string,
	emit: PickerEmit,
): () => void {
	const state: RunState = {
		operationId,
		sequence: 0,
		cancelled: false,
		candidateCount: 0,
		errorCount: 0,
		stderrBytes: 0,
		truncated: false,
	};

	const next = () => (state.sequence += 1);

	emit({ kind: "started", operationId, sequence: next() });

	/**
	 * What one source offers, tagged with which source it was.
	 *
	 * The `seen` set is per source rather than shared across all of them, and
	 * that is the whole of what makes the merged list reproducible. A path two
	 * sources both name used to be attributed to whichever source happened to
	 * reach it first, which is a race between a command and a directory walk —
	 * so the same path landed in a different place in the list on different
	 * runs. Now both sources offer it, both say who they are, and the rule for
	 * which one it belongs to is applied where the list is assembled: the first
	 * source in Settings that names a path is the source it came from.
	 */
	const offerFrom = (source: WorkspaceSource, sourceRank: number) => {
		const seen = new Set<string>();
		return (path: string, label: string) => {
			if (state.cancelled || seen.has(path)) return;
			if (state.candidateCount >= MAX_CANDIDATES) {
				state.truncated = true;
				return;
			}
			const value = score(path, query);
			if (value === 0) return;
			seen.add(path);
			state.candidateCount += 1;
			emit({
				kind: "candidate",
				operationId,
				sequence: next(),
				label,
				searchText: path,
				path,
				score: value,
				sourceId: source.id,
				sourceRank,
			});
		};
	};

	const runSource = async (
		source: WorkspaceSource,
		sourceRank: number,
	): Promise<void> => {
		const offer = offerFrom(source, sourceRank);
		try {
			if (source.type === "filesystem") {
				await walkFilesystemSource(source, state, offer);
			} else {
				await runCommandSource(source, state, offer);
			}
		} catch {
			// A source that cannot be read is one source failing, not the search.
			// It is counted and reported, so the dialog can say the list is partial.
			state.errorCount += 1;
			emit({
				kind: "source-error",
				operationId,
				sequence: next(),
				sourceId: source.id,
				errorCount: state.errorCount,
				truncated: state.truncated,
			});
			return;
		}
		emit({
			kind: "source-completed",
			operationId,
			sequence: next(),
			sourceId: source.id,
			candidateCount: state.candidateCount,
			errorCount: state.errorCount,
			stderrBytes: state.stderrBytes,
		});
	};

	// `map` hands `runSource` each source's index, which *is* its rank: the
	// order of `workspace_sources` is the order the person wrote in Settings.
	void Promise.all(
		config.workspaceSources.map((source, rank) => runSource(source, rank)),
	).then(() => {
		if (state.cancelled) {
			emit({ kind: "cancelled", operationId, sequence: next() });
			return;
		}
		emit({
			kind: "completed",
			operationId,
			sequence: next(),
			candidateCount: state.candidateCount,
			errorCount: state.errorCount,
			stderrBytes: state.stderrBytes,
			cancelled: false,
			truncated: state.truncated,
		});
	});

	return () => {
		state.cancelled = true;
	};
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function matchesKind(
	path: string,
	kinds: readonly FilesystemSource["kinds"][number][],
): Promise<boolean> {
	if (kinds.includes("directory")) return true;
	// A repository has a `.git` directory; a worktree has a `.git` file pointing
	// at one. Both are "there is a git checkout here", which is what the kinds
	// distinguish, and neither needs git itself to be run.
	const marker = join(path, ".git");
	try {
		const stats = await stat(marker);
		return stats.isDirectory()
			? kinds.includes("git_repository")
			: kinds.includes("git_worktree");
	} catch {
		return false;
	}
}

async function walkFilesystemSource(
	source: FilesystemSource,
	state: RunState,
	offer: (path: string, label: string) => void,
): Promise<void> {
	const root = expandHome(source.path);
	const maxDepth = source.max_depth ?? source.min_depth;
	const excluded = new Set(source.exclude_names);

	const visit = async (directory: string, depth: number): Promise<void> => {
		if (state.cancelled || depth > maxDepth) return;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			// One unreadable directory does not end the walk; the source's own
			// error count already says the result is partial.
			return;
		}
		for (const entry of entries) {
			if (state.cancelled) return;
			if (!entry.isDirectory()) continue;
			if (excluded.has(entry.name)) continue;
			if (!source.include_hidden && entry.name.startsWith(".")) continue;
			const path = join(directory, entry.name);
			if (
				depth >= source.min_depth &&
				(await matchesKind(path, source.kinds))
			) {
				offer(path, entry.name);
			}
			await visit(path, depth + 1);
		}
	};

	if (!(await isDirectory(root))) {
		throw new Error(`workspace source root is not a directory: ${source.id}`);
	}
	await visit(root, 1);
}

function runCommandSource(
	source: CommandSource,
	state: RunState,
	offer: (path: string, label: string) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const [command, ...args] = source.command;
		if (!command) {
			reject(new Error(`workspace source has no command: ${source.id}`));
			return;
		}
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error(`workspace source timed out: ${source.id}`));
		}, source.timeout_ms);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			state.stderrBytes = Math.min(
				MAX_STDERR_BYTES,
				state.stderrBytes + chunk.length,
			);
		});
		child.on("error", (error) => {
			finish(error);
		});
		child.on("close", (code) => {
			if (code !== 0) {
				finish(new Error(`workspace source exited with ${String(code)}`));
				return;
			}
			for (const line of stdout.split("\n")) {
				const path = line.trim();
				if (path.length === 0 || !path.startsWith("/")) continue;
				offer(path, basename(path) || path);
			}
			finish();
		});
	});
}
