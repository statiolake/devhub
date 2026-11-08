/**
 * The GUI Agents' conversations in this DevHub, one per Agent.
 *
 * A conversation exists from the first time anything asks for it — the round
 * that first finds its Agent's session, or the page attaching — until its
 * Agent is stopped or ends. It is never remembered across a restart: the host
 * is, and a new conversation on the same host replays to the same transcript
 * (see `conversation.ts`), so there is nothing here worth keeping.
 *
 * Every conversation's events leave through one listener list, tagged with
 * their Agent, so the page is fed from one place — for a conversation run in
 * main (`localHandle`). One run in the conversation engine feeds its page
 * directly, and main is told only of its usage (`onUsage`, which every
 * conversation reports, wherever it runs).
 */

export type ConversationUsageListener = (
	agentId: AgentId,
	usage: Usage,
) => void;

import type { ConversationEvent, Usage } from "../../../model/conversation.js";
import type { AgentId } from "../../../model/domain.js";
import type { ConversationPublish } from "./conversation.js";
import type { ConversationHandle } from "./handle.js";

export type ConversationEventListener = (
	agentId: AgentId,
	revision: number,
	event: ConversationEvent,
) => void;

export class ConversationRegistry {
	readonly #conversations = new Map<AgentId, ConversationHandle>();
	readonly #listeners = new Set<ConversationEventListener>();
	readonly #usage = new Set<ConversationUsageListener>();

	get(agentId: AgentId): ConversationHandle | undefined {
		return this.#conversations.get(agentId);
	}

	/** The Agent's conversation, made and started by `create` if it has none. */
	open(
		agentId: AgentId,
		create: (publish: ConversationPublish) => ConversationHandle,
	): ConversationHandle {
		const existing = this.#conversations.get(agentId);
		if (existing !== undefined) return existing;
		const conversation = create((revision, event) => {
			for (const listener of this.#listeners)
				listener(agentId, revision, event);
			if (event.type === "usage") this.usage(agentId, event.usage);
		});
		this.#conversations.set(agentId, conversation);
		conversation.start();
		return conversation;
	}

	/** Stop following the Agent's host, and forget the conversation. The host is untouched. */
	async close(agentId: AgentId): Promise<void> {
		const conversation = this.#conversations.get(agentId);
		if (conversation === undefined) return;
		this.#conversations.delete(agentId);
		await conversation.stop();
	}

	/** `[agents] auto_compact_*` may have changed: every conversation judges itself again. */
	reconsiderCacheKeeping(): void {
		for (const conversation of this.#conversations.values())
			conversation.reconsiderCacheKeeping();
	}

	/** Every conversation open now, by Agent. */
	entries(): IterableIterator<[AgentId, ConversationHandle]> {
		return this.#conversations.entries();
	}

	/**
	 * Forget every conversation without stopping it: they are gone already
	 * (the engine that ran them ended), and the next ask makes each anew.
	 */
	forgetAll(): void {
		this.#conversations.clear();
	}

	/** A conversation's usage changed (`onUsage`). */
	usage(agentId: AgentId, usage: Usage): void {
		for (const listener of this.#usage) listener(agentId, usage);
	}

	onUsage(listener: ConversationUsageListener): () => void {
		this.#usage.add(listener);
		return () => this.#usage.delete(listener);
	}

	onEvent(listener: ConversationEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
