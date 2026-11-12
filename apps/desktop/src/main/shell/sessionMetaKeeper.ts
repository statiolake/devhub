/**
 * Keeps `session-meta.json` (`model/sessionMeta.ts`) in step with the
 * Agents, so an Agent's metadata outlives it under the CLI session it ran.
 *
 * - **On every save** (`sweep`): an Agent whose pairs or name changed since
 *   the sweep last saw it has them written down under its session — the one
 *   its record resumed (`resumedSession`), else the one its CLI names
 *   (`sessionOf`, asked only once it has pairs). So they are there once it is
 *   stopped, and once it is closed (`closed` writes them again then).
 * - **An Agent started since DevHub did on a session with pairs** and none
 *   of its own — New Agent's earlier sessions, `agent resume`, Reopen
 *   Closed — is given them back (`restore`), the way `sweepSessionNames`
 *   gives a name back; `/resume` inside a GUI Agent says so (`resumedIn`).
 *   An Agent of the state file DevHub started with was seen before
 *   (`seed`), so it is not.
 * - **Listings** (`known`) read the index with the live Agents' own pairs over
 *   it, and say which Agent runs a session now.
 * - **A stopped session's pairs** are set by `set`, checked as an Agent's
 *   are; a session an Agent runs now is refused, its pairs being the Agent's.
 */

import { NO_META, withMeta, type AgentMeta } from "../../model/agentMeta.js";
import type { SessionNameKind } from "../../model/sessionNames.js";
import { modelOverride } from "../../model/agentModel.js";
import { resumedSession } from "../agent/conversation/resume.js";
import type { SessionMetaFile } from "../agent/conversation/sessionMetaFile.js";

/** What the keeper reads of an Agent; the model's `Agent` is one. */
export interface KeptAgent {
	readonly id: string;
	readonly profile: {
		readonly id?: string;
		readonly kind: string;
		readonly args: readonly string[];
	};
	readonly presentation: string;
	readonly meta: AgentMeta;
	/** Under the orchestrator's management (`Agent.managed`). */
	readonly managed: boolean;
	readonly displayName: string;
	readonly named: boolean;
}

export interface SessionMetaKeeperPorts {
	/** Every Agent open now. */
	agents(): readonly KeptAgent[];
	/** The CLI session an Agent runs, as its CLI names it; undefined: not yet. */
	sessionOf(agentId: string): Promise<string | undefined>;
	/** Give an Agent these pairs and its managed flag (after the save that found them). */
	restore(agentId: string, meta: AgentMeta, managed: boolean): void;
	/**
	 * The configured profile's own arguments, to tell the model an Agent was
	 * given over them (`modelOverride`); undefined: no such profile now.
	 */
	profileArgs?(profileId: string): readonly string[] | undefined;
}

export interface KnownSession {
	readonly meta?: AgentMeta;
	readonly managed?: boolean;
	/** The model it ran on over its profile's own (`model/agentModel.ts`). */
	readonly model?: string;
	/** The Agent running it now. */
	readonly liveAgentId?: string;
}

export class SessionMetaKeeper {
	/** The CLI session each Agent is known to run. */
	readonly #sessions = new Map<
		string,
		{ readonly kind: SessionNameKind; readonly session: string }
	>();
	/** The Agents the sweep has seen, and what it last wrote for each. */
	readonly #swept = new Map<string, string | undefined>();
	/** Sessions being asked for, so a test (or a quit) can wait for them. */
	readonly #pending = new Set<Promise<void>>();

	constructor(
		readonly index: SessionMetaFile,
		private readonly ports: SessionMetaKeeperPorts,
	) {}

	/** These Agents were there before anybody could start one on a session. */
	seed(agentIds: Iterable<string>): void {
		for (const agentId of agentIds)
			if (!this.#swept.has(agentId)) this.#swept.set(agentId, undefined);
	}

	/** The model `agent` was given over its profile's own, if it was given one. */
	modelOf(agent: KeptAgent): string | undefined {
		if (agent.profile.kind !== "claude") return undefined;
		return modelOverride(
			agent.profile.args,
			agent.profile.id === undefined
				? undefined
				: this.ports.profileArgs?.(agent.profile.id),
		);
	}

	sweep(): void {
		const agents = this.ports.agents();
		for (const agent of agents) {
			const kind = cliKind(agent.profile.kind);
			if (kind === undefined) continue;
			const resumed = resumedSession(kind, agent.profile.args);
			if (resumed !== undefined)
				this.#sessions.set(agent.id, { kind, session: resumed });
			const seen = this.#swept.has(agent.id);
			if (
				!seen &&
				resumed !== undefined &&
				Object.keys(agent.meta).length === 0 &&
				!agent.managed
			) {
				const record = this.index.of(kind, resumed);
				if (record !== undefined) {
					const managed = record.managed === true;
					this.#swept.set(
						agent.id,
						signature(record.meta, { ...agent, managed }, this.modelOf(agent)),
					);
					this.ports.restore(agent.id, record.meta, managed);
					continue;
				}
			}
			const now = signature(agent.meta, agent, this.modelOf(agent));
			if (seen && this.#swept.get(agent.id) === now) continue;
			this.#swept.set(agent.id, now);
			const known = this.#sessions.get(agent.id)?.session;
			if (known !== undefined) {
				this.#write(agent.id, kind, known);
				continue;
			}
			// Nothing to write down yet, and no session asked for.
			if (
				Object.keys(agent.meta).length === 0 &&
				!agent.managed &&
				this.modelOf(agent) === undefined
			)
				continue;
			const agentId = agent.id;
			this.#track(
				this.ports.sessionOf(agentId).then((session) => {
					if (session === undefined) {
						// Not named yet by its CLI: asked again on a later save.
						if (agent.presentation === "gui") this.#swept.delete(agentId);
						return;
					}
					this.#write(agentId, kind, session);
				}),
			);
		}
		for (const agentId of [...this.#swept.keys()]) {
			if (!agents.some((agent) => agent.id === agentId)) {
				this.#swept.delete(agentId);
				this.#sessions.delete(agentId);
			}
		}
	}

	/** An Agent is being closed on `session`: its pairs and name, written down. */
	closed(agent: KeptAgent, session: string | undefined): void {
		const kind = cliKind(agent.profile.kind);
		if (kind === undefined || session === undefined) return;
		this.index.remember(
			kind,
			session,
			agent.meta,
			{ name: agent.displayName, named: agent.named },
			agent.managed,
			this.modelOf(agent),
		);
	}

	/**
	 * `/resume` in a GUI Agent went on with `session`: the pairs and the
	 * managed flag to give it, when it has neither of its own and the session
	 * has some.
	 */
	resumedIn(
		agent: KeptAgent,
		session: string,
	): { readonly meta: AgentMeta; readonly managed: boolean } | undefined {
		const kind = cliKind(agent.profile.kind);
		if (kind === undefined) return undefined;
		this.#sessions.set(agent.id, { kind, session });
		const record = this.index.of(kind, session);
		if (
			record === undefined ||
			Object.keys(agent.meta).length > 0 ||
			agent.managed
		)
			return undefined;
		const managed = record.managed === true;
		this.#swept.set(
			agent.id,
			signature(record.meta, { ...agent, managed }, this.modelOf(agent)),
		);
		return { meta: record.meta, managed };
	}

	/** The CLI session an open Agent is known to run, if it is. */
	sessionKnown(agentId: string): string | undefined {
		return this.#sessions.get(agentId)?.session;
	}

	/** The sessions of `kind` whose pairs or Agent are known. */
	known(kind: SessionNameKind): Map<string, KnownSession> {
		const known = new Map<string, KnownSession>();
		for (const record of this.index.records)
			if (record.kind === kind)
				known.set(record.session, {
					meta: record.meta,
					...(record.managed === true ? { managed: true } : {}),
					...(record.model === undefined ? {} : { model: record.model }),
				});
		const agents = new Map(
			this.ports.agents().map((agent) => [agent.id, agent] as const),
		);
		for (const [agentId, place] of this.#sessions) {
			const agent = agents.get(agentId);
			if (agent === undefined || place.kind !== kind) continue;
			const model = this.modelOf(agent);
			known.set(place.session, {
				meta: agent.meta,
				...(agent.managed ? { managed: true } : {}),
				...(model === undefined ? {} : { model }),
				liveAgentId: agent.id,
			});
		}
		return known;
	}

	/**
	 * Set (or, with undefined, remove) one pair of a session no Agent runs
	 * now; answers its pairs. `given` is the person-given name the session is
	 * known by, for a session the index has no entry for yet.
	 */
	async set(
		kind: string,
		session: string,
		key: string,
		value: string | undefined,
		given?: string,
	): Promise<AgentMeta> {
		const cli = cliKind(kind);
		if (cli === undefined)
			throw new Error(`a ${kind} session has no metadata.`);
		// Every Agent of the CLI asked which session it runs, so a live one is
		// never edited behind its back (its own pairs win on the next sweep).
		await Promise.all(
			this.ports
				.agents()
				.filter(
					(agent) =>
						agent.profile.kind === cli && !this.#sessions.has(agent.id),
				)
				.map(async (agent) => {
					const found = await this.ports.sessionOf(agent.id);
					if (found !== undefined)
						this.#sessions.set(agent.id, { kind: cli, session: found });
				}),
		);
		for (const [agentId, place] of this.#sessions) {
			if (place.kind === cli && place.session === session)
				throw new Error(
					`session ${session} is agent ${agentId}'s, running now: use 'agent meta ${agentId}'.`,
				);
		}
		const record = this.index.of(cli, session);
		const meta = withMeta(record?.meta ?? NO_META, key, value);
		const name =
			record?.name !== undefined
				? { name: record.name, named: record.named === true }
				: given === undefined
					? undefined
					: { name: given, named: true };
		this.index.remember(
			cli,
			session,
			meta,
			name,
			record?.managed === true,
			record?.model,
		);
		return meta;
	}

	/** Every session lookup the sweeps started, finished. */
	async settled(): Promise<void> {
		while (this.#pending.size > 0) await Promise.all([...this.#pending]);
	}

	#track(work: Promise<void>): void {
		const tracked = work.catch((error: unknown) => {
			console.warn(
				`[devhub] an Agent's session metadata could not be written down: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		this.#pending.add(tracked);
		void tracked.finally(() => this.#pending.delete(tracked));
	}

	#write(agentId: string, kind: SessionNameKind, session: string): void {
		const agent = this.ports.agents().find((one) => one.id === agentId);
		if (agent === undefined) return;
		this.#sessions.set(agentId, { kind, session });
		this.index.remember(
			kind,
			session,
			agent.meta,
			{ name: agent.displayName, named: agent.named },
			agent.managed,
			this.modelOf(agent),
		);
	}
}

function cliKind(kind: string): SessionNameKind | undefined {
	return kind === "claude" || kind === "codex" ? kind : undefined;
}

/** What the sweep compares to tell an Agent's pairs or name changed. */
function signature(
	meta: AgentMeta,
	agent: Pick<KeptAgent, "displayName" | "named" | "managed">,
	model?: string,
): string {
	return JSON.stringify([
		meta,
		agent.displayName,
		agent.named,
		agent.managed,
		model ?? null,
	]);
}
