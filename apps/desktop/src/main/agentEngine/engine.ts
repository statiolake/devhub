/**
 * DevHub's conversation engine: every GUI Agent's conversation, run out of
 * main.
 *
 * With two GUI Agents streaming, a quarter to two fifths of main's time went
 * to their conversations: the journal's lines parsed, the protocol adapter,
 * the fold, the events sent on (docs/process-model.md). Here, in a utility
 * process (`entry.ts`), each is the same `AgentConversation` it was in main —
 * the adapter, the fold, the held messages, the usage-limit and cache keepers
 * — and main holds a proxy (`client.ts`) that is told the conversation's
 * facts when they change and asks for anything else.
 *
 * - **The host.** For an Agent on this machine the engine follows the
 *   journal and writes to the host itself (`HostLink` on a `LocalRuntime` of
 *   its own); it asks main only where the host is and what its CLI is
 *   (`prepare-host`). For an Agent on another machine every host call is
 *   main's, whose runtime reaches that machine, and the journal's lines come
 *   from main.
 * - **The pages.** The Agents page attaches over a `MessagePort` main handed
 *   it (`page`): it is sent the snapshot and then the events of what it
 *   attached, batched per turn of this loop, without main.
 * - **What it keeps.** Nothing that a restart could lose: the journals are
 *   on disk, and a new engine replays each conversation from them. The
 *   usage-limit records are main's (`record`), handed over at `open`.
 */

import type { ConversationEvent } from "../../model/conversation.js";
import type { AgentId } from "../../model/domain.js";
import { ClaudeAdapter } from "../agent/conversation/claude/adapter.js";
import { CodexAdapter } from "../agent/conversation/codex/adapter.js";
import {
	AgentConversation,
	hostOn,
	openedLater,
	type ConversationHost,
} from "../agent/conversation/conversation.js";
import { guiAgentCli } from "../agent/conversation/hostCommand.js";
import { HostLink, type JournalLine } from "../agent/conversation/hostLink.js";
import {
	REAL_CLOCK,
	type LimitResumeClock,
	type LimitResumeRecord,
} from "../agent/conversation/limitResume.js";
import { CACHE_KEEP_OFF } from "../agent/conversation/cacheKeeper.js";
import type { ProtocolAdapter } from "../agent/conversation/protocolAdapter.js";
import type { Runtime } from "../runtime/runtime.js";
import type { CancellationToken } from "../terminal/ports.js";
import {
	errorFromWire,
	errorToWire,
	type CallMethod,
	type EngineQuestion,
	type EngineSettings,
	type EngineToPage,
	type FromEngine,
	type HostMethod,
	type OpenSpec,
	type PageToEngine,
	type PreparedHost,
	type ToEngine,
} from "./protocol.js";

/** A page's end of its port, as both Electron's `MessagePortMain` and a test's fake are. */
export interface EnginePort {
	postMessage(message: EngineToPage): void;
	on(event: "message", listener: (event: { data: unknown }) => void): unknown;
	on(event: "close", listener: () => void): unknown;
	start(): void;
	close(): void;
}

export interface EngineOptions {
	/** How a message reaches main. */
	readonly post: (message: FromEngine) => void;
	/** This machine, for the hosts of the Agents on it. */
	readonly localRuntime: () => Runtime;
	readonly clock?: LimitResumeClock;
	/** When a page's queued events are sent: after this turn of the loop; tests pass their own. */
	readonly defer?: (send: () => void) => void;
	/** How long a page's attach waits for main to open the conversation it names. */
	readonly attachWaitMs?: number;
}

interface Opened {
	readonly conversation: AgentConversation;
	record: LimitResumeRecord | undefined;
	instructions: string | undefined;
	/** The facts last told to main, as JSON: told again only when they change. */
	told: string | undefined;
}

interface Page {
	readonly port: EnginePort;
	readonly agents: Set<AgentId>;
	queued: [AgentId, number, ConversationEvent][];
}

interface Stream {
	readonly lines: JournalLine[];
	ended: { readonly error: Error | undefined } | undefined;
	wake: (() => void) | undefined;
}

const NO_SETTINGS: EngineSettings = {
	limitResume: { enabled: false, message: "" },
	cacheKeep: CACHE_KEEP_OFF,
};

export class ConversationEngine {
	readonly #options: EngineOptions;
	readonly #opened = new Map<AgentId, Opened>();
	readonly #pages = new Map<number, Page>();
	/** Attaches that came before main opened their conversation. */
	readonly #waiting = new Map<AgentId, (() => void)[]>();
	readonly #asked = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	readonly #streams = new Map<number, Stream>();
	readonly #dirty = new Set<AgentId>();
	#settings: EngineSettings = NO_SETTINGS;
	#nextAsk = 1;
	#nextStream = 1;
	#factsDue = false;

	constructor(options: EngineOptions) {
		this.#options = options;
	}

	receive(message: ToEngine, ports: readonly EnginePort[] = []): void {
		switch (message.type) {
			case "settings":
				this.#settings = message.settings;
				for (const { conversation } of this.#opened.values())
					conversation.reconsiderCacheKeeping();
				return;
			case "open":
				this.#open(message.agentId, message.spec);
				return;
			case "call":
				void this.#call(message.id, message.agentId, message.method, [
					...message.args,
				]);
				return;
			case "instructions": {
				const opened = this.#opened.get(message.agentId);
				if (opened !== undefined) opened.instructions = message.text;
				return;
			}
			case "answer": {
				const asked = this.#asked.get(message.id);
				if (asked === undefined) return;
				this.#asked.delete(message.id);
				if (message.ok) asked.resolve(message.value);
				else asked.reject(errorFromWire(message.error));
				return;
			}
			case "lines": {
				const stream = this.#streams.get(message.stream);
				if (stream === undefined) return;
				stream.lines.push(...message.lines);
				stream.wake?.();
				return;
			}
			case "lines-end": {
				const stream = this.#streams.get(message.stream);
				if (stream === undefined) return;
				stream.ended = {
					error:
						message.error === undefined
							? undefined
							: errorFromWire(message.error),
				};
				stream.wake?.();
				return;
			}
			case "page": {
				const port = ports[0];
				if (port === undefined)
					throw new Error(`page ${message.page} came without its port`);
				this.#page(message.page, port);
				return;
			}
			case "page-gone":
				this.#pageGone(message.page);
				return;
		}
	}

	#open(agentId: AgentId, spec: OpenSpec): void {
		if (this.#opened.has(agentId)) return;
		const opened: {
			record: LimitResumeRecord | undefined;
			instructions: string | undefined;
		} = { record: spec.record, instructions: spec.instructions };
		const host = spec.hostHere
			? openedLater(async () => {
					const prepared = (await this.#ask(agentId, {
						kind: "prepare-host",
					})) as PreparedHost;
					opened.instructions = prepared.instructions;
					const profile = {
						...prepared.cli,
						env: new Map(prepared.cli.env),
					};
					return hostOn(
						new HostLink(this.#options.localRuntime(), prepared.directory),
						(session) => guiAgentCli(profile, session),
					);
				})
			: this.#mainsHost(agentId);
		const adapter: ProtocolAdapter =
			spec.kind === "claude"
				? new ClaudeAdapter(spec.bootId)
				: new CodexAdapter({
						clientVersion: spec.clientVersion,
						cwd: spec.cwd,
						resumeThreadId: spec.resumeThreadId,
						developerInstructions: () => opened.instructions,
					});
		const conversation = new AgentConversation(
			host,
			adapter,
			(revision, event) => this.#published(agentId, revision, event),
			{
				settings: () => this.#settings.limitResume,
				record: {
					get: () => opened.record,
					set: (record) => {
						opened.record = record;
						this.#options.post({ type: "record", agentId, record });
					},
				},
				clock: this.#options.clock ?? REAL_CLOCK,
			},
			{
				settings: () => this.#settings.cacheKeep,
				...(this.#options.clock === undefined
					? {}
					: { clock: this.#options.clock }),
			},
		);
		const entry: Opened = Object.assign(opened, {
			conversation,
			told: undefined,
		});
		this.#opened.set(agentId, entry);
		conversation.start();
		this.#factsChanged(agentId);
		for (const waiter of this.#waiting.get(agentId) ?? []) waiter();
		this.#waiting.delete(agentId);
	}

	async #call(
		id: number,
		agentId: AgentId,
		method: CallMethod,
		args: unknown[],
	): Promise<void> {
		try {
			const opened = this.#opened.get(agentId);
			if (opened === undefined) {
				if (method === "stop") {
					this.#options.post({
						type: "result",
						id,
						ok: true,
						value: undefined,
					});
					return;
				}
				throw new Error(`the conversation of Agent ${agentId} is not open`);
			}
			const { conversation } = opened;
			let value: unknown;
			if (method === "stop") {
				this.#opened.delete(agentId);
				for (const page of this.#pages.values()) page.agents.delete(agentId);
				await conversation.stop();
			} else if (method === "snapshot") {
				value = conversation.snapshot();
			} else {
				const call = conversation[method] as (...given: unknown[]) => unknown;
				value = await call.apply(conversation, args);
			}
			this.#options.post({ type: "result", id, ok: true, value });
		} catch (error: unknown) {
			this.#options.post({
				type: "result",
				id,
				ok: false,
				error: errorToWire(error),
			});
		} finally {
			this.#factsChanged(agentId);
		}
	}

	/** Ask main something about `agentId`'s conversation. */
	#ask(agentId: AgentId, question: EngineQuestion): Promise<unknown> {
		const id = this.#nextAsk++;
		return new Promise((resolve, reject) => {
			this.#asked.set(id, { resolve, reject });
			this.#options.post({ type: "ask", id, agentId, question });
		});
	}

	/** A host whose every call is main's: an Agent on another machine. */
	#mainsHost(agentId: AgentId): ConversationHost {
		const host = (method: HostMethod, ...args: unknown[]) =>
			this.#ask(agentId, { kind: "host", method, args });
		return {
			lines: (fromOffset, cancel) => this.#lines(agentId, fromOffset, cancel),
			write: async (line, afterOffset) => {
				await host("write", line, afterOffset);
			},
			restart: async (session, mark) => {
				await host("restart", session, mark);
			},
			sleep: async (mark) => {
				await host("sleep", mark);
			},
			sentLog: async () =>
				(await host("sentLog")) as Awaited<
					ReturnType<ConversationHost["sentLog"]>
				>,
			journalSize: async () => (await host("journalSize")) as number,
		};
	}

	/** The journal of a host main follows, line by line as main sends them. */
	async *#lines(
		agentId: AgentId,
		fromOffset: number,
		cancel: CancellationToken,
	): AsyncIterable<JournalLine> {
		const id = this.#nextStream++;
		const stream: Stream = { lines: [], ended: undefined, wake: undefined };
		this.#streams.set(id, stream);
		this.#options.post({ type: "lines-open", stream: id, agentId, fromOffset });
		cancel.onCancelled(() => {
			if (!this.#streams.has(id)) return;
			this.#options.post({ type: "lines-cancel", stream: id });
			stream.ended ??= { error: undefined };
			stream.wake?.();
		});
		try {
			for (;;) {
				const line = stream.lines.shift();
				if (line !== undefined) {
					yield line;
					continue;
				}
				if (stream.ended !== undefined) {
					if (stream.ended.error !== undefined) throw stream.ended.error;
					return;
				}
				await new Promise<void>((resolve) => {
					stream.wake = resolve;
				});
				stream.wake = undefined;
			}
		} finally {
			this.#streams.delete(id);
			if (stream.ended === undefined)
				this.#options.post({ type: "lines-cancel", stream: id });
		}
	}

	#published(
		agentId: AgentId,
		revision: number,
		event: ConversationEvent,
	): void {
		if (event.type === "usage")
			this.#options.post({ type: "usage", agentId, usage: event.usage });
		for (const [pageId, page] of this.#pages) {
			if (!page.agents.has(agentId)) continue;
			if (page.queued.length === 0)
				(this.#options.defer ?? setImmediate)(() => this.#flush(pageId));
			page.queued.push([agentId, revision, event]);
		}
		this.#factsChanged(agentId);
	}

	#flush(pageId: number): void {
		const page = this.#pages.get(pageId);
		if (page === undefined || page.queued.length === 0) return;
		const batch = page.queued;
		page.queued = [];
		page.port.postMessage({ type: "events", batch });
	}

	/** Main is told the facts once this turn of the loop is over, if they changed. */
	#factsChanged(agentId: AgentId): void {
		this.#dirty.add(agentId);
		if (this.#factsDue) return;
		this.#factsDue = true;
		(this.#options.defer ?? setImmediate)(() => {
			this.#factsDue = false;
			const dirty = [...this.#dirty];
			this.#dirty.clear();
			for (const id of dirty) {
				const opened = this.#opened.get(id);
				if (opened === undefined) continue;
				const facts = opened.conversation.facts();
				const json = JSON.stringify(facts);
				if (json === opened.told) continue;
				opened.told = json;
				this.#options.post({ type: "facts", agentId: id, facts });
			}
		});
	}

	#page(pageId: number, port: EnginePort): void {
		const page: Page = { port, agents: new Set(), queued: [] };
		this.#pages.set(pageId, page);
		port.on("message", ({ data }) => {
			this.#fromPage(pageId, page, data as PageToEngine);
		});
		port.on("close", () => this.#pageGone(pageId));
		port.start();
	}

	#pageGone(pageId: number): void {
		const page = this.#pages.get(pageId);
		if (page === undefined) return;
		this.#pages.delete(pageId);
		for (const agentId of page.agents)
			this.#opened.get(agentId)?.conversation.stopEditingAll();
		page.port.close();
	}

	#fromPage(pageId: number, page: Page, message: PageToEngine): void {
		const agentId = message.agentId as AgentId;
		switch (message.type) {
			case "attach": {
				const answer = () => {
					if (this.#pages.get(pageId) !== page) return;
					const opened = this.#opened.get(agentId);
					if (opened === undefined) {
						page.port.postMessage({
							type: "attach-failed",
							rid: message.rid,
							message: `the conversation of Agent ${agentId} is not open`,
						});
						return;
					}
					// Subscribed as the snapshot is taken: no event falls between.
					page.agents.add(agentId);
					const { transcript, revision } = opened.conversation.snapshot();
					page.port.postMessage({
						type: "attached",
						rid: message.rid,
						transcript,
						revision,
					});
				};
				if (this.#opened.has(agentId)) {
					answer();
					return;
				}
				// Main opens a conversation before it answers the page, but on
				// another channel: the page's attach can overtake it.
				const waiters = this.#waiting.get(agentId) ?? [];
				let done = false;
				const once = () => {
					if (done) return;
					done = true;
					answer();
				};
				waiters.push(once);
				this.#waiting.set(agentId, waiters);
				const timer = setTimeout(once, this.#options.attachWaitMs ?? 15_000);
				(timer as { unref?: () => void }).unref?.();
				return;
			}
			case "detach":
				page.agents.delete(agentId);
				return;
		}
	}
}
