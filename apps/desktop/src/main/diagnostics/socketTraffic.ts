/**
 * Whether a workbench's processes are talking over the network: one of the
 * signals that keep a hidden workbench from being frozen
 * (`workbenchPlan.ts`, `network`), since freezing a process whose
 * connections are busy only to thaw it for the next one is churn.
 *
 * - **macOS**: `nettop -P -L 1 -x -n -J bytes_in,bytes_out` prints, once,
 *   each process's bytes in and out over its sockets (loopback included) as
 *   CSV, a process named `<name>.<pid>`. Traffic is a total that moved
 *   between two readings (`trafficSince`).
 * - **Linux** (tests, CI): `ss -Htinp` prints each established TCP socket with
 *   its owners and, on the line after, `lastsnd:`/`lastrcv:` — milliseconds
 *   since it last sent or received — so one reading says how long ago.
 *
 * Pure parsing, tested on fixtures.
 */

export const NETTOP_ARGUMENTS: readonly string[] = [
	"-P",
	"-L",
	"1",
	"-x",
	"-n",
	"-J",
	"bytes_in,bytes_out",
];

export const SS_TRAFFIC_ARGUMENTS: readonly string[] = ["-Htinp"];

/** Bytes in plus out per pid, as nettop counts them. */
export function parseNettop(stdout: string): Map<number, number> {
	const totals = new Map<number, number>();
	let inAt = -1;
	let outAt = -1;
	// The process column is the one the header leaves unnamed (after `time`).
	let ownerAt = -1;
	for (const line of stdout.split("\n")) {
		const fields = line.split(",");
		if (fields.includes("bytes_in") && fields.includes("bytes_out")) {
			inAt = fields.indexOf("bytes_in");
			outAt = fields.indexOf("bytes_out");
			ownerAt = fields.indexOf("");
			continue;
		}
		if (inAt < 0 || ownerAt < 0) continue;
		const owner = fields[ownerAt] ?? "";
		if (!/^.+\.\d+$/u.test(owner)) continue;
		const pid = Number(owner.slice(owner.lastIndexOf(".") + 1));
		const bytes = Number(fields[inAt]) + Number(fields[outAt]);
		if (!Number.isFinite(bytes)) continue;
		totals.set(pid, (totals.get(pid) ?? 0) + bytes);
	}
	return totals;
}

/** The pids whose byte totals moved between two nettop readings. */
export function trafficSince(
	before: ReadonlyMap<number, number>,
	after: ReadonlyMap<number, number>,
): Set<number> {
	const moved = new Set<number>();
	for (const [pid, bytes] of after) {
		const was = before.get(pid);
		if (was !== undefined && was !== bytes) moved.add(pid);
	}
	return moved;
}

/** Per pid, the fewest milliseconds since one of its sockets sent or received. */
export function parseSsTraffic(stdout: string): Map<number, number> {
	const quiet = new Map<number, number>();
	let owners: number[] = [];
	for (const line of stdout.split("\n")) {
		if (/^\S/u.test(line)) {
			owners = line.startsWith("ESTAB")
				? [...line.matchAll(/pid=(\d+)/gu)].map((match) => Number(match[1]))
				: [];
			continue;
		}
		if (owners.length === 0) continue;
		const ages = [...line.matchAll(/\blast(?:snd|rcv):(\d+)/gu)].map((match) =>
			Number(match[1]),
		);
		if (ages.length === 0) continue;
		const age = Math.min(...ages);
		for (const pid of owners) {
			quiet.set(pid, Math.min(quiet.get(pid) ?? Infinity, age));
		}
		owners = [];
	}
	return quiet;
}
