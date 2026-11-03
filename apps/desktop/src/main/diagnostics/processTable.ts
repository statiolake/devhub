/**
 * One `ps` snapshot of every process on this machine, as rows.
 *
 * The Task Manager reads the table once per refresh and nothing else per
 * process. It is two `ps` runs, joined by pid (`parseProcessTables`): one for
 * the numbers with the executable last, one for the command line. Each text
 * column is then the last of its line, which is the only place `ps` prints
 * one whole — macOS truncates a `comm` that is not last to a few characters
 * (".lo", "De", "Ce") — and no split has to guess where the executable ends
 * and the command line starts. A process that retitles itself (its `args`
 * no longer begin with its executable) is named by its executable all the
 * same.
 *
 * `parseProcessTable` reads the older single run, `comm` and `args` side by
 * side, split by a heuristic (`splitCommand`); fixtures written in it stay
 * readable.
 */

/** The arguments `ps` is run with. `-A` is every process, on macOS and Linux. */
export const PS_ARGUMENTS: readonly string[] = [
	"-A",
	"-o",
	"pid=,ppid=,rss=,pcpu=,comm=,args=",
];

/**
 * The two runs `parseProcessTables` joins: the numbers with the executable
 * last, and the command line. `state` begins with `Z` for a zombie, on macOS
 * and Linux.
 */
export const PS_STAT_ARGUMENTS: readonly string[] = [
	"-A",
	"-o",
	"pid=,ppid=,rss=,pcpu=,state=,comm=",
];
export const PS_ARGS_ARGUMENTS: readonly string[] = ["-A", "-o", "pid=,args="];

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
	/**
	 * It has exited: a zombie waiting for its parent to reap it, or a process
	 * macOS could no longer read the command line of because it is ending,
	 * which `ps` prints as `(name)`.
	 */
	readonly exited?: boolean;
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

const STAT_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\S+)\s(.*)$/u;
const ARGS_ROW = /^\s*(\d+)\s(.*)$/u;

/**
 * Every row of the two runs (`PS_STAT_ARGUMENTS`, `PS_ARGS_ARGUMENTS`),
 * joined by pid. A process the second run did not see — it started or ended
 * in between — has its executable as its command line.
 */
export function parseProcessTables(
	statOutput: string,
	argsOutput: string,
): ProcessRow[] {
	const argsOf = new Map<number, string>();
	for (const line of argsOutput.split("\n")) {
		const match = ARGS_ROW.exec(line);
		if (match) argsOf.set(Number(match[1]), match[2]!.trim());
	}
	const rows: ProcessRow[] = [];
	for (const line of statOutput.split("\n")) {
		const match = STAT_ROW.exec(line);
		if (!match) continue;
		const [, pid, ppid, rss, cpu, state, rest] = match;
		const comm = rest!.trim();
		const args = argsOf.get(Number(pid));
		rows.push({
			pid: Number(pid),
			ppid: Number(ppid),
			rssKb: Number(rss),
			cpuPercent: Number(cpu!.replace(",", ".")) || 0,
			comm,
			args: args === undefined || args === "" ? comm : args,
			...(state!.startsWith("Z") || /^\(.*\)$/u.test(args ?? "")
				? { exited: true }
				: {}),
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

/** Package runners: what they run is the word after them (and `exec`). */
const RUNNERS = new Set(["npx", "npm", "pnpm", "pnpx", "yarn", "bunx", "uvx"]);
const RUNNER_VERBS = new Set(["exec", "dlx", "x", "run"]);

/** A script name that says nothing of what it is: its package says more. */
const GENERIC_SCRIPT =
	/^(index|main|cli|server|extension|run|start|app|bin|entry)\.(?:[cm]?[jt]s|py)$/u;

/** Directories a package keeps its scripts in, which name nothing. */
const GENERIC_DIRECTORY =
	/^(dist|out|lib|build|bin|src|server|client|node|esm|cjs|\.bin)$/u;

/**
 * The package a generic script belongs to: the name after the last
 * `node_modules/` in its path, else the nearest directory that is not a
 * build or source folder.
 */
function packageOf(path: string): string | undefined {
	const modules = path.lastIndexOf("node_modules/");
	if (modules !== -1) {
		const [first, second] = path
			.slice(modules + "node_modules/".length)
			.split("/");
		if (first?.startsWith("@") && second) return `${first}/${second}`;
		if (first && first !== ".bin") return first;
	}
	const segments = path.split("/").slice(1, -1);
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const segment = segments[index]!;
		if (segment !== "" && !GENERIC_DIRECTORY.test(segment)) return segment;
	}
	return undefined;
}

/** The executable's name: `comm`'s basename, or argv[0]'s where Linux cut it. */
function executableName(row: Pick<ProcessRow, "comm" | "args">): string {
	const name = basename(row.comm).replace(/^-/u, "") || row.comm;
	const first = basename(row.args.split(" ")[0] ?? "").replace(/^-/u, "");
	// An executable named for its version (the Claude CLI installs itself as
	// `versions/2.1.0`) is better called what it calls itself.
	if (/^v?\d+(\.\d+)+$/u.test(name) && first !== "") return first;
	if (row.comm.includes("/")) return name;
	// Linux's comm is the first 15 bytes of the name.
	return first.length > name.length && first.startsWith(name) ? first : name;
}

/**
 * What a process is called in the Task Manager: its executable's name — or,
 * for an interpreter or an Electron helper run as Node, what it runs: the
 * script (`tsserver.js`), the package of a script whose own name says
 * nothing (`index.js` under `node_modules/@x/mcp-server` is
 * `@x/mcp-server`), or what a package runner was asked for (`npx -y
 * mcp-server-github`).
 */
export function processName(row: Pick<ProcessRow, "comm" | "args">): string {
	const executable = executableName(row);
	const runsScript =
		INTERPRETERS.test(executable) || /Helper \(Plugin\)$/u.test(executable);
	if (!runsScript) return executable;
	const script = /(\S*?)([^/\s]+\.(?:[cm]?js|py|rb|jar))(?=\s|$)/u.exec(
		row.args,
	);
	if (script) {
		const name = script[2]!;
		if (!GENERIC_SCRIPT.test(name)) return name;
		const path = row.args.slice(0, (script.index ?? 0) + script[0].length);
		return packageOf(path) ?? name;
	}
	const rest = row.args.startsWith(row.comm)
		? row.args.slice(row.comm.length)
		: row.args;
	const words = rest
		.trim()
		.split(/\s+/u)
		.filter((one) => one.length > 0 && !one.startsWith("-"));
	let at = 0;
	// argv[0] when the command line did not start with the path: `node`.
	const first = basename(words[0] ?? "");
	if (first === executable || INTERPRETERS.test(first)) at += 1;
	if (RUNNERS.has(basename(words[at] ?? ""))) {
		at += 1;
		if (RUNNER_VERBS.has(words[at] ?? "")) at += 1;
	}
	const word = words[at];
	if (word === undefined) return executable;
	return word.startsWith("@") ? word : basename(word);
}

/**
 * A process's memory, two ways: its **footprint**, everything it costs
 * wherever it lives (in RAM, compressed, swapped out), and what of it is
 * **in RAM** now.
 */
export interface ProcessMemory {
	readonly footprintBytes: number;
	readonly residentBytes: number;
}

/**
 * `<pid> <footprint> <resident>` lines, as `devhub-footprint` prints them.
 * In RAM is the resident set, but never more than the footprint: the
 * resident set also counts the frameworks a process shares with others,
 * which its footprint does not.
 */
export function parseFootprints(stdout: string): Map<number, ProcessMemory> {
	const memory = new Map<number, ProcessMemory>();
	for (const line of stdout.split("\n")) {
		const match = /^(\d+) (\d+) (\d+)$/u.exec(line.trim());
		if (!match) continue;
		const footprintBytes = Number(match[2]);
		memory.set(Number(match[1]), {
			footprintBytes,
			residentBytes: Math.min(footprintBytes, Number(match[3])),
		});
	}
	return memory;
}

/**
 * Linux's `/proc/<pid>/status`: in RAM is `VmRSS`, the footprint `VmRSS +
 * VmSwap` (Linux keeps no per-process figure for what zswap holds). A kernel
 * thread, which has neither line, is nothing.
 */
export function parseProcStatus(text: string): ProcessMemory | undefined {
	const kib = (name: string): number | undefined => {
		const match = new RegExp(`^${name}:\\s+(\\d+) kB`, "mu").exec(text);
		return match ? Number(match[1]) * 1024 : undefined;
	};
	const resident = kib("VmRSS");
	if (resident === undefined) return undefined;
	return {
		footprintBytes: resident + (kib("VmSwap") ?? 0),
		residentBytes: resident,
	};
}
