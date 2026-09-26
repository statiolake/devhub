/**
 * A GUI Agent's conversation, read as the round reads a screen: a status, what
 * it says it is doing, and whether anything is wrong with it.
 */

import { describe, expect, it } from "vitest";
import {
	EMPTY_TRANSCRIPT,
	applyEvents,
	entryId,
	type ConversationEvent,
} from "../../../model/conversation.js";
import { HostLinkFailure } from "./hostLink.js";
import { observeConversation } from "./reading.js";

const running: ConversationEvent[] = [
	{ type: "state", state: { phase: "ready", turn: "running" } },
	{
		type: "entry",
		entry: {
			kind: "tool",
			id: entryId("tool:1"),
			parent: null,
			tool: "Bash",
			title: "Bash: npm test",
			input: {},
			status: "running",
			output: undefined,
			spawns: undefined,
			background: undefined,
			outsideSandbox: false,
			plan: undefined,
		},
	},
];

describe("reading a conversation", () => {
	it("is its status and activity, with nothing wrong", () => {
		expect(
			observeConversation({
				transcript: applyEvents(EMPTY_TRANSCRIPT, running),
				lost: undefined,
				crashed: undefined,
			}),
		).toEqual({
			status: "working",
			activity: "Bash: npm test",
			failure: undefined,
		});
	});

	it("is unknown while connecting, as a screen nobody has read", () => {
		expect(
			observeConversation({
				transcript: EMPTY_TRANSCRIPT,
				lost: undefined,
				crashed: undefined,
			}),
		).toEqual({
			status: "unknown",
			activity: undefined,
			failure: undefined,
		});
	});

	it("is unknown, and says the host is lost, while the journal cannot be followed", () => {
		const lost = new HostLinkFailure("stream_lost", "the journal stopped", 120);
		expect(
			observeConversation({
				transcript: applyEvents(EMPTY_TRANSCRIPT, running),
				lost,
				crashed: undefined,
			}),
		).toEqual({
			status: "unknown",
			activity: undefined,
			failure: {
				code: "conversation_host_lost",
				detail: "the journal stopped",
			},
		});
	});

	it("is an error, saying what went wrong, when DevHub could not follow it at all", () => {
		expect(
			observeConversation({
				transcript: applyEvents(EMPTY_TRANSCRIPT, running),
				lost: undefined,
				crashed: new Error("home() did not answer"),
			}),
		).toEqual({
			status: "error",
			activity: undefined,
			failure: {
				code: "conversation_failed",
				detail: "home() did not answer",
			},
		});
	});

	it("is an error, with the mismatch in DevHub's own words, once broken", () => {
		const transcript = applyEvents(EMPTY_TRANSCRIPT, [
			...running,
			{
				type: "state",
				state: {
					phase: "broken",
					failure: {
						code: "protocol_mismatch",
						detail: "assistant.message.content: expected an array",
					},
				},
			},
		]);
		expect(
			observeConversation({ transcript, lost: undefined, crashed: undefined }),
		).toEqual({
			status: "error",
			activity: undefined,
			failure: {
				code: "conversation_protocol_mismatch",
				detail: "assistant.message.content: expected an array",
			},
		});
	});
});
