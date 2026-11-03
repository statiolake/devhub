/**
 * One `ps` snapshot of every process on this machine, as rows.
 *
 * The Task Manager reads the whole table once per refresh and nothing else
 * per process: one fork, whatever DevHub is running. `comm` is the
 * executable and `args` the command line, and both may hold spaces — an app
 * bundle's helper, a file under `Application Support` — so the two cannot be
 * told apart by splitting on whitespace. What tells them apart is that a
 * command line almost always begins with the executable it runs: the split is
 * the first one at which the rest starts with what came before it
 * (`splitCommand`).
 */

/** The arguments `ps` is run with. `-A` is every process, on macOS and Linux. */
export const PS_ARGUMENTS: readonly string[] = [
	"-A",
	"-o",
	"pid=,ppid=,rss=,pcpu=,comm=,args=",
];

export interface ProcessRow {
	readonly pid: number;
	readonly ppid: number;
	/** Resident set size, in KiB, as `ps` reports it. */
	readonly rssKb: number;
	readonly cpuPercent: number;
	/** The executable, as `ps` names it: a path on macOS, a name on Linux. */
	readonly comm: string;
	/** The whole command line. */
	readonly args: string;
}

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(.*)$/u;

/** Every row `ps` printed; a line that is not one is skipped. */
export function parseProcessTable(stdout: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of stdout.split("\n")) {
		const match = ROW.exec(line);
		if (!match) continue;
		const [, pid, ppid, rss, cpu, rest] = match;
		const { comm, args } = splitCommand(rest!.trimEnd());
		rows.push({
			pid: Number(pid),
			ppid: Number(ppid),
			rssKb: Number(rss),
			// Some locales print a decimal comma.
			cpuPercent: Number(cpu!.replace(",", ".")) || 0,
			comm,
			args,
		});
	}
	return rows;
}

/**
 * `comm` and `args`, from the two printed side by side.
 *
 * The first split whose right side begins with its left side (`/bin/zsh
 * /bin/zsh -l`), else the one whose right side's first word ends with it
 * (Linux's `node` before `/usr/bin/node x.js`), else the first space.
 */
export function splitCommand(text: string): {
	comm: string;
	args: string;
} {
	const spaces: number[] = [];
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === " ") spaces.push(index);
	}
	for (const at of spaces) {
		const comm = text.slice(0, at);
		const args = text.slice(at + 1).trimStart();
		if (args === comm || args.startsWith(`${comm} `)) return { comm, args };
	}
	for (const at of spaces) {
		const comm = text.slice(0, at);
		const args = text.slice(at + 1).trimStart();
		const first = args.split(" ")[0] ?? "";
		if (basename(first).replace(/^-/u, "").startsWith(basename(comm))) {
			return { comm, args };
		}
	}
	const at = spaces[0];
	return at === undefined
		? { comm: text, args: text }
		: { comm: text.slice(0, at), args: text.slice(at + 1).trimStart() };
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Interpreters whose script is the better name for what they run. */
const INTERPRETERS = /^(node|nodejs|bun|deno|python[\d.]*|ruby|perl|java)$/u;

/**
 * What a process is called in the Task Manager: its executable's name, or
 * for an interpreter (or an Electron helper run as Node) the script it runs —
 * `tsserver.js`, not `node`.
 */
export function processName(row: Pick<ProcessRow, "comm" | "args">): string {
	const executable = basename(row.comm).replace(/^-/u, "") || row.comm;
	const runsScript =
		INTERPRETERS.test(executable) || /Helper \(Plugin\)$/u.test(executable);
	if (!runsScript) return executable;
	const script = /([^/\s]+\.(?:[cm]?js|py|rb|jar))(?=\s|$)/u.exec(row.args);
	if (script) return script[1]!;
	const rest = row.args.startsWith(row.comm)
		? row.args.slice(row.comm.length)
		: row.args.slice(row.args.indexOf(" ") + 1 || row.args.length);
	const word = rest
		.trim()
		.split(/\s+/u)
		.find((one) => one.length > 0 && !one.startsWith("-"));
	return word === undefined ? executable : basename(word);
}
