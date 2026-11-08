import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	cleanSpawnArgs,
	resolveProgram,
	setExecCleanHelper,
} from "./cleanSpawn.js";
import { runChildHere } from "./childRun.js";

const SOURCE = fileURLToPath(new URL("../native/execClean.c", import.meta.url));
const linux = process.platform === "linux";
const compiler = linux && spawnSync("cc", ["--version"]).status === 0;

describe("cleanSpawnArgs", () => {
	it("leaves a child alone off Linux", () => {
		setExecCleanHelper("/opt/helper");
		expect(
			cleanSpawnArgs(
				"/bin/sh",
				["-c", "true"],
				undefined,
				process.env,
				"darwin",
			),
		).toEqual({ file: "/bin/sh", args: ["-c", "true"] });
	});

	it("goes through the helper with the program found and its argv0 kept", () => {
		setExecCleanHelper("/opt/helper");
		expect(
			cleanSpawnArgs(
				"sh",
				["-c", "true"],
				undefined,
				{ PATH: "/nowhere:/bin" },
				"linux",
			),
		).toEqual({ file: "/opt/helper", args: ["/bin/sh", "sh", "-c", "true"] });
	});

	it("starts a program it cannot find directly, so spawn reports ENOENT as before", () => {
		setExecCleanHelper("/opt/helper");
		expect(
			cleanSpawnArgs(
				"no-such-program-anywhere",
				[],
				undefined,
				{ PATH: "/bin" },
				"linux",
			),
		).toEqual({ file: "no-such-program-anywhere", args: [] });
		expect(
			resolveProgram("/bin/no-such-program", undefined, {}),
		).toBeUndefined();
	});

	it("does nothing without a helper", () => {
		setExecCleanHelper(undefined);
		expect(
			cleanSpawnArgs("/bin/sh", [], undefined, process.env, "linux"),
		).toEqual({
			file: "/bin/sh",
			args: [],
		});
	});
});

/**
 * A descriptor of the parent's that is not close-on-exec, and the child's
 * `/proc/<pid>/fd` read while it runs. The shell opens descriptor 7 without
 * close-on-exec, as Electron's processes have theirs, and then execs: so the
 * program started is in the same position as a child of main or of a utility
 * process.
 */
describe.runIf(compiler)(
	"a child started through devhub-exec-clean (Linux)",
	() => {
		let directory: string;
		let helper: string;

		beforeAll(() => {
			directory = mkdtempSync(join(tmpdir(), "devhub-exec-clean-"));
			helper = join(directory, "devhub-exec-clean");
			const built = spawnSync("cc", [
				"-O2",
				"-Wall",
				"-Wextra",
				"-Werror",
				"-o",
				helper,
				SOURCE,
			]);
			expect(built.status, built.stderr.toString()).toBe(0);
		});

		afterAll(() => {
			setExecCleanHelper(undefined);
			rmSync(directory, { recursive: true, force: true });
		});

		const openFdsOf = async (wrapped: boolean): Promise<string[]> => {
			setExecCleanHelper(wrapped ? helper : undefined);
			const program = cleanSpawnArgs("sleep", ["5"], undefined, process.env);
			const child = spawn(
				"/bin/sh",
				[
					"-c",
					'exec 7</dev/null; exec "$@"',
					"sh",
					program.file,
					...program.args,
				],
				{ stdio: "ignore" },
			);
			try {
				// Until the shell has exec'd `sleep` (through the helper or not).
				const deadline = Date.now() + 5_000;
				for (;;) {
					const comm = readFileSyncSafe(`/proc/${String(child.pid)}/comm`);
					if (comm === "sleep\n") break;
					if (Date.now() > deadline) throw new Error(`still ${comm}`);
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				return readdirSync(`/proc/${String(child.pid)}/fd`).sort();
			} finally {
				child.kill("SIGKILL");
			}
		};

		it("inherits the parent's open descriptor without it", async () => {
			expect(await openFdsOf(false)).toContain("7");
		});

		it("has only its stdio open with it", async () => {
			expect(await openFdsOf(true)).toEqual(["0", "1", "2"]);
		});

		it("is what runChildHere starts, and reports the program's own exit", async () => {
			setExecCleanHelper(helper);
			const run = runChildHere({
				file: "sh",
				args: ["-c", "ls /proc/$$/fd; exit 3"],
				cwd: undefined,
				env: process.env,
				stdin: undefined,
				stdoutBytes: 4096,
				stderrBytes: 4096,
				overflow: "truncate",
				streamOutput: false,
			});
			const outcome = await run.outcome;
			expect(outcome.kind).toBe("closed");
			if (outcome.kind !== "closed") return;
			expect(outcome.code).toBe(3);
			// stdin is /dev/null, stdout and stderr the pipes, and `ls`'s own
			// listing descriptor: nothing of this process's.
			const fds = new TextDecoder().decode(outcome.stdout).trim().split(/\s+/u);
			expect(fds.filter((fd) => Number(fd) > 3)).toEqual([]);
		});
	},
);

function readFileSyncSafe(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}
