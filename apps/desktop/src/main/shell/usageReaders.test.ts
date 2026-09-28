/**
 * The background usage readers, against scripted CLIs: what each one is sent
 * (control requests and account reads only — never anything that starts a
 * turn), how its answers are decoded, how often it asks, how its readings
 * merge with a GUI Agent's, and that a failure is said once and ends it.
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
import { UsageLimits, usageReadingListener } from "./usageLimits.js";
import {
	type LineProcess,
	pollInterval,
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
}) {
	const limits = new UsageLimits();
	const published: UsageLimitsWire[] = [];
	const listener = usageReadingListener(limits, (wire) => published.push(wire));
	const processes: ScriptedProcess[] = [];
	const intervals: number[] = [];
	const reports: NamedFailure[] = [];
	const readings: UsageReading[] = [];
	const notes: UsageNoteWire[] = [];
	const ticks: (() => void)[] = [];
	const readers = startUsageReaders({
		profiles: options.profiles,
		runtime: {
			resolveProgram: (configured) =>
				Promise.resolve<SettingsResolvedRuntimeWire>(
					options.missing?.includes(configured)
						? {
								kind: "unavailable",
								configured,
								lookup: { kind: "path", directories: [] },
							}
						: { kind: "absolute_path", value: `/opt/bin/${configured}` },
				),
			environment: () =>
				Promise.resolve({ PATH: "/usr/bin", HOME: "/home/testuser" }),
			home: () => Promise.resolve("/home/testuser"),
		},
		searchPath: "/usr/bin",
		clientVersion: "0.1.0",
		spawn: (command) => {
			const name = command.file.split("/").at(-1) as "claude" | "codex";
			const answer = options.answers[name];
			if (answer === undefined) throw new Error(`no script for ${name}`);
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
		report: (failure) => reports.push(failure),
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
		intervals,
		reports,
		readings,
		notes,
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
					usedPercent: 91,
					resetsAt: Date.parse("2026-09-28T14:59:59.559Z"),
				},
				{
					window: "7-day",
					usedPercent: 34,
					resetsAt: Date.parse("2026-10-04T13:59:59.559Z"),
				},
			],
		});
	});

	it("names Claude's windows as the stream's rate_limit_event does, so the two are one window", () => {
		const reading = decodeUsage(CLAUDE_USAGE, undefined);
		expect(
			reading.kind === "windows" && reading.windows.map((one) => one.window),
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
			windows: [{ window: "7-day", usedPercent: 3, resetsAt: undefined }],
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
				{ window: "5-hour", usedPercent: 76, resetsAt: 1_790_625_408_000 },
				{ window: "7-day", usedPercent: 2, resetsAt: 1_791_091_364_000 },
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
		expect(process!.sent).toEqual([
			{
				type: "control_request",
				request_id: "devhub-usage-1",
				request: { subtype: "initialize" },
			},
			{
				type: "control_request",
				request_id: "devhub-usage-2",
				request: { subtype: "get_usage" },
			},
			{
				type: "control_request",
				request_id: "devhub-usage-3",
				request: { subtype: "get_usage" },
			},
		]);
		// 91% of the five-hour window: 15 s.
		expect(h.intervals).toEqual([15_000, 15_000]);
		expect(process!.killed).toBe(true);
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
		expect(process!.sent).toEqual([
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
			{ id: 3, method: "account/read", params: {} },
			{
				id: 4,
				method: "account/rateLimits/read",
				params: { excludeResetCreditDetails: true },
			},
		]);
		// 76% of the five-hour window: 30 s.
		expect(h.intervals).toEqual([30_000, 30_000]);
		expect(h.limits.wire().clis[1]).toEqual({
			cli: "codex",
			windows: [
				{ window: "5-hour", usedPercent: 76, resetsAt: 1_790_625_408_000 },
				{ window: "7-day", usedPercent: 2, resetsAt: 1_791_091_364_000 },
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
			usedPercent: 95,
			resetsAt: fiveHourReset,
		});
		h.limits.observe("claude", {
			window: "7-day",
			usedPercent: 80,
			resetsAt: 1_000,
		});
		await vi.waitFor(() => expect(h.intervals).toHaveLength(1));
		h.readers.stop();
		expect(h.limits.wire().clis[0]).toEqual({
			cli: "claude",
			windows: [
				{ window: "5-hour", usedPercent: 95, resetsAt: fiveHourReset },
				{
					window: "7-day",
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
				{ cli: "claude", note: "no_plan_limits" },
				{ cli: "codex", note: "no_plan_limits" },
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

	it("say a process that stops once, and do not start it again", async () => {
		const h = harness({
			profiles: [profile("claude")],
			answers: { claude: claude(() => CLAUDE_USAGE) },
		});
		await vi.waitFor(() => expect(h.intervals).toHaveLength(1));
		// Between reads: the wait is cut short by the end.
		h.processes[0]!.end("claude stopped (exit code 1): boom");
		await vi.waitFor(() => expect(h.reports).toHaveLength(1));
		const [failure] = h.reports;
		expect(failure).toBeInstanceOf(NamedFailure);
		expect(failure!.wire.code).toBe("usage_unreadable");
		expect(failure!.wire.actions).toEqual([]);
		expect(failure!.wire.detail).toBe(
			"Claude, read with the profile “Claude”: claude stopped (exit code 1): boom",
		);
		h.next();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(h.reports).toHaveLength(1);
		expect(h.processes).toHaveLength(1);
		expect(h.intervals).toHaveLength(1);
	});

	it("say an answer in an unexpected shape once, and stop the reader and its process", async () => {
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
		expect(h.intervals).toEqual([]);
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
});
