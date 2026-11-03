/**
 * The header's numbers, from what each OS prints.
 */

import { describe, expect, it } from "vitest";
import {
	darwinPressureLevel,
	parseDarwinSysctl,
	parseMeminfo,
	parseVmStatUsed,
	psiLevel,
	readSystemMemory,
} from "./systemMemory.js";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3521.
Pages active:                            300000.
Pages inactive:                          290000.
Pages speculative:                         1200.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                          10000.
"Translation faults":                1234567890.
Pages copy-on-write:                   12345678.
Pages zero filled:                    987654321.
Pages reactivated:                      1234567.
Pages purged:                            123456.
File-backed pages:                       200000.
Anonymous pages:                         400000.
Pages stored in compressor:              500000.
Pages occupied by compressor:            120000.
Decompressions:                         1234567.
Compressions:                           2345678.
Pageins:                                3456789.
Pageouts:                                 12345.
Swapins:                                  45678.
Swapouts:                                 56789.
`;

describe("macOS", () => {
	it("reads the kernel's pressure level", () => {
		expect(darwinPressureLevel("1\n")).toBe("normal");
		expect(darwinPressureLevel("2")).toBe("warning");
		expect(darwinPressureLevel("4")).toBe("critical");
		expect(darwinPressureLevel("")).toBe("unknown");
	});

	it("reads the size, the swap line and the level in one sysctl", () => {
		expect(
			parseDarwinSysctl(
				"17179869184\ntotal = 3072.00M  used = 2310.75M  free = 761.25M  (encrypted)\n2\n",
			),
		).toEqual({
			totalBytes: 17179869184,
			swap: { totalBytes: 3072 * 1024 ** 2, usedBytes: 2310.75 * 1024 ** 2 },
			pressure: "warning",
		});
	});

	it("counts used memory as Activity Monitor does: app, wired, compressed", () => {
		expect(parseVmStatUsed(VM_STAT)).toBe(
			(400000 - 10000 + 150000 + 120000) * 16384,
		);
	});

	it("counts active pages as the app's where vm_stat has no anonymous count", () => {
		const old = VM_STAT.replace(/^Anonymous pages:.*\n/mu, "");
		expect(parseVmStatUsed(old)).toBe((300000 + 150000 + 120000) * 16384);
	});

	it("is read from sysctl and vm_stat", async () => {
		const asked: string[] = [];
		const memory = await readSystemMemory({
			platform: "darwin",
			run: (file) => {
				asked.push(file);
				return Promise.resolve(
					file.endsWith("sysctl")
						? "17179869184\ntotal = 0.00M  used = 0.00M  free = 0.00M\n4\n"
						: VM_STAT,
				);
			},
			read: () => Promise.reject(new Error("not on macOS")),
		});
		expect(asked.sort()).toEqual(["/usr/bin/vm_stat", "/usr/sbin/sysctl"]);
		expect(memory.pressure).toBe("critical");
		expect(memory.swapUsedBytes).toBe(0);
	});
});

describe("Linux", () => {
	it("reads /proc/meminfo", () => {
		expect(
			parseMeminfo(
				"MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n",
			),
		).toEqual({
			totalBytes: 16000000 * 1024,
			usedBytes: 10000000 * 1024,
			swapTotalBytes: 2000000 * 1024,
			swapUsedBytes: 500000 * 1024,
		});
	});

	it("reads PSI into the same three levels", () => {
		const psi = (some: number, full: number) =>
			`some avg10=${String(some)} avg60=0.00 avg300=0.00 total=1\nfull avg10=${String(full)} avg60=0.00 avg300=0.00 total=1\n`;
		expect(psiLevel(psi(0.5, 0)).pressure).toBe("normal");
		expect(psiLevel(psi(12.3, 2)).pressure).toBe("warning");
		expect(psiLevel(psi(45, 3)).pressure).toBe("critical");
		expect(psiLevel(psi(20, 11)).pressure).toBe("critical");
		expect(psiLevel(psi(12.3, 2)).source).toBe(
			"PSI memory: some 12.3%, full 2% (10 s)",
		);
		expect(psiLevel(undefined).pressure).toBe("unknown");
	});

	it("is read from /proc", async () => {
		const memory = await readSystemMemory({
			platform: "linux",
			run: () => Promise.reject(new Error("no commands on Linux")),
			read: (path) =>
				Promise.resolve(
					path === "/proc/meminfo"
						? "MemTotal: 100 kB\nMemAvailable: 40 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n"
						: undefined,
				),
		});
		expect(memory).toEqual({
			totalBytes: 102400,
			usedBytes: 61440,
			swapTotalBytes: 0,
			swapUsedBytes: 0,
			pressure: "unknown",
			pressureSource: "/proc/pressure/memory is absent",
		});
	});
});
