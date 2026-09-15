/**
 * The window's own way of saying "over here".
 *
 * The affordance is unchanged and the rule behind it is unchanged; what moved
 * is where it is drawn. It used to be a breathing ring in the App Shell page's
 * DOM, and a `WebContentsView` paints above that document — so the signal was
 * hidden for as long as there was an editor on screen, which is most of a
 * session. It is the window that says it now, and these are the two things
 * that has to keep true: the rule retracts, and nobody is bounced at while
 * they are already looking.
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
	let next = 1;
	return {
		calls,
		dock: {
			setBadge: (text: string) =>
				calls.push(`badge:${text === "" ? "-" : text}`),
			bounce: (type: "critical" | "informational") => {
				calls.push(`bounce:${type}`);
				return next++;
			},
			cancelBounce: (id: number) => calls.push(`cancel:${id}`),
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
		attention.windowFocusChanged(true);
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
		expect(calls.filter((call) => call.startsWith("badge:"))).toEqual([
			"badge:●",
		]);
	});

	/**
	 * A critical bounce runs until the *application* is activated. Raising one
	 * while DevHub is already the front application is a bounce macOS will not
	 * stop on its own, at somebody who is looking at the thing it is about.
	 */
	it("does not bounce at a window that already has the focus", () => {
		const { calls, dock: fake } = dock();
		const attention = new WindowAttention(fake);
		attention.windowFocusChanged(true);
		attention.observe(snapshot({ unreadAgentId: "a" }));
		expect(calls).toEqual(["badge:●"]);
	});

	it("bounces once the window goes away, and stops when it comes back", () => {
		const { calls, dock: fake } = dock();
		const attention = new WindowAttention(fake);
		attention.windowFocusChanged(true);
		attention.observe(snapshot({ unreadAgentId: "a" }));
		attention.windowFocusChanged(false);
		expect(calls).toEqual(["badge:●", "bounce:critical"]);
		attention.windowFocusChanged(true);
		expect(calls).toEqual(["badge:●", "bounce:critical", "cancel:1"]);
	});

	it("stops bouncing when the reason goes, not only when the window returns", () => {
		const { calls, dock: fake } = dock();
		const attention = new WindowAttention(fake);
		attention.windowFocusChanged(false);
		attention.observe(snapshot({ unreadAgentId: "a" }));
		attention.observe(snapshot({}));
		expect(calls).toEqual([
			"badge:●",
			"bounce:critical",
			"badge:-",
			"cancel:1",
		]);
	});
});
