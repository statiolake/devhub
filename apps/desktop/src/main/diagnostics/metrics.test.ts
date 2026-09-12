import { describe, expect, it } from "vitest";
import type { CountersReading } from "./counters.js";
import {
	metricsReport,
	type ProcessMetricInput,
	type ViewIdentity,
} from "./metrics.js";

const noCounters: CountersReading = { elapsedMs: 0, counters: [] };
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
			terminalClients: [],
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
			terminalClients: [],
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
			terminalClients: [],
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
			terminalClients: [],
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
			runtimes: [],
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
