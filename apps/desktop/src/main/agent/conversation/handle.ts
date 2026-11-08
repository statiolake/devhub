/**
 * A GUI Agent's conversation as the rest of main holds it, wherever it runs.
 *
 * The conversation itself — the adapter, the fold, the journal followed, the
 * held messages, the usage-limit and cache keepers — runs in DevHub's
 * conversation engine, a utility process (`main/agentEngine/`), and main holds
 * a proxy with this surface. When the engine cannot be had (it kept dying, or
 * a test wires the Agents without one) it runs in main, behind the same
 * surface (`localHandle`).
 *
 * What main reads synchronously is `facts()`, which the engine pushes when it
 * changes; everything that reads entries (`snapshot`) is a request. Pages do
 * not read the conversation through this at all when `pagePort` is set: they
 * attach to the engine directly, so a transcript never passes main.
 */

import type {
	EntryId,
	ImageRef,
	McpSignIn,
	PendingId,
	RewindOutcome,
	Transcript,
} from "../../../model/conversation.js";
import type { AgentConversation, ConversationFacts } from "./conversation.js";
import type { ConversationCommand, SettingName } from "./protocolAdapter.js";

export interface ConversationSnapshot {
	readonly transcript: Transcript;
	readonly revision: number;
}

export interface ConversationHandle {
	start(): void;
	/** Follow the journal again if the link was lost (`AgentConversation.reattach`). Once a round. */
	reattach(): void;
	/** The round's reading of it, its session and its MCP servers, as last known. */
	facts(): ConversationFacts;
	/** Everything up to `revision`. A request: the transcript is the engine's. */
	snapshot(): Promise<ConversationSnapshot>;
	/**
	 * Whether pages attach to this conversation through the engine's port
	 * (`ipc/conversation.ts`) rather than through main.
	 */
	readonly pagePort: boolean;
	command(command: ConversationCommand): Promise<void>;
	rewind(message: EntryId): Promise<RewindOutcome>;
	submit(text: string, images: readonly ImageRef[]): Promise<void>;
	startEditingPending(id: PendingId): Promise<void>;
	editPending(id: PendingId, text: string): Promise<void>;
	stopEditingPending(id: PendingId): Promise<void>;
	stopEditingAll(): void;
	removePending(id: PendingId): Promise<void>;
	sendPendingNow(id: PendingId): Promise<void>;
	showSignIn(signIn: McpSignIn | undefined): Promise<void>;
	cancelLimitResume(): Promise<void>;
	reconsiderCacheKeeping(): void;
	resumeSession(session: string, history: readonly string[]): Promise<void>;
	restart(): Promise<void>;
	configure(which: SettingName, id: string): Promise<void>;
	/** Stop following the host; the host is untouched. */
	stop(): Promise<void>;
}

/** A conversation run here, in this process, behind the handle's surface. */
export function localHandle(
	conversation: AgentConversation,
): ConversationHandle {
	return {
		pagePort: false,
		start: () => conversation.start(),
		reattach: () => conversation.reattach(),
		facts: () => conversation.facts(),
		snapshot: () => Promise.resolve(conversation.snapshot()),
		command: (command) => conversation.command(command),
		rewind: (message) => conversation.rewind(message),
		submit: (text, images) => conversation.submit(text, images),
		startEditingPending: (id) => conversation.startEditingPending(id),
		editPending: (id, text) => conversation.editPending(id, text),
		stopEditingPending: (id) => conversation.stopEditingPending(id),
		stopEditingAll: () => conversation.stopEditingAll(),
		removePending: (id) => conversation.removePending(id),
		sendPendingNow: (id) => conversation.sendPendingNow(id),
		showSignIn: (signIn) => conversation.showSignIn(signIn),
		cancelLimitResume: () => conversation.cancelLimitResume(),
		reconsiderCacheKeeping: () => conversation.reconsiderCacheKeeping(),
		resumeSession: (session, history) =>
			conversation.resumeSession(session, history),
		restart: () => conversation.restart(),
		configure: (which, id) => conversation.configure(which, id),
		stop: () => conversation.stop(),
	};
}
