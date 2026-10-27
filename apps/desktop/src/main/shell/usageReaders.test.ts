/**
 * The background usage readers, against scripted CLIs: what each one is sent
 * (control requests and account reads only — never anything that starts a
 * turn), how its answers are decoded, how often it asks, how its readings
 * merge with a GUI Agent's, that each reading is its own process, killed
 * after, that a failure is said once per streak and retried with a backoff,
 * that the reader's status reaches the wire, and what the log says.
 */

import { describe, expect, it, vi } from "vitest";
import type { UsageLimitsWire, UsageNoteWire } from "../../ipc/contract.js";
import type { SettingsResolvedRuntimeWire } from "../../ipc/settings.js";
import type { ConfiguredAgentProfile } from "../../model/config.js";
import type { UsageReading } from "../../model/conversation.js";
import { NamedFailure } from "../../model/wire.js";
import { decodeUsage } from "../agent/conversation/claude/decode.js";
import { rateLimits, Reader } from "../agent/conversation/codex/decode.js";
import { ProtocolMismatch } from "../agent/conversation/protocolAdapter.js";
import type { MachineCommand } from "../runtime/runtime.js";
import {
	UsageLimits,
	type UsageReaderStatus,
	usageReadingListener,
} from "./usageLimits.js";
import {
	BACKOFF_MS,
	type LineProcess,
	pollInterval,
	READ_TIMEOUT_MS,
	startUsageReaders,
} from "./usageReaders.js";

// ---------------------------------------------------------------------------
// Scripted CLIs.

type Answer = (message: Record<string, unknown>) => readonly object[] | "end";

class ScriptedProcess implements LineProcess {
	readonly sent: Record<string, unknown>[] = [];
	readonly #lines: ((line: string) => void)[] = [];
	readonly #ended = new AbortController();
	readonly ended = this.#ended.signal;
	killed = false;

	constructor(
		readonly command: MachineCommand,
		private readonly answer: Answer,
	) {}

	send(message: object): void {
		const sent = message as Record<string, unknown>;
		this.sent.push(sent);
		queueMicrotask(() => {
			const said = this.answer(sent);
			if (said === "end") {
				this.end("exit code 1");
				return;
			}
			for (const line of said) this.say(line);
		});
	}

	onLine(listener: (line: string) => void): void {
		this.#lines.push(listener);
	}

	say(line: object | string): void {
		const text = typeof line === "string" ? line : JSON.stringify(line);
		for (const listener of this.#lines) listener(text);
	}

	end(why: string): void {
		if (!this.#ended.signal.aborted) this.#ended.abort(new Error(why));
	}

	kill(): void {
		this.killed = true;
		this.end("killed");
	}
}

/** Claude's answer to a control request, succeeding with `response`. */
function claudeSuccess(message: Record<string, unknown>, response: object) {
	return {
		type: "control_response",
		response: {
			subtype: "success",
			request_id: message["request_id"],
			response,
		},
	};
}

const CLAUDE_USAGE = {
	subscription_type: "max",
	rate_limits_available: true,
	rate_limits: {
		five_hour: {
			utilization: 91,
			resets_at: "2026-09-28T14:59:59.559705+00:00",
			limit_dollars: null,
		},
		seven_day: {
			utilization: 34,
			resets_at: "2026-10-04T13:59:59.559729+00:00",
			limit_dollars: null,
		},
		seven_day_opus: null,
		some_internal_cap: { utilization: 0.7, resets_at: null },
	},
	limits: [],
	model_scoped: [],
};

function claude(usage: () => object): Answer {
	return (message) => {
		const request = message["request"] as { subtype: string };
		switch (request.subtype) {
			case "initialize":
				return [
					// What a hook or the CLI says unasked is not an answer.
					{ type: "system", subtype: "status", session_id: "x" },
					claudeSuccess(message, { commands: [] }),
				];
			case "get_usage":
				return [claudeSuccess(message, usage())];
			default:
				throw new Error(`unexpected ${request.subtype}`);
		}
	};
}

const CODEX_LIMITS = {
	rateLimits: {
		limitId: "codex",
		limitName: null,
		primary: {
			usedPercent: 76,
			windowDurationMins: 300,
			resetsAt: 1_790_625_408,
		},
		secondary: {
			usedPercent: 2,
			windowDurationMins: 10_080,
			resetsAt: 1_791_091_364,
		},
		credits: null,
		planType: "plus",
		rateLimitReachedType: null,
	},
	rateLimitsByLimitId: {},
};

function codex(
	account: string | null,
	limits: () => object = () => CODEX_LIMITS,
): Answer {
	return (message) => {
		const id = message["id"];
		switch (message["method"]) {
			case "initialize":
				return [
					{ id, result: { userAgent: "devhub/0.154.0 (Mac OS)" } },
					// A notification is not an answer.
					{ method: "remoteControl/status/changed", params: {} },
				];
			case "initialized":
				return [];
			case "account/read":
				return [
					{
						id,
						result: {
							account: account === null ? null : { type: account },
							requiresOpenaiAuth: true,
						},
					},
				];
			case "account/rateLimits/read":
				return [{ id, result: limits() }];
			default:
				throw new Error(`unexpected ${String(message["method"])}`);
		}
	};
}

function profile(
	kind: "claude" | "codex",
	display_name = kind === "claude" ? "Claude" : "Codex",
): ConfiguredAgentProfile {
	return {
		id: `${kind}-${display_name}`,
		display_name,
		kind,
		command: kind,
		args: ["--model", "something", "--resume", "abc"],
		env: { PROFILE_VAR: "1" },
		presentation: undefined,
	};
}

/**
 * Readers over scripted CLIs, `reads` reads each before they are stopped by
 * the test's clock, which records each interval asked for.
 */
function harness(options: {
	readonly profiles: readonly ConfiguredAgentProfile[];
	readonly answers: Partial<Record<"claude" | "codex", Answer>>;
	readonly missing?: readonly string[];
	readonly environment?: () => Promise<Record<string, string>>;
	readonly spawnThrows?: () => boolean;
	readonly now?: () => number;
}) {
	const limits = new UsageLimits();
	const published: UsageLimitsWire[] = [];
	const listener = usageReadingListener(limits, (wire) => published.push(wire));
	const processes: ScriptedProcess[] = [];
	const intervals: number[] = [];
	const reports: NamedFailure[] = [];
	const readings: UsageReading[] = [];
	const notes: UsageNoteWire[] = [];
	const statuses: UsageReaderStatus[] = [];
	const logs: string[] = [];
	const resolved: string[] = [];
	const ticks: (() => void)[] = [];
	/** How many processes were alive when each one was started. */
	const aliveAtSpawn: number[] = [];
	const readers = startUsageReaders({
		profiles: options.profiles,
		runtime: {
			resolveProgram: (configured) => {
				resolved.push(configured);
				return Promise.resolve<SettingsResolvedRuntimeWire>(
					options.missing?.includes(configured)
						? {
								kind: "unavailable",
								configured,
								lookup: { kind: "path", directories: [] },
							}
						: { kind: "absolute_path", value: `/opt/bin/${configured}` },
				);
			},
			environment:
				options.environment ??
				(() => Promise.resolve({ PATH: "/usr/bin", HOME: "/home/testuser" })),
			home: () => Promise.resolve("/home/testuser"),
		},
		searchPath: "/usr/bin",
		clientVersion: "0.1.0",
		spawn: (command) => {
			if (options.spawnThrows?.() === true) {
				throw new Error(`spawn ${command.file} ENOENT`);
			}
			const name = command.file.split("/").at(-1) as "claude" | "codex";
			const answer = options.answers[name];
			if (answer === undefined) throw new Error(`no script for ${name}`);
			aliveAtSpawn.push(processes.filter((one) => !one.killed).length);
			const process = new ScriptedProcess(command, answer);
			processes.push(process);
			return process;
		},
		deliver: (cli, reading) => {
			readings.push(reading);
			listener.deliver(cli, reading);
		},
		note: (cli, note) => {
			notes.push(note);
			listener.note(cli, note);
		},
		status: (cli, status) => {
			statuses.push(status);
			listener.status(cli, status);
		},
		report: (failure) => reports.push(failure),
		log: (line) => logs.push(line),
		...(options.now === undefined ? {} : { now: options.now }),
		// The test's clock: every reader's next read waits for `next()`.
		wait: (ms, signal) => {
			intervals.push(ms);
			return new Promise<void>((resolve) => {
				ticks.push(resolve);
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
		},
	});
	return {
		limits,
		published,
		processes,
		aliveAtSpawn,
		intervals,
		reports,
		readings,
		notes,
		statuses,
		logs,
		resolved,
		readers,
		next: () => {
			for (const tick of ticks.splice(0)) tick();
		},
	};
}

// ---------------------------------------------------------------------------

describe("decoding a usage reading", () => {
	it("reads Claude's get_usage: already 0–100, the reset an ISO time, only its five-hour and seven-day windows", () => {
		expect(decodeUsage(CLAUDE_USAGE, "2.1.0")).toEqual({
			kind: "windows",
			windows: [
				{
					window: "5-hour",
					durationMinutes: 300,
					usedPercent: 91,
					resetsAt: Date.parse("2026-09-28T14:59:59.559Z"),
				},
				{
					window: "7-day",
					durationMinutes: 10_080,
					usedPercent: 34,
					resetsAt: Date.parse("2026-10-04T13:59:59.559Z"),
				},
			],
		});
	});

	it("names Claude's windows as the stream's rate_limit_event does, so the two are one window", () => {
		const reading = decodeUsage(CLAUDE_USAGE, undefined);
		expect(
			reading?.kind === "windows" && reading.windows.map((one) => one.window),
		).toEqual(["5-hour", "7-day"]);
	});

	it("reads a Claude sign-in without plan limits as that, not as a failure", () => {
		expect(
			decodeUsage(
				{
					subscription_type: null,
					rate_limits_available: false,
					rate_limits: null,
				},
				undefined,
			),
		).toEqual({ kind: "no_plan_limits" });
	});

	it("leaves out a Claude window the account has not started", () => {
		expect(
			decodeUsage(
				{
					rate_limits_available: true,
					rate_limits: {
						five_hour: null,
						seven_day: { utilization: 3, resets_at: null },
					},
				},
				undefined,
			),
		).toEqual({
			kind: "windows",
			windows: [
				{
					window: "7-day",
					durationMinutes: 10_080,
					usedPercent: 3,
					resetsAt: undefined,
				},
			],
		});
	});

	it("refuses a Claude answer in any other shape, saying where", () => {
		const bad = (payload: object) => () =>
			decodeUsage(payload as never, "2.1.0");
		expect(bad({ rate_limits: {} })).toThrow(ProtocolMismatch);
		expect(bad({ rate_limits: {} })).toThrow(
			/rate_limits_available: expected a boolean/u,
		);
		expect(
			bad({
				rate_limits_available: true,
				rate_limits: { five_hour: { utilization: "91%", resets_at: null } },
			}),
		).toThrow(
			/rate_limits\.five_hour\.utilization: expected a number \(CLI 2\.1\.0\)/u,
		);
		expect(
			bad({
				rate_limits_available: true,
				rate_limits: { five_hour: { utilization: 1, resets_at: "tomorrow" } },
			}),
		).toThrow(/five_hour\.resets_at: expected an ISO 8601 time/u);
		expect(bad({ rate_limits_available: true })).toThrow(
			/rate_limits: expected an object/u,
		);
	});

	it("reads Codex's account/rateLimits/read: the reset in seconds becomes milliseconds, windows named by length", () => {
		expect(rateLimits(new Reader(undefined), CODEX_LIMITS, "result")).toEqual({
			windows: [
				{
					window: "5-hour",
					durationMinutes: 300,
					usedPercent: 76,
					resetsAt: 1_790_625_408_000,
				},
				{
					window: "7-day",
					durationMinutes: 10_080,
					usedPercent: 2,
					resetsAt: 1_791_091_364_000,
				},
			],
		});
		// A window whose length Codex does not say is named by its slot, and
		// has no length.
		expect(
			rateLimits(
				new Reader(undefined),
				{
					rateLimits: {
						primary: {
							usedPercent: 5,
							windowDurationMins: null,
							resetsAt: null,
						},
					},
				},
				"result",
			),
		).toEqual({
			windows: [
				{
					window: "primary",
					durationMinutes: undefined,
					usedPercent: 5,
					resetsAt: undefined,
				},
			],
		});
		expect(() =>
			rateLimits(
				new Reader("0.154.0"),
				{ rateLimits: { primary: { usedPercent: "a" } } },
				"result",
			),
		).toThrow(/result\.rateLimits\.primary\.usedPercent: expected a number/u);
	});
});

describe("how often a reader asks", () => {
	const at = (...used: number[]): UsageReading => ({
		kind: "windows",
		windows: used.map((usedPercent, index) => ({
			window: String(index),
			durationMinutes: undefined,
			usedPercent,
			resetsAt: undefined,
		})),
	});

	it("follows Codex's TUI: 60 s, 30 s from 75%, 15 s from 90%, 5 s from 99%, by the most used window", () => {
		expect(pollInterval("codex", at(10, 74.9))).toBe(60_000);
		expect(pollInterval("codex", at(75, 1))).toBe(30_000);
		expect(pollInterval("codex", at(1, 90))).toBe(15_000);
		expect(pollInterval("codex", at(99))).toBe(5_000);
		expect(pollInterval("codex", at())).toBe(60_000);
		expect(pollInterval("codex", { kind: "no_plan_limits" })).toBe(60_000);
	});

	it("asks Claude's experimental endpoint once a minute until a window reaches 90%", () => {
		expect(pollInterval("claude", at(89.9))).toBe(60_000);
		expect(pollInterval("claude", at(75))).toBe(60_000);
		expect(pollInterval("claude", at(90))).toBe(15_000);
		expect(pollInterval("claude", at(50, 99.5))).toBe(5_000);
		expect(pollInterval("claude", { kind: "no_plan_limits" })).toBe(60_000);
	});
});

describe("the background usage readers", () => {
	it("send Claude control requests only, never a message, and start it without the profile's arguments", async () => {
		const h = harness({
			profiles: [profile("claude")],
			answers: { claude: claude(() => CLAUDE_USAGE) },
		});
		await vi.waitFor(() => expect(h.intervals).toHaveLength(1));
		h.next();
		await vi.waitFor(() => expect(h.intervals).toHaveLength(2));
		h.readers.stop();
		const [process] = h.processes;
		expect(process!.command).toEqual({
			file: "/opt/bin/claude",
			args: [
				"-p",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				"--no-session-persistence",
				"--settings",
				'{"disableAllHooks":true}',
			],
			env: { PATH: "/usr/bin", HOME: "/home/testuser", PROFILE_VAR: "1" },
		});
		// One process per reading, each with its own handshake.
		expect(h.processes).toHaveLength(2);
		for (const one of h.processes) {
			expect(one.sent).toEqual([
				{
					type: "control_request",
					request_id: "devhub-usage-1",
					request: { subtype: "initialize" },
				},
				{
					type: "control_request",
					request_id: "devhub-usage-2",
					request: { subtype: "get_usage", skip_behaviors: true },
				},
			]);
			expect(one.killed).toBe(true);
		}
		// 91% of the five-hour window: 15 s.
		expect(h.intervals).toEqual([15_000, 15_000]);
		expect(h.reports).toEqual([]);
	});

	it("send Codex its handshake, account reads and rate-limit reads only, never a thread or a turn", async () => {
		const h = harness({
			profiles: [profile("codex")],
			answers: { codex: codex("chatgpt") },
		});
		await vi.waitFor(() => expect(h.intervals).toHaveLength(1));
		h.next();
		await vi.waitFor(() => expect(h.intervals).toHaveLength(2));
		h.readers.stop();
		const [process] = h.processes;
		expect(process!.command.args).toEqual(["app-server"]);
		expect(h.processes).toHaveLength(2);
		for (const one of h.processes) {
			expect(one.sent).toEqual([
				{
					id: 0,
					method: "initialize",
					params: {
						clientInfo: { name: "devhub", title: "DevHub", version: "0.1.0" },
						capabilities: { experimentalApi: false, requestAttestation: false },
					},
				},
				{ method: "initialized" },
				{ id: 1, method: "account/read", params: {} },
				{
					id: 2,
					method: "account/rateLimits/read",
					params: { excludeResetCreditDetails: true },
				},
			]);
			expect(one.killed).toBe(true);
		}
		// 76% of the five-hour window: 30 s.
		expect(h.intervals).toEqual([30_000, 30_000]);
		expect(h.limits.wire().clis[1]).toEqual({
			cli: "codex",
			reader: { readAt: expect.any(Number) as number },
			windows: [
				{
					window: "5-hour",
					durationMinutes: 300,
					usedPercent: 76,
					resetsAt: 1_790_625_408_000,
				},
				{
					window: "7-day",
					durationMinutes: 10_080,
					usedPercent: 2,
					resetsAt: 1_791_091_364_000,
				},
			],
		});
	});

	it("read each kind once, with its first profile", async () => {
		const h = harness({
			profiles: [
				profile("cursor" as never),
				profile("claude", "First"),
				profile("claude", "Second"),
				profile("codex"),
			],
			answers: { claude: claude(() => CLAUDE_USAGE), codex: codex("chatgpt") },
		});
		await vi.waitFor(() => expect(h.intervals).toHaveLength(2));
		h.readers.stop();
		expect(h.processes.map((one) => one.command.file)).toEqual([
			"/opt/bin/claude",
			"/opt/bin/codex",
		]);
	});

	it("merge a reading with a GUI Agent's by the one rule: per window, the later reset, then the more used", async () => {
		const h = harness({
			profiles: [profile("claude")],
			answers: { claude: claude(() => CLAUDE_USAGE) },
		});
		const fiveHourReset = Date.parse("2026-09-28T14:59:59.559Z");
		// A GUI Agent's journal replays: more used of the same window, and a
		// seven-day reading from before its last reset.
		h.limits.observe("claude", {
			window: "5-hour",
			durationMinutes: 300,
			usedPercent: 95,
			resetsAt: fiveHourReset,
		});
		h.limits.observe("claude", {
			window: "7-day",
			durationMinutes: 10_080,
			usedPercent: 80,
			resetsAt: 1_000,
		});
		await vi.waitFor(() => expect(h.intervals).toHaveLength(1));
		h.readers.stop();
		expect(h.limits.wire().clis[0]).toEqual({
			cli: "claude",
			reader: { readAt: expect.any(Number) as number },
			windows: [
				{
					window: "5-hour",
					durationMinutes: 300,
					usedPercent: 95,
					resetsAt: fiveHourReset,
				},
				{
					window: "7-day",
					durationMinutes: 10_080,
					usedPercent: 34,
					resetsAt: Date.parse("2026-10-04T13:59:59.559Z"),
				},
			],
		});
		expect(h.published.at(-1)).toEqual(h.limits.wire());
	});

	it("say a sign-in without plan limits as a state, quietly, and take it back when windows are read", async () => {
		let available = false;
		const h = harness({
			profiles: [profile("claude"), profile("codex")],
			answers: {
				claude: claude(() =>
					available
						? CLAUDE_USAGE
						: { rate_limits_available: false, rate_limits: null },
				),
				codex: codex("apiKey"),
			},
		});
		await vi.waitFor(() => expect(h.intervals).toHaveLength(2));
		expect(h.limits.wire()).toEqual({
			clis: [
				{
					cli: "claude",
					note: "no_plan_limits",
					reader: { readAt: expect.any(Number) as number },
				},
				{
					cli: "codex",
					note: "no_plan_limits",
					reader: { readAt: expect.any(Number) as number },
				},
			],
		});
		// An API-key Codex is not asked for limits it cannot have.
		const codexProcess = h.processes.find((one) =>
			one.command.file.endsWith("codex"),
		)!;
		expect(codexProcess.sent.map((one) => one["method"])).not.toContain(
			"account/rateLimits/read",
		);
		expect(h.reports).toEqual([]);
		available = true;
		h.next();
		await vi.waitFor(() =>
			expect(h.limits.wire().clis[0]).toMatchObject({
				cli: "claude",
				windows: [{}, {}],
			}),
		);
		h.readers.stop();
		expect(h.limits.wire().clis[0]).not.toHaveProperty("note");
	});

	it("say a CLI whose command is not on this Mac, and start nothing for it", async () => {
		const h = harness({
			profiles: [profile("claude"), profile("codex")],
			answers: { claude: claude(() => CLAUDE_USAGE) },
			missing: ["codex"],
		});
		await vi.waitFor(() => expect(h.notes).toEqual(["cli_not_found"]));
		h.readers.stop();
		expect(h.processes).toHaveLength(1);
		expect(h.limits.wire().clis[1]).toEqual({
			cli: "codex",
			note: "cli_not_found",
		});
		expect(h.reports).toEqual([]);
	});

	it("say a process that stops once, and read again with a new process at the next tick", async () => {
		let healthy = false;
		const h = harness({
			profiles: [profile("claude")],
			answers: {
				claude: (m) => (healthy ? claude(() => CLAUDE_USAGE)(m) : "end"),
			},
		});
		await vi.waitFor(() => expect(h.reports).toHaveLength(1));
		const [failure] = h.reports;
		expect(failure).toBeInstanceOf(NamedFailure);
		expect(failure!.wire.code).toBe("usage_unreadable");
		expect(failure!.wire.actions).toEqual([]);
		expect(failure!.wire.detail).toBe(
			"Claude, read with the profile “Claude”: exit code 1",
		);
		await vi.waitFor(() => expect(h.intervals).toHaveLength(1));
		expect(h.processes).toHaveLength(1);
		expect(h.processes[0]!.killed).toBe(true);
		healthy = true;
		h.next();
		await vi.waitFor(() => expect(h.readings).toHaveLength(1));
		expect(h.processes).toHaveLength(2);
		expect(h.processes[1]!.sent[0]).toMatchObject({
			request: { subtype: "initialize" },
		});
		expect(h.reports).toHaveLength(1);
		h.readers.stop();
	});

	it("retry a failure at the cadence of the latest reading, then back off to 2, 5 and 10 minutes, saying it once per streak", async () => {
		let healthy = true;
		const h = harness({
			profiles: [profile("codex")],
			answers: { codex: (m) => (healthy ? codex("chatgpt")(m) : "end") },
		});
		await vi.waitFor(() => expect(h.readings).toHaveLength(1));
		await vi.waitFor(() => expect(h.intervals).toHaveLength(1));
		healthy = false;
		for (let n = 2; n <= 7; n += 1) {
			h.next();
			await vi.waitFor(() => expect(h.intervals).toHaveLength(n));
		}
		// 76% of the five-hour window: 30 s after the reading and the first
		// failure, then the backoff, which stays at its last step.
		expect(h.intervals).toEqual([
			30_000,
			30_000,
			...BACKOFF_MS,
			BACKOFF_MS.at(-1)!,
			BACKOFF_MS.at(-1)!,
		]);
		expect(h.processes).toHaveLength(7);
		expect(h.reports).toHaveLength(1);
		// It comes back: a reading ends the streak, so the next failure is news
		// and the cadence is the reading's again.
		healthy = true;
		h.next();
		await vi.waitFor(() => expect(h.readings).toHaveLength(2));
		await vi.waitFor(() => expect(h.intervals).toHaveLength(8));
		expect(h.intervals.at(-1)).toBe(30_000);
		healthy = false;
		h.next();
		await vi.waitFor(() => expect(h.reports).toHaveLength(2));
		h.readers.stop();
	});

	it("back off the same way while Claude cannot fetch its limits, keeping the last reading shown", async () => {
		let fetched = true;
		const h = harness({
			profiles: [profile("claude")],
			answers: {
				claude: claude(() =>
					fetched
						? {
								...CLAUDE_USAGE,
								rate_limits: {
									...CLAUDE_USAGE.rate_limits,
									five_hour: {
										utilization: 40,
										resets_at: "2026-09-28T14:59:59.559705+00:00",
									},
								},
							}
						: { rate_limits_available: true, rate_limits: null },
				),
			},
		});
		await vi.waitFor(() => expect(h.intervals).toEqual([60_000]));
		const shown = h.limits.wire().clis[0]!.windows;
		fetched = false;
		for (let n = 2; n <= 5; n += 1) {
			h.next();
			await vi.waitFor(() => expect(h.intervals).toHaveLength(n));
		}
		expect(h.intervals).toEqual([60_000, 60_000, ...BACKOFF_MS]);
		expect(h.limits.wire().clis[0]!.windows).toEqual(shown);
		expect(h.reports).toEqual([]);
		h.readers.stop();
	});

	it("kill a read that is not finished in time and read again at the next tick, never two at once", async () => {
		vi.useFakeTimers();
		try {
			let hang = true;
			const h = harness({
				profiles: [profile("claude")],
				answers: {
					claude: (message) =>
						hang &&
						(message["request"] as { subtype: string }).subtype === "get_usage"
							? []
							: claude(() => CLAUDE_USAGE)(message),
				},
			});
			await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
			expect(h.processes).toHaveLength(1);
			expect(h.processes[0]!.killed).toBe(false);
			expect(h.reports).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(h.reports).toHaveLength(1);
			expect(h.reports[0]!.wire.detail).toContain("not answered within 30 s");
			expect(h.processes[0]!.killed).toBe(true);
			// Nothing read yet: the usual 60 s, not a backoff.
			expect(h.intervals).toEqual([60_000]);
			hang = false;
			h.next();
			await vi.advanceTimersByTimeAsync(0);
			expect(h.processes).toHaveLength(2);
			expect(h.readings).toHaveLength(1);
			expect(h.reports).toHaveLength(1);
			expect(h.aliveAtSpawn).toEqual([0, 0]);
			h.readers.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("say an answer in an unexpected shape once, and kill its process", async () => {
		const h = harness({
			profiles: [profile("claude")],
			answers: {
				claude: claude(() => ({
					rate_limits_available: true,
					rate_limits: { five_hour: { utilization: "lots" } },
				})),
			},
		});
		await vi.waitFor(() => expect(h.reports).toHaveLength(1));
		expect(h.reports[0]!.wire.detail).toMatch(
			/^Claude, read with the profile “Claude”: control_response\(get_usage\)\.response\.response\.rate_limits\.five_hour\.utilization: expected a number$/u,
		);
		expect(h.processes[0]!.killed).toBe(true);
		expect(h.readings).toEqual([]);
		// Nothing read yet: the usual cadence before the retry.
		expect(h.intervals).toEqual([60_000]);
		h.readers.stop();
	});

	it("take a plan whose limits the CLI could not fetch just now as no reading, not a failure", async () => {
		let fetched = false;
		const h = harness({
			profiles: [profile("claude")],
			answers: {
				claude: claude(() =>
					fetched
						? CLAUDE_USAGE
						: { rate_limits_available: true, rate_limits: null },
				),
			},
		});
		await vi.waitFor(() => expect(h.intervals).toEqual([60_000]));
		expect(h.readings).toEqual([]);
		expect(h.reports).toEqual([]);
		fetched = true;
		h.next();
		await vi.waitFor(() => expect(h.readings).toHaveLength(1));
		h.readers.stop();
		expect(h.reports).toEqual([]);
		expect(h.processes).toHaveLength(2);
	});

	it("say a refused request and a Codex that is not signed in as failures", async () => {
		const refusing = harness({
			profiles: [profile("claude")],
			answers: {
				claude: (message) => {
					const request = message["request"] as { subtype: string };
					return request.subtype === "initialize"
						? [claudeSuccess(message, {})]
						: [
								{
									type: "control_response",
									response: {
										subtype: "error",
										request_id: message["request_id"],
										error: "Unsupported control request subtype: get_usage",
									},
								},
							];
				},
			},
		});
		await vi.waitFor(() => expect(refusing.reports).toHaveLength(1));
		expect(refusing.reports[0]!.wire.detail).toContain(
			"claude refused get_usage: Unsupported control request subtype: get_usage",
		);
		const signedOut = harness({
			profiles: [profile("codex")],
			answers: { codex: codex(null) },
		});
		await vi.waitFor(() => expect(signedOut.reports).toHaveLength(1));
		expect(signedOut.reports[0]!.wire.detail).toContain(
			"codex is not signed in",
		);
	});

	it("say a process that could not start", async () => {
		const h = harness({
			profiles: [profile("codex")],
			answers: { codex: () => "end" },
		});
		await vi.waitFor(() => expect(h.reports).toHaveLength(1));
		expect(h.reports[0]!.wire.detail).toBe(
			"Codex, read with the profile “Codex”: exit code 1",
		);
	});

	it("end quietly when stopped, whatever the stop does to a read in flight", async () => {
		const h = harness({
			profiles: [profile("claude")],
			// Never answers get_usage.
			answers: {
				claude: (message) =>
					(message["request"] as { subtype: string }).subtype === "initialize"
						? [claudeSuccess(message, {})]
						: [],
			},
		});
		await vi.waitFor(() => expect(h.processes[0]?.sent).toHaveLength(2));
		h.readers.stop();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(h.processes[0]!.killed).toBe(true);
		expect(h.reports).toEqual([]);
	});
	it("keep following the reader when Claude's resets differ by a fraction of a second from one reading to the next (the frozen readout)", async () => {
		// What Claude's usage endpoint answers: the same window's reset with
		// a fraction that changes on every request, and usage that grows.
		const answers = [
			{ used: 40, reset: "2026-09-28T14:59:59.912345+00:00" },
			{ used: 45, reset: "2026-09-28T14:59:59.103456+00:00" },
			{ used: 52, reset: "2026-09-28T14:59:59.559705+00:00" },
		];
		let n = 0;
		const h = harness({
			profiles: [profile("claude")],
			answers: {
				claude: claude(() => {
					const one = answers[Math.min(n, answers.length - 1)]!;
					return {
						rate_limits_available: true,
						rate_limits: {
							five_hour: { utilization: one.used, resets_at: one.reset },
							seven_day: null,
						},
					};
				}),
			},
		});
		const shown = () => h.limits.wire().clis[0]!.windows?.[0]?.usedPercent;
		await vi.waitFor(() => expect(shown()).toBe(40));
		n = 1;
		h.next();
		await vi.waitFor(() => expect(h.readings).toHaveLength(2));
		// Compared exactly, 14:59:59.103 is "older" than 14:59:59.912, and the
		// readout stayed at 40% until the window reset.
		expect(shown()).toBe(45);
		// A GUI Agent's rate_limit_event says the same reset in whole
		// seconds, 15:00:00: it no longer holds the window against the reader.
		h.limits.observe("claude", {
			window: "5-hour",
			durationMinutes: 300,
			usedPercent: 47,
			resetsAt: Date.parse("2026-09-28T15:00:00Z"),
		});
		expect(shown()).toBe(47);
		n = 2;
		h.next();
		await vi.waitFor(() => expect(h.readings).toHaveLength(3));
		expect(shown()).toBe(52);
		h.readers.stop();
	});

	it("put the reader's status on the wire: when it last read, and why its latest attempt gave nothing", async () => {
		let clock = 1_000_000;
		let fetched = true;
		const h = harness({
			profiles: [profile("claude")],
			now: () => clock,
			answers: {
				claude: claude(() =>
					fetched
						? CLAUDE_USAGE
						: { rate_limits_available: true, rate_limits: null },
				),
			},
		});
		await vi.waitFor(() => expect(h.readings).toHaveLength(1));
		expect(h.limits.wire().clis[0]!.reader).toEqual({ readAt: 1_000_000 });
		fetched = false;
		clock = 1_060_000;
		h.next();
		await vi.waitFor(() => expect(h.statuses).toHaveLength(2));
		expect(h.limits.wire().clis[0]!.reader).toEqual({
			readAt: 1_000_000,
			problem: {
				at: 1_060_000,
				text: expect.stringMatching(
					/^no reading: Claude could not fetch its limits/u,
				),
			},
		});
		expect(h.published.at(-1)).toEqual(h.limits.wire());
		fetched = true;
		clock = 1_120_000;
		h.next();
		await vi.waitFor(() => expect(h.readings).toHaveLength(2));
		expect(h.limits.wire().clis[0]!.reader).toEqual({ readAt: 1_120_000 });
		h.readers.stop();
	});

	it("log each kind of outcome when it changes, and the same outcome again only every 15 minutes", async () => {
		let clock = 0;
		let healthy = true;
		const h = harness({
			profiles: [profile("claude")],
			now: () => clock,
			answers: {
				claude: (m) => (healthy ? claude(() => CLAUDE_USAGE)(m) : "end"),
			},
		});
		const step = async (ms: number) => {
			clock += ms;
			const before = h.intervals.length;
			h.next();
			await vi.waitFor(() => expect(h.intervals).toHaveLength(before + 1));
		};
		await vi.waitFor(() => expect(h.intervals).toHaveLength(1));
		await step(60_000);
		await step(60_000);
		healthy = false;
		await step(60_000);
		await step(60_000);
		await step(16 * 60_000);
		h.readers.stop();
		expect(h.logs).toEqual([
			"[devhub] usage reader claude: read in 0.0 s: 5-hour 91% resets 2026-09-28T14:59:59.559Z, 7-day 34% resets 2026-10-04T13:59:59.559Z",
			"[devhub] usage reader claude: failed after 0.0 s: exit code 1 (1 in a row; next in 15.0 s) [2 attempts not logged since the last line]",
			"[devhub] usage reader claude: failed after 0.0 s: exit code 1 (3 in a row; next in 5 min) [1 attempts not logged since the last line]",
		]);
	});

	it("put finding the environment under the timeout too, and go on reading after it hangs", async () => {
		vi.useFakeTimers();
		try {
			let hang = true;
			const h = harness({
				profiles: [profile("claude")],
				answers: { claude: claude(() => CLAUDE_USAGE) },
				environment: () =>
					hang
						? new Promise<Record<string, string>>(() => undefined)
						: Promise.resolve({ PATH: "/usr/bin" }),
			});
			await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
			expect(h.reports).toHaveLength(1);
			expect(h.reports[0]!.wire.detail).toContain("not answered within 30 s");
			expect(h.statuses).toHaveLength(1);
			expect(h.intervals).toEqual([60_000]);
			// The hung attempt never starts a process afterwards.
			expect(h.processes).toHaveLength(0);
			hang = false;
			h.next();
			await vi.advanceTimersByTimeAsync(0);
			expect(h.readings).toHaveLength(1);
			expect(h.processes).toHaveLength(1);
			h.readers.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("take a start that throws as a failure, and look the command up again after it", async () => {
		let throws = true;
		const h = harness({
			profiles: [profile("claude")],
			answers: { claude: claude(() => CLAUDE_USAGE) },
			spawnThrows: () => throws,
		});
		await vi.waitFor(() => expect(h.reports).toHaveLength(1));
		expect(h.reports[0]!.wire.detail).toContain("ENOENT");
		throws = false;
		h.next();
		await vi.waitFor(() => expect(h.readings).toHaveLength(1));
		expect(h.resolved).toEqual(["claude", "claude"]);
		// A reading keeps the command it found.
		h.next();
		await vi.waitFor(() => expect(h.readings).toHaveLength(2));
		expect(h.resolved).toHaveLength(2);
		h.readers.stop();
	});
});
