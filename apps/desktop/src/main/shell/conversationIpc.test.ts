import { describe, expect, it } from "vitest";
import type { IpcMain, WebContents } from "electron";
import { CONVERSATION_CHANNELS } from "../../ipc/conversation.js";
import type { AgentId } from "../../model/domain.js";
import type { AgentDrafts } from "../agent/conversation/drafts.js";
import { ConversationRegistry } from "../agent/conversation/registry.js";
import type { ConversationHandle } from "../agent/conversation/handle.js";
import type { GuiConversations } from "./agentWiring.js";
import {
	registerConversationIpc,
	type ConversationIpcOptions,
} from "./conversationIpc.js";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" as AgentId;

/** The Agents page: what it was sent, and its lifecycle events, never fired. */
function fakePage() {
	const sent: unknown[][] = [];
	const page = {
		sent,
		send: (...args: unknown[]) => {
			sent.push(args);
		},
		isDestroyed: () => false,
		once: () => page,
		on: () => page,
	};
	return page;
}

function harness(defer?: (send: () => void) => void) {
	const handlers = new Map<
		string,
		(event: { sender: unknown }, ...args: unknown[]) => unknown
	>();
	const ipcMain = {
		handle: (
			channel: string,
			handler: (event: { sender: unknown }, ...args: unknown[]) => unknown,
		) => {
			handlers.set(channel, handler);
		},
	} as unknown as IpcMain;
	const page = fakePage();
	const agentsPage = fakePage();
	const conversation = {
		snapshot: () => ({ transcript: { entries: [] }, revision: 3 }),
	} as unknown as ConversationHandle;
	const conversations = {
		registry: new ConversationRegistry(),
		of: () => Promise.resolve(conversation),
	} as unknown as GuiConversations;
	const unused = () => Promise.reject(new Error("not in this test"));
	const options: ConversationIpcOptions = {
		ipcMain,
		...(defer === undefined ? {} : { defer }),
		conversations,
		drafts: {
			get: () => "half a thought",
			set: () => undefined,
		} as unknown as AgentDrafts,
		conversationsPage: () => page as unknown as WebContents,
		agentsPage: () => agentsPage as unknown as WebContents,
		continueIn: unused,
		restart: unused,
		resumeElsewhere: unused,
		terminalSession: unused,
		resolvePaths: unused,
		readEmbedFile: unused,
		embedSignature: unused,
		openFile: unused,
		cliDefaults: unused,
		setCliDefault: unused,
		fail: (error) => error as Error,
	};
	registerConversationIpc(options);
	const invoke = (channel: string, ...args: unknown[]) =>
		handlers.get(channel)!({ sender: page }, ...args);
	const invokeFrom = (sender: unknown, channel: string, ...args: unknown[]) =>
		handlers.get(channel)!({ sender }, ...args);
	return { page, agentsPage, invoke, invokeFrom, conversations };
}

describe("a conversation's events", () => {
	const event = (text: string) =>
		({ type: "text-delta", entry: "a1", block: 0, text }) as never;

	it("go to the page together, once the turn of the loop that made them is over, in order", async () => {
		const due: (() => void)[] = [];
		const { page, invoke, conversations } = harness((send) => due.push(send));
		let publish: (revision: number, event: never) => void = () => undefined;
		conversations.registry.open(AGENT, (made) => {
			publish = made;
			return { start: () => undefined } as unknown as ConversationHandle;
		});
		await invoke(CONVERSATION_CHANNELS.attach, AGENT);
		publish(4, event("a"));
		publish(5, event("b"));
		expect(page.sent).toEqual([]);
		expect(due).toHaveLength(1);
		due.shift()!();
		expect(page.sent).toEqual([
			[
				CONVERSATION_CHANNELS.events,
				[
					[AGENT, 4, event("a")],
					[AGENT, 5, event("b")],
				],
			],
		]);
		publish(6, event("c"));
		due.shift()!();
		expect(page.sent.at(-1)).toEqual([
			CONVERSATION_CHANNELS.events,
			[[AGENT, 6, event("c")]],
		]);
	});

	it("of an Agent the page has not attached are not sent", async () => {
		const due: (() => void)[] = [];
		const { page, conversations } = harness((send) => due.push(send));
		let publish: (revision: number, event: never) => void = () => undefined;
		conversations.registry.open(AGENT, (made) => {
			publish = made;
			return { start: () => undefined } as unknown as ConversationHandle;
		});
		publish(4, event("a"));
		expect(due).toEqual([]);
		expect(page.sent).toEqual([]);
	});
});

describe("which pages reach the conversations", () => {
	it("draws them on the Conversations page, and answers the Agents page's requests about them", async () => {
		const { page, agentsPage, invokeFrom } = harness();
		// The Agents page asks — a terminal Agent's failure carries it on in
		// the GUI — without drawing a conversation.
		await expect(
			invokeFrom(agentsPage, CONVERSATION_CHANNELS.saveDraft, AGENT, "words"),
		).resolves.toBeUndefined();
		await expect(
			invokeFrom({}, CONVERSATION_CHANNELS.saveDraft, AGENT, "words"),
		).rejects.toThrow(/only the Conversations and Agents pages/);
		await invokeFrom(page, CONVERSATION_CHANNELS.attach, AGENT);
		expect(agentsPage.sent).toEqual([]);
	});
});
