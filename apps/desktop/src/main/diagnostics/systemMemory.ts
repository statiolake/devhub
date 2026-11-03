/**
 * The machine's memory, as the Task Manager's header states it: how much
 * there is, how much is used, how much is in swap, and how hard the kernel
 * says it is pressed.
 *
 * Read from what the OS already keeps, one or two cheap reads per refresh:
 *
 * - **macOS.** `sysctl -n hw.memsize vm.swapusage
 *   kern.memorystatus_vm_pressure_level` — the size, the swap line and the
 *   level the kernel's memory status uses itself (1 normal, 2 warning,
 *   4 critical: what Activity Monitor's pressure graph colours by) — and
 *   `vm_stat` for where it is, broken down the way Activity Monitor does
 *   (`parseVmStatBreakdown`): app memory (anonymous pages less purgeable
 *   ones), wired, what the compressor occupies (and what it stores), cached
 *   files (file-backed and purgeable) and the rest free. "Used" is app, wired
 *   and compressed, Activity Monitor's "Memory Used".
 * - **Linux.** `/proc/meminfo` (used is `MemTotal − MemAvailable`, the parts
 *   `parseMeminfo` says) and PSI's `/proc/pressure/memory`, read into the
 *   same three levels (`psiLevel`).
 *
 * Every parser is a pure function of the text, so each is tested on what the
 * real command prints.
 */

import type {
	MemoryBreakdownWire as MemoryBreakdown,
	MemoryPressureWire as MemoryPressure,
	SystemMemoryWire as SystemMemory,
} from "../../ipc/taskManager.js";

export type { MemoryBreakdown, MemoryPressure, SystemMemory };

/** The arguments to `sysctl`, in the order `parseDarwinSysctl` reads them. */
export const DARWIN_SYSCTL_ARGUMENTS: readonly string[] = [
	"-n",
	"hw.memsize",
	"vm.swapusage",
	"kern.memorystatus_vm_pressure_level",
];

/** `kern.memorystatus_vm_pressure_level`, as a level. */
export function darwinPressureLevel(value: string): MemoryPressure {
	switch (value.trim()) {
		case "1":
			return "normal";
		case "2":
			return "warning";
		case "4":
			return "critical";
		default:
			return "unknown";
	}
}

const SIZE_UNITS: Readonly<Record<string, number>> = {
	K: 1024,
	M: 1024 ** 2,
	G: 1024 ** 3,
	T: 1024 ** 4,
};

/** `total = 2048.00M  used = 1235.25M  free = 812.75M  (encrypted)`. */
export function parseDarwinSwapUsage(line: string): {
	readonly totalBytes: number;
	readonly usedBytes: number;
} {
	const size = (name: string): number => {
		const match = new RegExp(`${name}\\s*=\\s*([\\d.]+)([KMGT])`, "u").exec(
			line,
		);
		return match ? Number(match[1]) * (SIZE_UNITS[match[2]!] ?? 1) : 0;
	};
	return { totalBytes: size("total"), usedBytes: size("used") };
}

/** The three lines `sysctl -n` prints for `DARWIN_SYSCTL_ARGUMENTS`. */
export function parseDarwinSysctl(stdout: string): {
	readonly totalBytes: number;
	readonly swap: { readonly totalBytes: number; readonly usedBytes: number };
	readonly pressure: MemoryPressure;
} {
	const [memsize = "", swapusage = "", level = ""] = stdout
		.split("\n")
		.map((line) => line.trim());
	return {
		totalBytes: Number(memsize) || 0,
		swap: parseDarwinSwapUsage(swapusage),
		pressure: darwinPressureLevel(level),
	};
}

/**
 * Where `vm_stat` says the memory is, in bytes, as Activity Monitor breaks it
 * down: app (anonymous less purgeable), wired, compressed (the RAM the
 * compressor occupies; `compressorStoredBytes` is what it holds), cached
 * files (file-backed and purgeable), and free — the rest of `totalBytes`, so
 * the five add up. A `vm_stat` without the anonymous count (older macOS)
 * counts active pages as the app's.
 */
export function parseVmStatBreakdown(
	stdout: string,
	totalBytes: number,
): MemoryBreakdown {
	const pageSize = Number(/page size of (\d+) bytes/u.exec(stdout)?.[1]) || 0;
	const pages = (label: string): number | undefined => {
		const match = new RegExp(`^${label}:\\s+(\\d+)\\.?$`, "mu").exec(stdout);
		return match ? Number(match[1]) : undefined;
	};
	const anonymous = pages("Anonymous pages");
	const purgeable = pages("Pages purgeable") ?? 0;
	const app =
		anonymous === undefined
			? (pages("Pages active") ?? 0)
			: Math.max(0, anonymous - purgeable);
	const wired = pages("Pages wired down") ?? 0;
	const compressed = pages("Pages occupied by compressor") ?? 0;
	const cached = (pages("File-backed pages") ?? 0) + purgeable;
	const appBytes = app * pageSize;
	const wiredBytes = wired * pageSize;
	const compressedBytes = compressed * pageSize;
	const cachedBytes = cached * pageSize;
	return {
		appBytes,
		wiredBytes,
		compressedBytes,
		compressorStoredBytes:
			(pages("Pages stored in compressor") ?? 0) * pageSize,
		cachedBytes,
		freeBytes: Math.max(
			0,
			totalBytes - appBytes - wiredBytes - compressedBytes - cachedBytes,
		),
	};
}

/** App, wired and compressed: Activity Monitor's "Memory Used". */
export function usedOf(breakdown: MemoryBreakdown): number {
	return breakdown.appBytes + breakdown.wiredBytes + breakdown.compressedBytes;
}

/**
 * `/proc/meminfo`'s totals, in bytes, and the same five parts: app is
 * `AnonPages`, wired the kernel's own (`SUnreclaim`, `KernelStack`,
 * `PageTables`), compressed zswap's pool (`Zswap`, storing `Zswapped`),
 * cached `Buffers + Cached + SReclaimable`, free `MemFree`.
 */
export function parseMeminfo(text: string): {
	readonly totalBytes: number;
	readonly usedBytes: number;
	readonly breakdown: MemoryBreakdown;
	readonly swapTotalBytes: number;
	readonly swapUsedBytes: number;
} {
	const kib = (name: string): number =>
		(Number(new RegExp(`^${name}:\\s+(\\d+)`, "mu").exec(text)?.[1]) || 0) *
		1024;
	const total = kib("MemTotal");
	const swapTotal = kib("SwapTotal");
	return {
		totalBytes: total,
		usedBytes: Math.max(0, total - kib("MemAvailable")),
		breakdown: {
			appBytes: kib("AnonPages"),
			wiredBytes: kib("SUnreclaim") + kib("KernelStack") + kib("PageTables"),
			compressedBytes: kib("Zswap"),
			compressorStoredBytes: kib("Zswapped"),
			cachedBytes: kib("Buffers") + kib("Cached") + kib("SReclaimable"),
			freeBytes: kib("MemFree"),
		},
		swapTotalBytes: swapTotal,
		swapUsedBytes: Math.max(0, swapTotal - kib("SwapFree")),
	};
}

/**
 * PSI's memory line, as a level.
 *
 * `some avg10` is the share of the last ten seconds in which at least one
 * task stalled on memory; `full avg10` the share in which every task did.
 * Any stall that is sustained is a warning (≥ 10% some); a machine where
 * everything waits for a tenth of the time, or something waits for most of
 * it, is critical. No file (an old kernel, PSI off) is unknown.
 */
export function psiLevel(text: string | undefined): {
	readonly pressure: MemoryPressure;
	readonly source: string;
} {
	const avg = (kind: "some" | "full"): number | undefined => {
		const match = new RegExp(`^${kind} avg10=([\\d.]+)`, "mu").exec(text ?? "");
		return match ? Number(match[1]) : undefined;
	};
	const some = avg("some");
	if (some === undefined) {
		return { pressure: "unknown", source: "/proc/pressure/memory is absent" };
	}
	const full = avg("full") ?? 0;
	const source = `PSI memory: some ${String(some)}%, full ${String(full)}% (10 s)`;
	if (full >= 10 || some >= 40) return { pressure: "critical", source };
	if (some >= 10) return { pressure: "warning", source };
	return { pressure: "normal", source };
}

/** How the reader reaches the OS; the controller's are `execFile` and `readFile`. */
export interface SystemMemorySources {
	readonly platform: NodeJS.Platform;
	run(file: string, args: readonly string[]): Promise<string>;
	read(path: string): Promise<string | undefined>;
}

/** The machine's memory now. */
export async function readSystemMemory(
	sources: SystemMemorySources,
): Promise<SystemMemory> {
	if (sources.platform === "darwin") {
		const [sysctl, vmStat] = await Promise.all([
			sources.run("/usr/sbin/sysctl", DARWIN_SYSCTL_ARGUMENTS),
			sources.run("/usr/bin/vm_stat", []),
		]);
		const { totalBytes, swap, pressure } = parseDarwinSysctl(sysctl);
		const breakdown = parseVmStatBreakdown(vmStat, totalBytes);
		return {
			totalBytes,
			usedBytes: Math.min(totalBytes, usedOf(breakdown)),
			breakdown,
			swapUsedBytes: swap.usedBytes,
			swapTotalBytes: swap.totalBytes,
			pressure,
			pressureSource: "kern.memorystatus_vm_pressure_level",
		};
	}
	const [meminfo, psi] = await Promise.all([
		sources.read("/proc/meminfo"),
		sources.read("/proc/pressure/memory"),
	]);
	const level = psiLevel(psi);
	return {
		...parseMeminfo(meminfo ?? ""),
		pressure: level.pressure,
		pressureSource: level.source,
	};
}
