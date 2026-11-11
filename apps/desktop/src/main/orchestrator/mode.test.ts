/**
 * The Orchestrator's three modes (`mode.ts`): the transitions, the automatic
 * switch on the usage readout, saving's nudge gating in the dispatcher, and
 * off at every launch.
 */

import { describe, expect, it } from "vitest";
import type { UsageLimitsWire } from "../../ipc/contract.js";
import { DEFAULT_ORCHESTRATOR } from "../../model/orchestratorSettings.js";
import { EscalationStore } from "./escalationStore.js";
import { EventDispatcher, type OrchestratorEvent } from "./events.js";
import {
	LAUNCH_MODE,
	OrchestratorModeControl,
	SAVING_INTERVAL_FACTOR,
	savingNotice,
	usageOver,
	type UsageOver,
} from "./mode.js";
import { OrchestratorService } from "./orchestratorService.js";

const NOW = Date.UTC(2026, 10, 10, 12, 0);
const HOUR = 3_600_000;

function limits(
	windows: readonly {
		cli?: "claude" | "codex";
		window: string;
		used: number;
		resetsAt?: number;
	}[],
): UsageLimitsWire {
	const clis = (["claude", "codex"] as const).map((cli) => ({
		cli,
		windows: windows
			.filter((one) => (one.cli ?? "claude") === cli)
			.map((one) => ({
				window: one.window,
				usedPercent: one.used,
				...(one.resetsAt === undefined ? {} : { resetsAt: one.resetsAt }),
			})),
	}));
	return { clis };
}

const OVER: UsageOver = {
	cli: "claude",
	window: "5-hour",
	usedPercent: 82,
	threshold: 80,
	resetsAt: NOW + HOUR,
};

describe("the window over the threshold", () => {
	it("is the highest one at or over it, in its current period", () => {
		expect(
			usageOver(
				limits([
					{ window: "5-hour", used: 81, resetsAt: NOW + HOUR },
					{ window: "7-day", used: 90, resetsAt: NOW + 72 * HOUR },
				]),
				80,
				NOW,
			),
		).toMatchObject({ window: "7-day", usedPercent: 90, threshold: 80 });
	});

	it("counts the weekly and the 5-hour alike, and Codex's too", () => {
		expect(
			usageOver(limits([{ window: "7-day", used: 80 }]), 80, NOW),
		).toMatchObject({ window: "7-day" });
		expect(
			usageOver(
				limits([{ cli: "codex", window: "primary", used: 95 }]),
				80,
				NOW,
			),
		).toMatchObject({ cli: "codex" });
	});

	it("is none below it, or once the window's reset has passed", () => {
		expect(
			usageOver(limits([{ window: "5-hour", used: 79.9 }]), 80, NOW),
		).toBeUndefined();
		expect(
			usageOver(
				limits([{ window: "5-hour", used: 99, resetsAt: NOW - 1 }]),
				80,
				NOW,
			),
		).toBeUndefined();
		expect(usageOver({ clis: [] }, 80, NOW)).toBeUndefined();
	});
});

describe("the mode's transitions", () => {
	it("starts off at launch", () => {
		expect(LAUNCH_MODE).toBe("off");
		expect(new OrchestratorModeControl().mode).toBe("off");
	});

	it("goes where the person chooses, between all three", () => {
		const control = new OrchestratorModeControl();
		expect(control.choose("full", undefined)).toEqual([
			{ by: "person", from: "off", to: "full" },
		]);
		expect(control.choose("saving", undefined)).toEqual([
			{ by: "person", from: "full", to: "saving" },
		]);
		expect(control.auto).toBeUndefined();
		expect(control.choose("off", undefined)).toEqual([
			{ by: "person", from: "saving", to: "off" },
		]);
		expect(control.choose("off", undefined)).toEqual([]);
	});

	it("switches full to saving when a window crosses the threshold, and says why", () => {
		const control = new OrchestratorModeControl("full");
		const change = control.observe(OVER);
		expect(change).toEqual({
			by: "usage",
			from: "full",
			to: "saving",
			over: OVER,
		});
		expect(control.mode).toBe("saving");
		expect(control.auto).toEqual(OVER);
		expect(savingNotice(change!)).toBe(
			"Orchestrator switched to saving: Claude's 5-hour window is at 82% (saving_threshold 80%). Nudges come less often, and none while 2 or more tasks are in progress. It goes back to full when the window resets.",
		);
	});

	it("goes back to full when the window resets, only if saving was automatic", () => {
		const auto = new OrchestratorModeControl("full");
		auto.observe(OVER);
		expect(auto.observe(undefined)).toEqual({
			by: "usage",
			from: "saving",
			to: "full",
		});
		expect(auto.mode).toBe("full");
		expect(auto.auto).toBeUndefined();

		const chosen = new OrchestratorModeControl("full");
		chosen.choose("saving", OVER);
		expect(chosen.auto).toBeUndefined();
		expect(chosen.observe(undefined)).toBeUndefined();
		expect(chosen.mode).toBe("saving");
	});

	it("keeps a saving the person chose over an automatic one: choosing saving by hand takes the auto away", () => {
		const control = new OrchestratorModeControl("full");
		control.observe(OVER);
		control.choose("saving", OVER);
		expect(control.auto).toBeUndefined();
		expect(control.observe(undefined)).toBeUndefined();
		expect(control.mode).toBe("saving");
	});

	it("never leaves off by itself, over or back under", () => {
		const control = new OrchestratorModeControl("off");
		expect(control.observe(OVER)).toBeUndefined();
		expect(control.observe(undefined)).toBeUndefined();
		expect(control.mode).toBe("off");
	});

	it("leaves a full the person chose out of saving alone until the window is back under", () => {
		const control = new OrchestratorModeControl("full");
		control.observe(OVER);
		expect(control.choose("full", OVER)).toEqual([
			{ by: "person", from: "saving", to: "full" },
		]);
		// Still over, a later reading: the person's full stands.
		expect(control.observe({ ...OVER, usedPercent: 90 })).toBeUndefined();
		expect(control.mode).toBe("full");
		// The window resets, and crosses again: switched once more.
		expect(control.observe(undefined)).toBeUndefined();
		expect(control.observe(OVER)?.to).toBe("saving");
	});

	it("turning on as full from off while over is saving at once, with its reason", () => {
		const control = new OrchestratorModeControl("off");
		expect(control.choose("full", OVER)).toEqual([
			{ by: "person", from: "off", to: "full" },
			{ by: "usage", from: "full", to: "saving", over: OVER },
		]);
		expect(control.auto).toEqual(OVER);
	});
});

function needsAction(n: number): OrchestratorEvent {
	return {
		type: "needs_action",
		subject: {
			kind: "issue",
			item: { repo: "acme/app", number: n, url: `https://x/${String(n)}` },
		},
		breach: { clause: "no_agent" },
	};
}

/** A dispatcher on a clock, the invariant standing with one subject. */
function dispatcher(mode: "full" | "saving" | "off", tasks: { n: number }) {
	const sent: string[] = [];
	const state = { now: NOW };
	const timers: { at: number; run: () => void }[] = [];
	const events = new EventDispatcher({
		mode,
		orchestrator: () => "orch",
		settings: () => ({
			event_prompt: "{EVENT}",
			init_prompt: undefined,
			events: ["*"],
			delivery_interval: "5m",
		}),
		deliver: (_agent, text) => sent.push(text),
		standing: () => [needsAction(1)],
		inProgress: () => tasks.n,
		now: () => state.now,
		setTimer: (ms, run) => {
			const timer = { at: state.now + ms, run };
			timers.push(timer);
			return {
				cancel: () => {
					timers.splice(timers.indexOf(timer), 1);
				},
			};
		},
	});
	const advance = (ms: number) => {
		state.now += ms;
		for (const timer of timers.filter((one) => one.at <= state.now)) {
			timers.splice(timers.indexOf(timer), 1);
			timer.run();
		}
	};
	return { events, sent, advance };
}

describe("saving's nudges", () => {
	it("come SAVING_INTERVAL_FACTOR times as rarely as full's", () => {
		expect(SAVING_INTERVAL_FACTOR).toBe(3);
		const full = dispatcher("full", { n: 0 });
		full.events.flush();
		for (let minute = 0; minute < 15; minute++) full.advance(60_000);
		// Once now, then every 5 minutes: 4 in a quarter of an hour.
		expect(full.sent).toHaveLength(4);
		const saving = dispatcher("saving", { n: 0 });
		saving.events.flush();
		for (let minute = 0; minute < 14; minute++) saving.advance(60_000);
		saving.advance(60_000 - 1);
		expect(saving.sent).toHaveLength(1);
		saving.advance(1);
		expect(saving.sent).toHaveLength(2);
	});

	it("do not come at all while 2 or more tasks are in progress, and come again below", () => {
		const tasks = { n: 2 };
		const saving = dispatcher("saving", tasks);
		saving.events.flush();
		saving.advance(60 * 60_000);
		expect(saving.sent).toHaveLength(0);
		expect(saving.events.preview().when).toEqual({
			kind: "saving_busy",
			tasks: 2,
		});
		tasks.n = 1;
		saving.events.flush();
		expect(saving.sent).toHaveLength(1);
	});

	it("are not held by one task in progress, nor in full by any number", () => {
		const one = dispatcher("saving", { n: 1 });
		one.events.flush();
		expect(one.sent).toHaveLength(1);
		const full = dispatcher("full", { n: 5 });
		full.events.flush();
		expect(full.sent).toHaveLength(1);
	});

	it("never hold the person's words, nor a start's init", () => {
		const saving = dispatcher("saving", { n: 3 });
		saving.events.dispatch({
			type: "escalation_answered",
			escalationId: 1,
			title: "t",
			agents: [],
		});
		expect(saving.sent).toHaveLength(1);
		expect(saving.sent[0]).toContain("esc=1");
		saving.sent.length = 0;
		saving.events.dispatch({ type: "init" });
		saving.advance(1_000);
		expect(saving.sent).toHaveLength(1);
		expect(saving.sent[0]).toContain("[init]");
	});

	it("turning on into saving still holds the batch for the work in progress", () => {
		const saving = dispatcher("off", { n: 2 });
		expect(saving.events.setMode("saving")).toBe(0);
		expect(saving.sent).toHaveLength(0);
	});

	it("leaving saving for full looks again at once, at full's interval", () => {
		const run = dispatcher("saving", { n: 0 });
		run.events.flush();
		run.advance(5 * 60_000);
		expect(run.sent).toHaveLength(1);
		run.events.setMode("full");
		expect(run.sent).toHaveLength(2);
	});
});

describe("the service's mode", () => {
	function service(mode?: "full" | "saving" | "off") {
		const sent: string[] = [];
		const changes: string[] = [];
		const clock = { now: NOW };
		const settings = { ...DEFAULT_ORCHESTRATOR, event_prompt: "{EVENT}" };
		const run = new OrchestratorService({
			store: EscalationStore.inMemory(),
			agents: () => [
				{
					id: "orch",
					name: "orchestrator",
					workspaceId: "w",
					workspaceLabel: "w",
					status: "idle",
					stopping: false,
				},
			],
			settings: () => settings,
			startProblem: () => undefined,
			deliver: (_agent, text) => sent.push(text),
			publish: () => undefined,
			modeChanged: (change, auto) => {
				changes.push(
					`${change.by}:${change.from}->${change.to}${auto === undefined ? "" : " auto"}`,
				);
			},
			now: () => clock.now,
			...(mode === undefined ? {} : { mode }),
		});
		return { run, sent, changes, settings, clock };
	}

	it("is off at launch: nothing is delivered, init included, until turned on", () => {
		const { run, sent } = service();
		expect(run.mode).toBe("off");
		expect(run.wire()).toMatchObject({ mode: "off", paused: true });
		run.assign("orch");
		run.observe();
		expect(sent).toHaveLength(0);
		run.setMode("full");
		expect(sent.join("\n")).toContain("[init]");
	});

	it("switches on the readout, and back on its reset, saying so", () => {
		const { run, changes } = service("full");
		run.observeUsage(
			limits([{ window: "5-hour", used: 85, resetsAt: NOW + HOUR }]),
		);
		expect(run.mode).toBe("saving");
		expect(run.wire().autoSaving).toMatchObject({
			window: "5-hour",
			usedPercent: 85,
			threshold: 80,
		});
		run.observeUsage(
			limits([{ window: "5-hour", used: 3, resetsAt: NOW + 6 * HOUR }]),
		);
		expect(run.mode).toBe("full");
		expect(run.wire().autoSaving).toBeUndefined();
		expect(changes).toEqual(["usage:full->saving auto", "usage:saving->full"]);
	});

	it("reads saving_threshold as it is now", () => {
		const { run, settings } = service("full");
		run.observeUsage(limits([{ window: "7-day", used: 85 }]));
		expect(run.mode).toBe("saving");
		(settings as { saving_threshold: number }).saving_threshold = 90;
		run.settingsChanged();
		expect(run.mode).toBe("full");
	});

	it("never turns an off one on, whatever the readout", () => {
		const { run } = service();
		run.observeUsage(limits([{ window: "5-hour", used: 99 }]));
		run.observeUsage(limits([{ window: "5-hour", used: 1 }]));
		expect(run.mode).toBe("off");
	});
});
