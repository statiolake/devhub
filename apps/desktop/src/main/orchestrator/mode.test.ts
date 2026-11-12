/**
 * The Orchestrator's three modes (`mode.ts`): the transitions, the automatic
 * switch on the usage readout, saving's nudge gating in the dispatcher, and
 * off at every launch.
 */

import { describe, expect, it } from "vitest";
import type { UsageLimitsWire } from "../../ipc/contract.js";
import { DEFAULT_ORCHESTRATOR } from "../../model/orchestratorSettings.js";
import { TaskStore } from "./taskStore.js";
import {
	BATCH_WINDOW_MS,
	EVENT_TYPES,
	EventDispatcher,
	type OrchestratorEvent,
} from "./events.js";
import {
	LAUNCH_MODE,
	OrchestratorModeControl,
	SAVING_BUSY_TASKS,
	SAVING_CLASSES,
	SAVING_INTERVAL_FACTOR,
	savingClassOf,
	savingHolds,
	savingKindOf,
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
			"Orchestrator switched to saving: Claude's 5-hour window is at 82% (saving_threshold 80%). What happens to the work in progress still comes, less often; reminders wait for the hourly triage unless high. It goes back to full when the window resets.",
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
		breach: { clause: "no_task" },
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

	it("about other work wait while 2 or more tasks are in progress, and come again below", () => {
		const tasks = { n: 2 };
		const saving = dispatcher("saving", tasks);
		saving.events.flush();
		saving.advance(60 * 60_000);
		expect(saving.sent).toHaveLength(0);
		expect(saving.events.preview().when).toEqual({
			kind: "saving_held",
			lines: 1,
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
			task: { id: 9, title: "仕事" },
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

	it("turning on into saving still holds a nudge about other work while 2 are in progress", () => {
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

function agentLine(id: string): OrchestratorEvent {
	return {
		type: "needs_action",
		subject: { kind: "agent", agent: { id, name: id } },
		ws: "web",
		breach: { clause: "no_task" },
	};
}

function taskLine(id: number): OrchestratorEvent {
	return {
		type: "needs_action",
		subject: { kind: "task", task: { id, title: `t${String(id)}` } },
		breach: { clause: "idle" },
	};
}

describe("saving: state changes and nudges", () => {
	it("classifies every kind of line, explicitly", () => {
		expect(SAVING_CLASSES).toEqual({
			init: "never_held",
			triage: "never_held",
			escalation_answered: "never_held",
			"task.human_direct": "never_held",
			request: "never_held",
			"needs_action task": "state_change",
			"needs_action agent no_task": "state_change",
			"needs_action item no_task": "nudge",
			"needs_action said again": "nudge",
			"task.changed subjects_changed": "state_change",
			"task.changed due": "on_time",
			"timer.elapsed timer set": "on_time",
			"timer.elapsed settings": "on_time",
			"usage.threshold": "nudge",
			"custom.*": "nudge",
		});
		// Every type DevHub emits has its kind.
		const kinds = Object.keys(SAVING_CLASSES);
		for (const type of EVENT_TYPES)
			expect(
				kinds.some((kind) => kind === type || kind.startsWith(`${type} `)),
			).toBe(true);
	});

	it("reads each event's kind, a standing line said again as a nudge", () => {
		expect(savingKindOf(agentLine("a"))).toBe("needs_action agent no_task");
		expect(savingKindOf(taskLine(3))).toBe("needs_action task");
		expect(savingKindOf(needsAction(1))).toBe("needs_action item no_task");
		expect(savingClassOf(agentLine("a"), true)).toBe("nudge");
		expect(
			savingKindOf({
				type: "task.changed",
				taskId: 1,
				reasons: ["due"],
			}),
		).toBe("task.changed due");
		expect(
			savingKindOf({
				type: "task.changed",
				taskId: 1,
				reasons: ["due", "subjects_changed"],
			}),
		).toBe("task.changed due");
		expect(
			savingKindOf({
				type: "timer.elapsed",
				name: "slack",
				interval: "30m",
				source: "session",
			}),
		).toBe("timer.elapsed timer set");
		expect(
			savingKindOf({ type: "timer.elapsed", name: "sweep", interval: "30m" }),
		).toBe("timer.elapsed settings");
		expect(savingKindOf({ type: "custom.deploy", text: "x" })).toBe("custom.*");
	});

	it("holds a nudge not high, or about other work with 2 or more in progress; never a state change", () => {
		const busy = SAVING_BUSY_TASKS;
		const nudge = { class: "nudge" as const };
		expect(
			savingHolds({ ...nudge, high: true, inProgress: false, tasks: 0 }),
		).toBeUndefined();
		expect(
			savingHolds({ ...nudge, high: false, inProgress: true, tasks: busy }),
		).toBe("not_high");
		expect(
			savingHolds({ ...nudge, high: true, inProgress: false, tasks: busy }),
		).toBe("busy");
		expect(
			savingHolds({ ...nudge, high: true, inProgress: true, tasks: busy }),
		).toBeUndefined();
		for (const one of ["state_change", "never_held", "on_time"] as const)
			expect(
				savingHolds({ class: one, high: false, inProgress: false, tasks: 9 }),
			).toBeUndefined();
	});
});

/**
 * A saving dispatcher on a clock with what DevHub reads: the standing lines
 * and their state, the priorities, the tasks in progress and whose.
 */
function savingRun(options: {
	readonly tasks: number;
	readonly high?: readonly string[];
	readonly inProgress?: readonly string[];
}) {
	const sent: string[] = [];
	const state = {
		now: NOW,
		standing: [] as { event: OrchestratorEvent; print: string }[],
		inProgress: new Set(options.inProgress ?? []),
	};
	const timers: { at: number; run: () => void }[] = [];
	const events = new EventDispatcher({
		mode: "saving",
		orchestrator: () => "orch",
		settings: () => ({
			event_prompt: "{EVENT}",
			init_prompt: undefined,
			events: ["*"],
			delivery_interval: "5m",
		}),
		deliver: (_agent, text) => sent.push(text),
		standing: () => state.standing.map((one) => one.event),
		statePrint: (event) =>
			state.standing.find((one) => one.event === event)?.print,
		high: (subject) => (options.high ?? []).includes(subject),
		inProgress: () => options.tasks,
		inProgressSubject: (subject) => state.inProgress.has(subject),
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
		const until = state.now + ms;
		for (;;) {
			const next = timers
				.filter((one) => one.at <= until)
				.sort((a, b) => a.at - b.at)[0];
			if (next === undefined) break;
			state.now = next.at;
			timers.splice(timers.indexOf(next), 1);
			next.run();
		}
		state.now = until;
	};
	return { events, sent, state, advance };
}

const MIN = 60_000;

describe("saving's dispatcher: the work in progress is never held", () => {
	it("delivers a non-high in-progress agent finishing, with 2 or more in progress, within saving's interval", () => {
		const run = savingRun({ tasks: 3, inProgress: ["agent a", "agent b"] });
		// A batch just went: the interval counts from it.
		run.events.dispatch({
			type: "task.changed",
			taskId: 7,
			reasons: ["subjects_changed"],
		});
		run.advance(BATCH_WINDOW_MS);
		expect(run.sent).toHaveLength(1);
		// Agent a (not high) ends its turn: it left 対応中 with it.
		run.state.inProgress.delete("agent a");
		run.state.standing = [{ event: agentLine("a"), print: "t1 idle" }];
		run.events.flush();
		expect(run.sent).toHaveLength(1);
		run.advance(SAVING_INTERVAL_FACTOR * 5 * MIN - 1);
		expect(run.sent).toHaveLength(1);
		run.advance(1);
		expect(run.sent).toHaveLength(2);
		expect(run.sent[1]).toContain("agent=a");
	});

	it("says a standing line again only when its state moved, or when high", () => {
		const run = savingRun({ tasks: 2 });
		run.state.standing = [
			{ event: agentLine("a"), print: "t1 checks=pending" },
		];
		run.events.flush();
		expect(run.sent).toHaveLength(1);
		// Still idle, nothing new: a reminder, held.
		run.advance(60 * MIN);
		expect(run.sent).toHaveLength(1);
		expect(run.events.preview().when).toEqual({
			kind: "saving_held",
			lines: 1,
		});
		// Its pull request's checks failed: a state change, it goes.
		run.state.standing = [
			{ event: agentLine("a"), print: "t1 checks=failing" },
		];
		run.events.flush();
		expect(run.sent).toHaveLength(2);
		// Settled, then stopped again: new again.
		run.state.standing = [];
		run.events.flush();
		run.advance(15 * MIN);
		run.state.standing = [
			{ event: agentLine("a"), print: "t1 checks=failing" },
		];
		run.events.flush();
		expect(run.sent).toHaveLength(3);
	});

	it("holds a nudge about an unstarted low item, and a high one while 2 are in progress, until the triage", () => {
		const run = savingRun({
			tasks: 2,
			high: ["item acme/app#2"],
			inProgress: ["agent a"],
		});
		run.state.standing = [
			{ event: needsAction(1), print: "t1 no_agent" },
			{ event: needsAction(2), print: "t1 no_agent" },
		];
		run.events.dispatch({ type: "custom.chatter", text: "sweep" });
		run.advance(60 * MIN);
		expect(run.sent).toHaveLength(0);
		// A state change still goes alone, the nudges left waiting.
		run.state.standing.push({ event: agentLine("b"), print: "t2 idle" });
		run.events.flush();
		expect(run.sent).toHaveLength(1);
		expect(run.sent[0]).toContain("agent=b");
		expect(run.sent[0]).not.toContain("acme/app#");
		expect(run.sent[0]).not.toContain("sweep");
		// The triage goes whatever is in progress, and takes everything.
		run.advance(15 * MIN);
		run.events.dispatch({ type: "triage" });
		run.advance(1_000);
		expect(run.sent).toHaveLength(2);
		for (const piece of ["[triage]", "acme/app#1", "acme/app#2", "sweep"])
			expect(run.sent[1]).toContain(piece);
	});

	it("lets a high nudge about the work in progress go with 2 or more in progress", () => {
		const run = savingRun({
			tasks: 2,
			high: ["item acme/app#1", "agent a"],
			inProgress: ["agent a"],
		});
		run.state.standing = [
			{ event: agentLine("a"), print: "t1 idle" },
			{ event: needsAction(1), print: "t1 no_agent" },
		];
		run.events.flush();
		expect(run.sent).toHaveLength(1);
		run.advance(15 * MIN);
		// Said again: agent a is high and in progress; item 1 is other work.
		expect(run.sent).toHaveLength(2);
		expect(run.sent[1]).toContain("agent=a");
		expect(run.sent[1]).not.toContain("acme/app#1");
	});

	it("sends a timer at its time, alone, the orchestrator's and the settings' alike: not batched, not held by the interval or for triage", () => {
		const run = savingRun({ tasks: 3 });
		run.state.standing = [{ event: needsAction(1), print: "t1 no_agent" }];
		run.events.dispatch({
			type: "task.changed",
			taskId: 7,
			reasons: ["subjects_changed"],
		});
		run.advance(BATCH_WINDOW_MS);
		expect(run.sent).toEqual(["[task.changed] task=7 — subjects_changed"]);
		// A minute later, well inside saving's 15 minutes: at once, alone.
		run.advance(MIN);
		run.events.dispatch({
			type: "timer.elapsed",
			name: "slack",
			interval: "30m",
			source: "session",
		});
		expect(run.sent).toEqual([
			"[task.changed] task=7 — subjects_changed",
			"[timer.elapsed] slack",
		]);
		// The person's settings timer (reading Slack, say): on time too.
		run.advance(MIN);
		run.events.dispatch({
			type: "timer.elapsed",
			name: "slack-check",
			interval: "30m",
			source: "settings",
		});
		expect(run.sent).toEqual([
			"[task.changed] task=7 — subjects_changed",
			"[timer.elapsed] slack",
			"[timer.elapsed] slack-check",
		]);
		// A nudge still waits: the item nobody started, not high.
		run.advance(60 * MIN);
		expect(run.sent).toHaveLength(3);
		expect(run.events.held()).toEqual([]);
	});

	it("sends a wait's time on time too, and drops a timer that fires while off", () => {
		const run = savingRun({ tasks: 2 });
		run.events.dispatch({ type: "custom.x", text: "batch" });
		run.events.dispatch({
			type: "task.changed",
			taskId: 3,
			reasons: ["subjects_changed"],
		});
		run.advance(BATCH_WINDOW_MS);
		expect(run.sent).toHaveLength(1);
		run.events.dispatch({
			type: "task.changed",
			taskId: 4,
			reasons: ["due"],
		});
		expect(run.sent[1]).toBe("[task.changed] task=4 — due");
		run.events.setMode("off");
		const fired = run.events.dispatch({
			type: "timer.elapsed",
			name: "slack",
			interval: "30m",
			source: "session",
		});
		expect(fired).toMatchObject({ fate: "dropped", reason: "off" });
		expect(run.sent).toHaveLength(2);
		run.events.setMode("saving");
		expect(run.sent.join("\n")).not.toContain("[timer.elapsed] slack");
	});

	it("delivers a wait that may be ready, low and with 3 in progress", () => {
		const run = savingRun({ tasks: 3 });
		run.events.dispatch({
			type: "task.changed",
			taskId: 4,
			reasons: ["subjects_changed"],
		});
		run.advance(1_000);
		expect(run.sent).toEqual(["[task.changed] task=4 — subjects_changed"]);
	});
});

describe("off: the timers are off, the person's answers go", () => {
	const settingsTimer: OrchestratorEvent = {
		type: "timer.elapsed",
		name: "slack",
		interval: "30m",
		source: "settings",
	};

	it("drops a settings timer that fires while off, logged, and sends nothing of it on turning on", () => {
		const run = dispatcher("off", { n: 0 });
		const entry = run.events.dispatch(settingsTimer);
		expect(entry).toMatchObject({ fate: "dropped", reason: "off" });
		expect(run.events.held()).toEqual([]);
		expect(run.events.recent(1)[0]).toBe(entry);
		run.events.setMode("full");
		expect(run.sent.join("\n")).not.toContain("timer.elapsed");
		// On, the next firing goes on its time, alone.
		run.events.dispatch(settingsTimer);
		expect(run.sent.at(-1)).toBe("[timer.elapsed] slack");
	});

	it("drops a wait's due while off, keeping what moved about its subjects", () => {
		const run = dispatcher("off", { n: 0 });
		expect(
			run.events.dispatch({
				type: "task.changed",
				taskId: 4,
				reasons: ["due"],
			}),
		).toMatchObject({ fate: "dropped", reason: "off" });
		run.events.dispatch({
			type: "task.changed",
			taskId: 5,
			reasons: ["due", "subjects_changed"],
		});
		expect(run.events.held()).toEqual([
			{
				type: "task.changed",
				taskId: 5,
				reasons: ["subjects_changed"],
			},
		]);
	});

	it("delivers the person's answers while off, as in full; a request waits for on", () => {
		const run = dispatcher("off", { n: 0 });
		run.events.dispatch({
			type: "escalation_answered",
			task: { id: 9, title: "仕事" },
			escalationId: 1,
			title: "t",
			agents: [],
			answers: [{ text: "はい" }],
		});
		run.events.dispatch({
			type: "task.human_direct",
			task: { id: 2, title: "u" },
			agent: { id: "w", name: "worker" },
			messages: [{ text: "こちらで進めて" }],
		});
		run.events.dispatch({
			type: "request",
			task: { id: 3, title: "依頼" },
			text: "調べて",
		});
		run.events.dispatch({ type: "custom.x", text: "y" });
		expect(run.sent).toEqual([
			"task=9「仕事」 esc=1「t」 への人の回答:\nはい",
			expect.stringContaining("こちらで進めて"),
		]);
		expect(run.events.held().map((one) => one.type)).toEqual([
			"request",
			"custom.x",
		]);
		run.events.setMode("full");
		expect(run.sent[2]).toContain("task=3「依頼」 人からの依頼");
		expect(run.sent[3]).toContain("[custom.x]");
	});

	it("keeps an answer with no orchestrator running until one starts, off or on", () => {
		const who: { id: string | undefined } = { id: undefined };
		const sent: string[] = [];
		const events = new EventDispatcher({
			mode: "off",
			orchestrator: () => who.id,
			settings: () => ({
				event_prompt: "{EVENT}",
				init_prompt: undefined,
				events: ["*"],
				delivery_interval: "5m",
			}),
			deliver: (_agent, text) => sent.push(text),
		});
		const entry = events.dispatch({
			type: "escalation_answered",
			task: { id: 9, title: "仕事" },
			escalationId: 1,
			title: "t",
			agents: [],
			answers: [{ text: "はい" }],
		});
		expect(entry.fate).toBe("pending");
		expect(events.dispatch(settingsTimer).fate).toBe("dropped");
		events.flush();
		expect(sent).toEqual([]);
		who.id = "orch";
		events.flush();
		expect(sent).toEqual(["task=9「仕事」 esc=1「t」 への人の回答:\nはい"]);
		expect(entry.fate).toBe("delivered");
	});
});

describe("the service's mode", () => {
	function service(mode?: "full" | "saving" | "off") {
		const sent: string[] = [];
		const changes: string[] = [];
		const clock = { now: NOW };
		const settings = { ...DEFAULT_ORCHESTRATOR, event_prompt: "{EVENT}" };
		const run = new OrchestratorService({
			store: TaskStore.inMemory(),
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

	it("drops a task's --check-at that comes while off, and lists it as expired while the task waits with it", () => {
		const { run, sent, clock } = service("full");
		run.assign("orch");
		const one = run.newTask({ title: "リリース後に確認" });
		run.setTaskStatus(one.id, "waiting", {
			note: "15:00 に",
			checkAt: NOW + HOUR,
		});
		run.setMode("off");
		sent.length = 0;
		clock.now = NOW + HOUR + 1_000;
		run.observe();
		const due = run
			.eventLog(200)
			.filter((entry) => entry.type === "task.changed");
		expect(due).toMatchObject([{ fate: "dropped" }]);
		expect(run.expiredWhileOff()).toEqual([
			{
				taskId: one.id,
				title: "リリース後に確認",
				checkAt: NOW + HOUR,
				droppedAt: NOW + HOUR + 1_000,
			},
		]);
		run.setMode("full");
		run.observe();
		expect(sent.join("\n")).not.toContain("— due");
		// Still listed while the task waits; gone once it is 処理中.
		expect(run.expiredWhileOff()).toHaveLength(1);
		run.setTaskStatus(one.id, "in_progress", {});
		expect(run.expiredWhileOff()).toEqual([]);
	});

	it("never turns an off one on, whatever the readout", () => {
		const { run } = service();
		run.observeUsage(limits([{ window: "5-hour", used: 99 }]));
		run.observeUsage(limits([{ window: "5-hour", used: 1 }]));
		expect(run.mode).toBe("off");
	});
});
