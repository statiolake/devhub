import { describe, expect, it } from "vitest";
import type { IpcMain, WebContents } from "electron";
import { CONVERSATION_CHANNELS } from "../../ipc/conversation.js";
import type { AgentId } from "../../model/domain.js";
import type { AgentDrafts } from "../agent/conversation/drafts.js";
import { ConversationRegistry } from "../agent/conversation/registry.js";
import type { AgentConversation } from "../agent/conversation/conversation.js";
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

function harness() {
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
	const conversation = {
		snapshot: () => ({ transcript: { entries: [] }, revision: 3 }),
	} as unknown as AgentConversation;
	const conversations = {
		registry: new ConversationRegistry(),
		of: () => Promise.resolve(conversation),
	} as unknown as GuiConversations;
	const unused = () => Promise.reject(new Error("not in this test"));
	const options: ConversationIpcOptions = {
		ipcMain,
		conversations,
		drafts: { get: () => "half a thought" } as unknown as AgentDrafts,
		agentsPage: () => page as unknown as WebContents,
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
	const ipc = registerConversationIpc(options);
	const invoke = (channel: string, ...args: unknown[]) =>
		handlers.get(channel)!({ sender: page }, ...args);
	return { ipc, page, invoke };
}

describe("words for a GUI Agent's composer", () => {
	it("are held while no page has the Agent attached, and handed out once with the attachment", async () => {
		const { ipc, page, invoke } = harness();
		ipc.insert(AGENT, "first");
		ipc.insert(AGENT, "second");
		expect(page.sent).toEqual([]);
		const attachment = await invoke(CONVERSATION_CHANNELS.attach, AGENT);
		expect(attachment).toMatchObject({
			draft: "half a thought",
			inserted: ["first", "second"],
		});
		await invoke(CONVERSATION_CHANNELS.detach, AGENT);
		const again = await invoke(CONVERSATION_CHANNELS.attach, AGENT);
		expect(again).toMatchObject({ inserted: [] });
	});

	it("go straight to the page that has the Agent attached", async () => {
		const { ipc, page, invoke } = harness();
		await invoke(CONVERSATION_CHANNELS.attach, AGENT);
		ipc.insert(AGENT, "now");
		expect(page.sent).toEqual([[CONVERSATION_CHANNELS.insert, AGENT, "now"]]);
	});
});
