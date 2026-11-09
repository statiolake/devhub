/**
 * The window's own way of saying "over here".
 *
 * The affordance is unchanged and the rule behind it is unchanged; what moved
 * is where it is drawn. It used to be a breathing ring in the App Shell page's
 * DOM, and a `WebContentsView` paints above that document — so the signal was
 * hidden for as long as there was an editor on screen, which is most of a
 * session. It is the window that says it now — a badge, and only a badge —
 * and the rule retracts.
 */

import { describe, expect, it } from "vitest";
import { WindowAttention, wantsAttention } from "./windowAttention.js";
import type { AppSnapshotWire } from "../../ipc/appShell.js";

function snapshot(options: {
	readonly unreadAgentId?: string;
	readonly selectedAgentId?: string;
}): AppSnapshotWire {
	return {
		selection: {
			context: options.selectedAgentId
				? { kind: "agent", agentId: options.selectedAgentId }
				: { kind: "global" },
		},
		workspaces: [
			{
				agents: [
					{
						id: "a",
						unread: options.unreadAgentId === "a" ? "idle" : undefined,
					},
					{
						id: "b",
						unread: options.unreadAgentId === "b" ? "idle" : undefined,
					},
				],
			},
		],
	} as unknown as AppSnapshotWire;
}

function dock() {
	const calls: string[] = [];
	return {
		calls,
		dock: {
			setBadge: (text: string) =>
				calls.push(`badge:${text === "" ? "-" : text}`),
		},
	};
}

describe("what asks for the person's attention", () => {
	it("is an unread Agent that is not the one being looked at", () => {
		expect(wantsAttention(snapshot({ unreadAgentId: "a" }))).toBe(true);
	});

	/**
	 * Opening it reads it, so this case is the retract rule: there is no second
	 * condition to keep in step, and no way for the signal to outlive its
	 * reason.
	 */
	it("is not the unread Agent the selection is already on", () => {
		expect(
			wantsAttention(snapshot({ unreadAgentId: "a", selectedAgentId: "a" })),
		).toBe(false);
	});

	it("is nothing at all when nothing is unread", () => {
		expect(wantsAttention(snapshot({}))).toBe(false);
	});
});

describe("how the window says it", () => {
	it("badges the Dock while something is waiting, and only while", () => {
		const { calls, dock: fake } = dock();
		const attention = new WindowAttention(fake);
		attention.observe(snapshot({ unreadAgentId: "a" }));
		expect(calls).toEqual(["badge:●"]);
		attention.observe(snapshot({}));
		expect(calls).toEqual(["badge:●", "badge:-"]);
	});

	it("says it once, however many times it is told the same thing", () => {
		const { calls, dock: fake } = dock();
		const attention = new WindowAttention(fake);
		attention.observe(snapshot({ unreadAgentId: "a" }));
		attention.observe(snapshot({ unreadAgentId: "a" }));
		attention.observe(snapshot({ unreadAgentId: "b" }));
		expect(calls).toEqual(["badge:●"]);
	});

	/**
	 * The Dock bounced while DevHub was not in front, and the person found it
	 * too noisy: the badge is the whole signal, and the fake Dock has no way to
	 * bounce or flash at all.
	 */
	it("asks for nothing but the badge", () => {
		const { dock: fake } = dock();
		expect(Object.keys(fake)).toEqual(["setBadge"]);
	});
});
