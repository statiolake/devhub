import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AgentNotifier,
	DEBOUNCE_MS,
	snippet,
	type AgentNotification,
} from "./agentNotifications.js";
import type { AppSnapshotWire } from "../../ipc/appShell.js";

let status = "idle";
let selected: string | undefined;
let focused = false;
let enabled = true;
let present = true;
const sent: AgentNotification[] = [];

function snap(): AppSnapshotWire {
	return {
		selection: {
			context: selected
				? { kind: "agent", agentId: selected }
				: { kind: "global" },
		},
		workspaces: present
			? [
					{
						label: "repo",
						agents: [
							{
								id: "a1",
								displayName: "Claude",
								status,
								activity: " did\n it ",
							},
						],
					},
				]
			: [],
	} as unknown as AppSnapshotWire;
}

function make(): AgentNotifier {
	return new AgentNotifier({
		settings: () => ({ enabled, sound: true }),
		windowFocused: () => focused,
		snapshot: snap,
		notify: (n) => sent.push(n),
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	status = "idle";
	selected = undefined;
	focused = false;
	enabled = true;
	present = true;
	sent.length = 0;
});
afterEach(() => vi.useRealTimers());

function go(n: AgentNotifier, next: string, ms = DEBOUNCE_MS + 1): void {
	status = next;
	n.observe(snap());
	vi.advanceTimersByTime(ms);
}

describe("agent notifications", () => {
	it("does not fire for the initial state", () => {
		const n = make();
		go(n, "idle");
		go(n, "waiting");
		expect(sent).toHaveLength(0);
	});

	it("fires once for working -> idle, with a snippet", () => {
		const n = make();
		go(n, "working");
		go(n, "idle");
		go(n, "idle");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			kind: "finished",
			title: "Claude — repo",
			body: "Finished: did it",
		});
	});

	it("labels waiting differently", () => {
		const n = make();
		go(n, "working");
		go(n, "waiting");
		expect(sent[0]?.body.startsWith("Waiting for permission")).toBe(true);
	});

	it("debounces a flap back to working", () => {
		const n = make();
		go(n, "working");
		go(n, "idle", 500);
		go(n, "working");
		vi.advanceTimersByTime(5000);
		expect(sent).toHaveLength(0);
	});

	it("is quiet when focused on that agent, loud when focused elsewhere", () => {
		const n = make();
		focused = true;
		selected = "a1";
		go(n, "working");
		go(n, "idle");
		expect(sent).toHaveLength(0);
		selected = undefined;
		go(n, "working");
		go(n, "idle");
		expect(sent).toHaveLength(1);
	});

	it("respects the setting and removed agents", () => {
		const n = make();
		enabled = false;
		go(n, "working");
		go(n, "idle");
		expect(sent).toHaveLength(0);
		enabled = true;
		go(n, "working");
		status = "idle";
		n.observe(snap());
		present = false;
		n.observe(snap());
		vi.advanceTimersByTime(5000);
		expect(sent).toHaveLength(0);
	});

	it("snippet collapses and truncates", () => {
		expect(snippet("a\n b")).toBe("a b");
		expect(snippet("x".repeat(200)).length).toBe(100);
		expect(snippet(undefined)).toBe("");
	});
});
