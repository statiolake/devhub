/**
 * "Your turn" — tell the person when an Agent has finished or needs them.
 *
 * Watches the projection for an Agent that was working and has settled into
 * idle (its turn is over) or waiting (permission or input), and says so once.
 * The Dock badge and bounce (`windowAttention.ts`) are the standing signal;
 * this is the event: a notification and a sound.
 *
 * Rules, all here and all testable without Electron:
 * - Only working -> idle/waiting fires. The first sight of an Agent, a restored
 *   Agent, and a resumed conversation replaying its history never do: an Agent
 *   must have been observed working by this run first.
 * - Debounced: the new status must hold for `DEBOUNCE_MS`. A status that flaps
 *   idle for a moment between tool calls cancels itself.
 * - Not when the person is already looking: window focused and that Agent is
 *   the selection.
 */

import type { AppSnapshotWire } from "../../ipc/appShell.js";

export const DEBOUNCE_MS = 1500;

export type NotifyKind = "finished" | "waiting";

export interface AgentNotification {
	readonly agentId: string;
	readonly kind: NotifyKind;
	readonly title: string;
	readonly body: string;
	readonly sound: boolean;
}

export interface NotifierSettings {
	readonly enabled: boolean;
	readonly sound: boolean;
}

export interface NotifierHost {
	settings(): NotifierSettings;
	windowFocused(): boolean;
	snapshot(): AppSnapshotWire;
	notify(notification: AgentNotification): void;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

/** Whether the person can already see this Agent. */
export function agentIsOnScreen(
	snapshot: AppSnapshotWire,
	agentId: string,
	windowFocused: boolean,
): boolean {
	if (!windowFocused) return false;
	const selection = snapshot.selection.context;
	return selection.kind === "agent" && selection.agentId === agentId;
}

/** A short single-line excerpt, or nothing. */
export function snippet(text: string | undefined, max = 100): string {
	const line = (text ?? "").replace(/\s+/g, " ").trim();
	if (line.length <= max) return line;
	return `${line.slice(0, max - 1)}…`;
}

interface Tracked {
	armed: boolean;
	timer: unknown;
	pending: NotifyKind | undefined;
}

export class AgentNotifier {
	private readonly agents = new Map<string, Tracked>();

	constructor(private readonly host: NotifierHost) {}

	observe(snapshot: AppSnapshotWire): void {
		const seen = new Set<string>();
		for (const workspace of snapshot.workspaces) {
			for (const agent of workspace.agents) {
				seen.add(agent.id);
				let tracked = this.agents.get(agent.id);
				if (!tracked) {
					tracked = { armed: false, timer: undefined, pending: undefined };
					this.agents.set(agent.id, tracked);
				}
				this.step(tracked, agent.id, agent.status);
			}
		}
		for (const [id, tracked] of this.agents) {
			if (seen.has(id)) continue;
			this.cancel(tracked);
			this.agents.delete(id);
		}
	}

	private step(tracked: Tracked, id: string, status: string): void {
		if (status === "working") {
			tracked.armed = true;
			this.cancel(tracked);
			return;
		}
		if (status === "idle" || status === "waiting") {
			const kind: NotifyKind = status === "idle" ? "finished" : "waiting";
			if (!tracked.armed) return;
			if (tracked.pending === kind) return;
			this.cancel(tracked);
			tracked.pending = kind;
			tracked.timer = this.host.setTimer(() => {
				tracked.timer = undefined;
				tracked.pending = undefined;
				this.fire(tracked, id, kind);
			}, DEBOUNCE_MS);
			return;
		}
		// background / unknown: neither a finish nor a new start.
		this.cancel(tracked);
		if (status === "error") tracked.armed = false;
	}

	private cancel(tracked: Tracked): void {
		if (tracked.timer !== undefined) this.host.clearTimer(tracked.timer);
		tracked.timer = undefined;
		tracked.pending = undefined;
	}

	private fire(tracked: Tracked, id: string, kind: NotifyKind): void {
		tracked.armed = false;
		const settings = this.host.settings();
		if (!settings.enabled) return;
		const snapshot = this.host.snapshot();
		if (agentIsOnScreen(snapshot, id, this.host.windowFocused())) return;
		for (const workspace of snapshot.workspaces) {
			const agent = workspace.agents.find((candidate) => candidate.id === id);
			if (!agent) continue;
			const what = kind === "finished" ? "Finished" : "Waiting for permission";
			const extra = snippet(agent.activity);
			this.host.notify({
				agentId: id,
				kind,
				title: `${agent.displayName} — ${workspace.label}`,
				body: extra ? `${what}: ${extra}` : what,
				sound: settings.sound,
			});
			return;
		}
	}

	dispose(): void {
		for (const tracked of this.agents.values()) this.cancel(tracked);
		this.agents.clear();
	}
}
