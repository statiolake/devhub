/**
 * The token usage service as the app runs it: which folders it reads, who ran
 * each session, and where its index is kept.
 *
 * - **Folders**: for every machine DevHub has a Workspace on (this Mac
 *   always), each Claude and Codex profile's folder there — its
 *   `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, the profile's own before the
 *   machine's, else `~/.claude`, `~/.codex` — each once.
 * - **Who**: each reading first writes down the session every Agent runs now
 *   (asked of its CLI no more often than `SESSION_EVERY_MS` per Agent), so
 *   the tokens are its after it is gone.
 * - **The index**: `token-usage.json` in DevHub's user data folder, replaced
 *   whole by a rename.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfiguredAgentProfile } from "../../model/config.js";
import type { SessionOwner } from "../../model/tokenReport.js";
import type { TokenCli } from "../../model/tokenTranscripts.js";
import type { TokenQueryWire, TokenReportWire } from "../../ipc/tokenUsage.js";
import {
	claudeConfigDirectory,
	codexHome,
	type SessionProfile,
} from "../agent/conversation/resume.js";
import type { Runtime } from "../runtime/runtime.js";
import {
	runtimeTranscriptMachine,
	type TranscriptMachine,
} from "./transcriptMachine.js";
import {
	TokenUsageService,
	type TokenReportContext,
	type TokenSource,
} from "./tokenUsageService.js";

/** A running Agent's session is asked of its CLI again after this long. */
export const SESSION_EVERY_MS = 30_000;

export interface TokenUsagePorts {
	readonly userDataPath: string;
	profiles(): readonly ConfiguredAgentProfile[];
	/** This Mac, and every SSH host a Workspace is open on. */
	machines(): readonly { readonly id: string; readonly runtime: Runtime }[];
	/** Every Claude and Codex Agent open now, and who it is. */
	agents(): readonly {
		readonly id: string;
		readonly cli: TokenCli;
		readonly owner: SessionOwner;
	}[];
	/** The CLI session an Agent runs, as its CLI says; undefined: not yet. */
	sessionOf(agentId: string): Promise<string | undefined>;
	context(): TokenReportContext;
}

export interface TokenUsage {
	/** A report, after a reading (bounded by `deadlineMs`). */
	report(
		query: TokenQueryWire,
		options?: { readonly remote?: "due" | "now"; readonly deadlineMs?: number },
	): Promise<TokenReportWire>;
	save(): Promise<void>;
}

const sessionProfile = (profile: ConfiguredAgentProfile): SessionProfile => ({
	kind: profile.kind,
	command: profile.command,
	args: profile.args,
	env: new Map(Object.entries(profile.env)),
});

export function startTokenUsage(ports: TokenUsagePorts): TokenUsage {
	const path = join(ports.userDataPath, "token-usage.json");
	const machines = new Map<string, TranscriptMachine>();
	const sessions = new Map<string, { session?: string; at: number }>();
	const service = new TokenUsageService({
		now: Date.now,
		load: async () => {
			try {
				return JSON.parse(await readFile(path, "utf8")) as unknown;
			} catch {
				return undefined;
			}
		},
		save: async (value) => {
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${String(process.pid)}.tmp`;
			await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
			await rename(temporary, path);
		},
		sources: async () => {
			const kinds = ports
				.profiles()
				.filter((one) => one.kind === "claude" || one.kind === "codex");
			const found = await Promise.all(
				ports.machines().flatMap(({ id, runtime }) =>
					kinds.map(async (profile): Promise<TokenSource | undefined> => {
						try {
							const cli = profile.kind as TokenCli;
							const root =
								cli === "claude"
									? await claudeConfigDirectory(
											runtime,
											sessionProfile(profile),
										)
									: await codexHome(runtime, sessionProfile(profile));
							let machine = machines.get(id);
							if (machine === undefined) {
								machine = runtimeTranscriptMachine(runtime);
								machines.set(id, machine);
							}
							return { root: { machine: id, cli, root }, machine };
						} catch {
							// A host that cannot say its home now is read at a later reading.
							return undefined;
						}
					}),
				),
			);
			const seen = new Set<string>();
			return found.filter((one): one is TokenSource => {
				if (one === undefined) return false;
				const key = `${one.root.machine}\u0000${one.root.cli}\u0000${one.root.root}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		},
	});

	/** Who runs what now, asked of each Agent's CLI at most every 30 s. */
	const observe = async () => {
		const now = Date.now();
		const agents = ports.agents();
		const running = await Promise.all(
			agents.map(async (agent) => {
				const known = sessions.get(agent.id);
				let session = known?.session;
				if (known === undefined || now - known.at >= SESSION_EVERY_MS) {
					session = await ports.sessionOf(agent.id).catch(() => known?.session);
					sessions.set(agent.id, {
						...(session === undefined ? {} : { session }),
						at: now,
					});
				}
				return session === undefined
					? undefined
					: { cli: agent.cli, session, owner: agent.owner };
			}),
		);
		for (const id of sessions.keys())
			if (!agents.some((agent) => agent.id === id)) sessions.delete(id);
		service.observe(running.filter((one) => one !== undefined));
	};

	return {
		async report(query, options = {}) {
			const reading = (async () => {
				await observe();
				await service.refresh({ remote: options.remote ?? "due" });
			})();
			// A slow host never holds the answer up: it is given with what is
			// read so far, and the reading goes on.
			await Promise.race([
				reading.catch(() => undefined),
				new Promise((resolve) => {
					const timer = setTimeout(resolve, options.deadlineMs ?? 10_000);
					(timer as unknown as { unref?: () => void }).unref?.();
				}),
			]);
			return service.report(query, ports.context());
		},
		save: () => service.save(),
	};
}
