import { describe, expect, it } from "vitest";
import type { CountersReading } from "./counters.js";
import {
	metricsReport,
	type ProcessMetricInput,
	type ViewIdentity,
} from "./metrics.js";

const noCounters: CountersReading = { elapsedMs: 0, counters: [] };
/** No loop has run a round, which is what a report with no runtimes means. */
const noRounds = (): number => 0;
const noCpu = { userMs: 0, systemMs: 0 };

function metric(
	pid: number,
	type: string,
	cpuPercent: number,
	memoryKb = 0,
): ProcessMetricInput {
	return {
		pid,
		type,
		cpu: { percentCPUUsage: cpuPercent },
		memory: { workingSetSize: memoryKb },
	};
}

function view(
	pid: number,
	id: number,
	surfaceKey: string,
	onScreen: boolean,
): ViewIdentity {
	return { pid, id, surfaceKey, onScreen };
}

describe("metricsReport", () => {
	it("names the renderer processes DevHub recognises and leaves the rest alone", () => {
		const report = metricsReport({
			takenAt: 0,
			uptimeMs: 1_000,
			mainProcessCpu: noCpu,
			processMetrics: [metric(1, "Browser", 2), metric(7, "Tab", 5)],
			views: [view(7, 42, "workspace:one", true)],
			counters: noCounters,
			terminalLauncher: [],
			terminalClients: [],
			roundsLastMinute: noRounds,
			runtimes: [],
		});

		expect(report.processes.map((one) => one.pid)).toEqual([7, 1]);
		expect(report.processes[0]?.workbench).toEqual(
			view(7, 42, "workspace:one", true),
		);
		expect(report.processes[1]?.workbench).toBeUndefined();
	});

	it("orders processes by CPU so the heaviest is the first line read", () => {
		const report = metricsReport({
			takenAt: 0,
			uptimeMs: 0,
			mainProcessCpu: noCpu,
			processMetrics: [
				metric(1, "Tab", 0.5),
				metric(2, "GPU", 9),
				metric(3, "Tab", 3),
			],
			views: [],
			counters: noCounters,
			terminalLauncher: [],
			terminalClients: [],
			roundsLastMinute: noRounds,
			runtimes: [],
		});
		expect(report.processes.map((one) => one.cpuPercent)).toEqual([9, 3, 0.5]);
		expect(report.totalCpuPercent).toBeCloseTo(12.5);
	});

	it("names a shared renderer after the workbench that is on screen", () => {
		const report = metricsReport({
			takenAt: 0,
			uptimeMs: 0,
			mainProcessCpu: noCpu,
			processMetrics: [metric(7, "Tab", 1)],
			views: [
				view(7, 1, "workspace:hidden", false),
				view(7, 2, "workspace:shown", true),
			],
			counters: noCounters,
			terminalLauncher: [],
			terminalClients: [],
			roundsLastMinute: noRounds,
			runtimes: [],
		});
		expect(report.processes[0]?.workbench?.surfaceKey).toBe("workspace:shown");
	});

	it("carries the counters and the moment the reading was taken", () => {
		const counters: CountersReading = {
			elapsedMs: 60_000,
			counters: [
				{ name: "process.tmux", total: 600, perMinuteSinceStart: 600 },
			],
		};
		const report = metricsReport({
			takenAt: Date.UTC(2026, 0, 2, 3, 4, 5),
			uptimeMs: 60_000,
			mainProcessCpu: { userMs: 12_000, systemMs: 8_000 },
			processMetrics: [],
			views: [],
			counters,
			terminalLauncher: [],
			terminalClients: [],
			roundsLastMinute: noRounds,
			runtimes: [],
		});
		expect(report.takenAt).toBe("2026-01-02T03:04:05.000Z");
		expect(report.mainProcessCpu).toEqual({ userMs: 12_000, systemMs: 8_000 });
		expect(report.counters).toEqual(counters);
		expect(report.totalCpuPercent).toBe(0);
	});
});

describe("the tmux clients a reading carries", () => {
	// The count is the whole point: one client per terminal on screen, and a
	// reading that shows more is a client that outlived its terminal.
	it("reports every attached client, so a leak has somewhere to show", () => {
		const report = metricsReport({
			takenAt: 0,
			uptimeMs: 0,
			mainProcessCpu: noCpu,
			processMetrics: [],
			views: [],
			counters: noCounters,
			terminalLauncher: [],
			runtimes: [],
			roundsLastMinute: noRounds,
			terminalClients: [
				{ tty: "/dev/ttys001", session: "scratch" },
				{ tty: "/dev/ttys002", session: "ws-abc" },
			],
		});

		expect(report.terminalClients).toHaveLength(2);
		expect(report.terminalClients[0]).toEqual({
			tty: "/dev/ttys001",
			session: "scratch",
		});
	});
});

describe("what a round costs on each machine", () => {
	const local = {
		id: "local" as const,
		connected: true,
		masterPid: undefined,
		medianRoundTripMs: 2,
		reconcileIntervalMs: 300,
		execsLastMinute: 200,
		loginEnvironmentNames: [],
		lastFailure: undefined,
	};

	it("divides a machine's commands into its rounds, which is the number", () => {
		const report = metricsReport({
			takenAt: 0,
			uptimeMs: 0,
			mainProcessCpu: noCpu,
			processMetrics: [],
			views: [],
			counters: noCounters,
			terminalLauncher: [],
			terminalClients: [],
			runtimes: [local],
			roundsLastMinute: () => 200,
		});

		expect(report.runtimes[0]?.roundsPerMin).toBe(200);
		// One command per round is what the batch is for. It was the Agent
		// count plus one.
		expect(report.runtimes[0]?.execPerRound).toBe(1);
		expect(report.runtimes[0]?.medianRoundTripMs).toBe(2);
	});

	it("says nothing rather than infinity when no round has run", () => {
		const report = metricsReport({
			takenAt: 0,
			uptimeMs: 0,
			mainProcessCpu: noCpu,
			processMetrics: [],
			views: [],
			counters: noCounters,
			terminalLauncher: [],
			terminalClients: [],
			runtimes: [local],
			roundsLastMinute: noRounds,
		});

		expect(report.runtimes[0]?.roundsPerMin).toBe(0);
		expect(report.runtimes[0]?.execPerRound).toBe(0);
	});
});

// The docs said `--metrics` reported this before it did. A launcher that
// could not be installed showed in one log line and in the terminal tab of
// each window that wanted it, which is exactly where nobody was looking when
// the packaged app opened every window without one.
describe("whether each machine has a terminal launcher", () => {
	it("says where it is, per machine, installed or not", () => {
		const report = metricsReport({
			takenAt: 0,
			uptimeMs: 0,
			mainProcessCpu: noCpu,
			processMetrics: [],
			views: [],
			counters: noCounters,
			terminalClients: [],
			runtimes: [],
			roundsLastMinute: noRounds,
			terminalLauncher: [
				{
					machine: "local",
					installed: true,
					path: "/data/devhub/devhub/devhub-terminal",
					reason: undefined,
				},
				{
					machine: "ssh:build-box.example.com",
					installed: false,
					path: undefined,
					reason: "the bundle is not there",
				},
			],
		});

		expect(report.terminalLauncher).toEqual([
			{
				machine: "local",
				installed: true,
				path: "/data/devhub/devhub/devhub-terminal",
				reason: undefined,
			},
			{
				machine: "ssh:build-box.example.com",
				installed: false,
				path: undefined,
				reason: "the bundle is not there",
			},
		]);
	});
});
