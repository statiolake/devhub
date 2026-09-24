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
 * their Agent, so the page is fed from one place.
 */

import type { ConversationEvent } from "../../../model/conversation.js";
import type { AgentId } from "../../../model/domain.js";
import type { AgentConversation, ConversationPublish } from "./conversation.js";

export type ConversationEventListener = (
	agentId: AgentId,
	revision: number,
	event: ConversationEvent,
) => void;

export class ConversationRegistry {
	readonly #conversations = new Map<AgentId, AgentConversation>();
	readonly #listeners = new Set<ConversationEventListener>();

	get(agentId: AgentId): AgentConversation | undefined {
		return this.#conversations.get(agentId);
	}

	/** The Agent's conversation, made and started by `create` if it has none. */
	open(
		agentId: AgentId,
		create: (publish: ConversationPublish) => AgentConversation,
	): AgentConversation {
		const existing = this.#conversations.get(agentId);
		if (existing !== undefined) return existing;
		const conversation = create((revision, event) => {
			for (const listener of this.#listeners)
				listener(agentId, revision, event);
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

	onEvent(listener: ConversationEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
