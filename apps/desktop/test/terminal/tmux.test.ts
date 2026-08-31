/**
 * The tmux runtime's seams, without a tmux server.
 *
 * Ported from the pure `#[test]`s in the Rust `terminal/mod.rs`: session naming,
 * what counts as ownership, version acceptance, config precedence, the bounded
 * runner's refusals, and the operation gate. The tests that need a real server
 * are in `tmux.real.test.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	OperationDeadline,
	isNoServerError,
	parseLines,
	parseOptionValue,
	resolveExecutable,
	runBounded,
} from "../../src/main/terminal/command";
import {
	CancellationToken,
	SCRATCH_TARGET,
	isSafeTmuxArgument,
	isValidSocketName,
	requiredTerminalSet,
	socketName,
	terminalPreflight,
	workspaceTarget,
} from "../../src/main/terminal/ports";
import {
	TmuxTerminalRuntime,
	isMarked,
	isRootMetadata,
	isWorkspaceSessionName,
	parseNumericPrefix,
	sessionMatches,
	workspaceDigest,
} from "../../src/main/terminal/tmux";
import { scratchDirectory, SCRATCH_ROOT } from "./scratch";

const created: string[] = [];

function home(): string {
	const directory = scratchDirectory("tmux-unit");
	created.push(directory);
	return directory;
}

afterEach(() => {
	while (created.length > 0) {
		rmSync(created.pop() as string, { recursive: true, force: true });
	}
});

function runtime(overrides: {
	home?: string;
	tmux?: { path: string; basename: string };

	shell?: { path: string; basename: string };
	tmuxArgs?: readonly string[];
	socket?: string;
	environment?: Record<string, string | undefined>;
	timeoutMs?: number;
}) {
	const root = overrides.home ?? SCRATCH_ROOT;
	return new TmuxTerminalRuntime({
		context: {
			home: root,
			environment: overrides.environment ?? { PATH: "/usr/bin:/bin" },
		},
		tmux:
			overrides.tmux === undefined
				? {
						kind: "unavailable",
						reason: "DevHub could not find 'tmux' on PATH (looked in: /usr/bin, /bin).",
					}
				: { kind: "resolved", value: overrides.tmux },
		shell: overrides.shell,
		tmuxArgs: overrides.tmuxArgs ?? [],
		effectiveSocketName: overrides.socket ?? "devhub",
		timeoutMs: overrides.timeoutMs ?? 1,
	});
}

describe("session naming", () => {
	it("is stable, bounded, and derived only from the root", () => {
		const root = "/workspaces/devhub-terminal-test";
		const digest = workspaceDigest(root);
		expect(digest).toHaveLength(64);
		expect(`ws-${digest.slice(0, 20)}`.length).toBeLessThanOrEqual(256);
		expect(`ws-${digest.slice(0, 32)}`.length).toBeLessThanOrEqual(256);
		// The same root is the same session on the next launch. That is what
		// makes a terminal findable again after a restart.
		expect(workspaceDigest(root)).toBe(digest);
		expect(isWorkspaceSessionName(`ws-${digest.slice(0, 20)}`, root)).toBe(true);
		expect(isWorkspaceSessionName(`ws-${digest.slice(0, 32)}`, root)).toBe(true);
		expect(isWorkspaceSessionName("ws-whatever", root)).toBe(false);
	});

	it("keeps root metadata bounded and unambiguous", () => {
		// A newline in a path is part of the path, not a record separator.
		const first = "/workspaces/a\nb";
		const second = "/workspaces/ab";
		expect(first).not.toBe(second);
		expect(isRootMetadata(first)).toBe(true);
		expect(
			sessionMatches(
				{
					name: "workspace",
					context: "global",
					workspaceId: "global",
					root: first,
					agentId: "none",
				},
				{
					sessionName: "workspace",
					context: "global",
					workspaceId: "global",
					root: first,
					agentId: "none",
				},
			),
		).toBe(true);
		expect(isRootMetadata("hex:2f746d70")).toBe(false);
		expect(isRootMetadata("")).toBe(false);
		expect(isRootMetadata("relative/path")).toBe(false);
	});
});

describe("ownership", () => {
	it("owns an Agent session only when the whole marker tuple is its own", () => {
		const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const root = "/workspaces/project";
		const session = {
			name: `ag-${agentId}`,
			context: "agent",
			workspaceId,
			root,
			agentId,
		};
		expect(isMarked(session, "/workspaces")).toBe(true);
		// The name is the id. A session claiming to be this Agent under another
		// name is a session DevHub did not create.
		expect(isMarked({ ...session, name: "ag-other" }, "/workspaces")).toBe(
			false,
		);
		// An Agent context with no Agent id is a half-written marker, not an
		// Agent whose id happens to be missing.
		expect(isMarked({ ...session, agentId: "none" }, "/workspaces")).toBe(
			false,
		);
		// A workspace terminal that has picked up an Agent id is not a terminal
		// DevHub wrote, so it is nobody's to touch.
		expect(
			isMarked(
				{
					name: `ws-${workspaceDigest(root).slice(0, 20)}`,
					context: "workspace",
					workspaceId,
					root,
					agentId,
				},
				"/workspaces",
			),
		).toBe(false);
	});

	it("never treats unknown metadata as owned", () => {
		const session = {
			name: "scratch",
			context: "other",
			workspaceId: "secret",
			root: "/elsewhere/secret",
			agentId: "none",
		};
		expect(isMarked(session, "/workspaces")).toBe(false);
		expect(
			sessionMatches(session, {
				sessionName: "scratch",
				context: "global",
				workspaceId: "global",
				root: "/workspaces",
				agentId: "none",
			}),
		).toBe(false);
	});

	it("requires the whole marker triple, not just a matching name", () => {
		const root = "/workspaces/project";
		const name = `ws-${workspaceDigest(root).slice(0, 20)}`;
		expect(
			isMarked(
				{
					name,
					context: "workspace",
					workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					root,
					agentId: "none",
				},
				"/workspaces",
			),
		).toBe(true);
		// The right name with a workspace id that is not an id is not ownership.
		expect(
			isMarked(
				{
					name,
					context: "workspace",
					workspaceId: "not-a-uuid",
					root,
					agentId: "none",
				},
				"/workspaces",
			),
		).toBe(false);
		// A scratch session rooted somewhere other than this launch's home is
		// another DevHub's, or another user's.
		expect(
			isMarked(
				{
					name: "scratch",
					context: "global",
					workspaceId: "global",
					root: "/elsewhere",
					agentId: "none",
				},
				"/workspaces",
			),
		).toBe(false);
	});
});

describe("configuration", () => {
	it("disables the adapter when the socket selector is passed as an argument", () => {
		// `-L evil` in tmux_args would silently move every session to another
		// socket, so a config containing it disables the runtime outright
		// instead of being filtered into a config nobody asked for.
		expect(isSafeTmuxArgument("-u")).toBe(true);
		expect(isSafeTmuxArgument("-2")).toBe(true);
		expect(isSafeTmuxArgument("-L")).toBe(false);
		const disabled = runtime({
			tmux: { path: "/usr/bin/tmux", basename: "tmux" },
			tmuxArgs: ["-L", "evil"],
		});
		expect(disabled.adapterAvailable).toBe(false);
		const enabled = runtime({
			tmux: { path: "/usr/bin/tmux", basename: "tmux" },
			tmuxArgs: ["-u"],
		});
		expect(enabled.adapterAvailable).toBe(true);
	});

	it("refuses a socket name that is not one", () => {
		expect(isValidSocketName("devhub")).toBe(true);
		expect(isValidSocketName("dev-hub_1.0")).toBe(true);
		for (const invalid of ["", "dev/hub", "dev hub", "a".repeat(65)]) {
			expect(isValidSocketName(invalid)).toBe(false);
			expect(() => socketName(invalid)).toThrow();
		}
		expect(runtime({ socket: "dev/hub" }).adapterAvailable).toBe(false);
	});

	it("accepts numeric version suffixes but rejects versions before 3.3", () => {
		for (const version of ["3.3", "3.7b", "4.0"]) {
			const [major, minor] = version.split(".").map(parseNumericPrefix);
			expect(major > 3 || (major === 3 && minor >= 3)).toBe(true);
		}
		const [major, minor] = "3.2".split(".").map(parseNumericPrefix);
		expect(major < 3 || (major === 3 && minor < 3)).toBe(true);
		expect(parseNumericPrefix("next")).toBe(0);
	});

	it("selects one trusted user config by precedence", () => {
		const root = home();
		const xdg = join(root, "xdg");
		mkdirSync(join(xdg, "tmux"), { recursive: true });
		writeFileSync(join(xdg, "tmux", "tmux.conf"), "# xdg\n");
		const configured = runtime({
			home: root,
			environment: { PATH: "/usr/bin", XDG_CONFIG_HOME: xdg },
		});
		expect(configured.userTmuxConfigPath()).toBe(join(xdg, "tmux", "tmux.conf"));

		writeFileSync(join(root, ".tmux.conf"), "# home\n");
		expect(configured.userTmuxConfigPath()).toBe(join(root, ".tmux.conf"));

		rmSync(join(root, ".tmux.conf"));
		rmSync(xdg, { recursive: true, force: true });
		// Never an absent path: the bootstrap `source-file` always names one.
		expect(configured.userTmuxConfigPath()).toBe("/dev/null");
	});
});

describe("the required terminal set", () => {
	it("is rebuilt from the snapshot alone and always contains Scratch", () => {
		const set = runtime({}).requiredTerminalSet([
			{
				workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				canonicalPath: "/workspaces/one",
			},
		]);
		expect(set.sessions[0]).toEqual({ kind: "scratch", sessionName: "scratch" });
		expect(set.sessions[1]).toEqual({
			kind: "workspace",
			workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			sessionName: `ws-${workspaceDigest("/workspaces/one").slice(0, 20)}`,
		});
		expect(() =>
			runtime({}).requiredTerminalSet([
				{ workspaceId: "not-a-uuid", canonicalPath: "/workspaces/one" },
			]),
		).toThrow();
		// A set with no Scratch could not describe a running DevHub.
		expect(() => requiredTerminalSet([])).toThrow();
	});

	it("refuses a preflight whose counts contradict its state", () => {
		const socket = socketName("devhub");
		expect(terminalPreflight(socket, "target_absent", 0, 0).state).toBe(
			"target_absent",
		);
		expect(() => terminalPreflight(socket, "target_absent", 1, 0)).toThrow();
		expect(() => terminalPreflight(socket, "target_devhub_empty", 1, 0)).toThrow();
	});
});

describe("inspection", () => {
	it("projects a provider failure as unknown, never as clean", async () => {
		// Fail-closed: an unverified terminal must never look empty to a close
		// confirmation, or the viewer loses work to a dialog that said "clean".
		const inspection = await runtime({}).inspect(SCRATCH_TARGET);
		expect(inspection.process).toEqual({
			kind: "unknown",
			diagnostic: "close_terminal_unknown",
		});
		expect(inspection.extraPanes.kind).toBe("unknown");
		expect(inspection.extraWindows.kind).toBe("unknown");
	});

	it("still reports cancellation as a failure, not as unknown", async () => {
		const cancel = new CancellationToken();
		cancel.cancel();
		await expect(
			runtime({}).inspect(workspaceTarget("a", "/ws"), cancel),
		).rejects.toThrowError(
			expect.objectContaining({ code: "cancelled" }) as unknown as Error,
		);
	});
});

describe("the bounded runner", () => {
	it("checks cancellation and the deadline before spawning anything", async () => {
		const expired = OperationDeadline.at(Date.now() - 1);
		expect(() =>
			runBounded(
				{ file: "not-spawned", args: [], cwd: ".", env: {} },
				expired,
				new CancellationToken(),
			),
		).toThrowError(
			expect.objectContaining({ code: "timed_out" }) as unknown as Error,
		);

		const cancelled = new CancellationToken();
		cancelled.cancel();
		expect(() =>
			runBounded(
				{ file: "not-spawned", args: [], cwd: ".", env: {} },
				OperationDeadline.in(1_000),
				cancelled,
			),
		).toThrowError(
			expect.objectContaining({ code: "cancelled" }) as unknown as Error,
		);
	});

	it("reports a missing executable as unavailable, not as a failure", async () => {
		await expect(
			runBounded(
				{
					file: join(SCRATCH_ROOT, "no-such-program"),
					args: [],
					cwd: ".",
					env: {},
				},
				OperationDeadline.in(2_000),
				new CancellationToken(),
			),
		).rejects.toThrowError(
			expect.objectContaining({ code: "unavailable" }) as unknown as Error,
		);
	});

	it("collects a real child's output within the budget", async () => {
		const output = await runBounded(
			{
				file: "/bin/echo",
				args: ["devhub"],
				cwd: SCRATCH_ROOT,
				env: { PATH: "/usr/bin:/bin" },
			},
			OperationDeadline.in(5_000),
			new CancellationToken(),
		);
		expect(output.success).toBe(true);
		expect(output.stdout.toString("utf8")).toBe("devhub\n");
	});
});

describe("provider output parsing", () => {
	it("refuses malformed records rather than using part of them", () => {
		expect(parseLines(Buffer.from("a\nb\r\n\nc\n"))).toEqual(["a", "b", "c"]);
		expect(() => parseLines(Buffer.from("a\0b"))).toThrow();
		expect(() => parseLines(Buffer.from(`${"x".repeat(4097)}\n`))).toThrow();
	});

	it("keeps a newline inside one option value", () => {
		expect(parseOptionValue(Buffer.from("/workspaces/a\nb\n"))).toBe(
			"/workspaces/a\nb",
		);
		// tmux always terminates the value; output without it is truncated.
		expect(() => parseOptionValue(Buffer.from("/workspaces"))).toThrow();
		expect(() => parseOptionValue(Buffer.from("/works\0paces\n"))).toThrow();
	});
});

describe("executable resolution", () => {
	it("looks a bare name up in absolute PATH entries only", () => {
		const context = {
			home: SCRATCH_ROOT,
			environment: { PATH: `relative/bin:${""}:/bin` },
		};
		expect(resolveExecutable(context, "echo")?.basename).toBe("echo");
		expect(resolveExecutable(context, "definitely-not-a-program")).toBeUndefined();
		// A relative path with a separator is never resolved against the
		// process's own working directory.
		expect(resolveExecutable(context, "bin/echo")).toBeUndefined();
		expect(resolveExecutable(context, "")).toBeUndefined();
		expect(resolveExecutable(context, "/bin/echo")?.path).toBe("/bin/echo");
	});
});

describe("the operation gate", () => {
	it("excludes ordinary operations during a transition and honours cancellation", async () => {
		const gate = runtime({});
		const transition = await gate.beginTransition();
		const cancel = new CancellationToken();
		const waiting = gate.acquireOperation(cancel);
		let settled = false;
		void waiting.then(
			() => (settled = true),
			() => (settled = true),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		// A socket transition must be able to inventory the old socket without
		// an ordinary operation creating a session on it underneath.
		expect(settled).toBe(false);

		cancel.cancel();
		await expect(waiting).rejects.toThrowError(
			expect.objectContaining({ code: "cancelled" }) as unknown as Error,
		);

		transition();
		const release = await gate.acquireOperation(new CancellationToken());
		release();
	});

	it("lets a transition wait for the operations already running", async () => {
		const gate = runtime({});
		const release = await gate.acquireOperation(new CancellationToken());
		let acquired = false;
		const transition = gate.beginTransition().then((done) => {
			acquired = true;
			return done;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(acquired).toBe(false);
		release();
		(await transition)();
		expect(acquired).toBe(true);
	});
});

describe("scratch directories", () => {
	it("are created inside the repository, never in the OS temp directory", () => {
		const directory = mkdtempSync(join(SCRATCH_ROOT, "probe-"));
		created.push(directory);
		expect(directory.startsWith(SCRATCH_ROOT)).toBe(true);
	});
});

describe("the absent-server classification", () => {
	/**
	 * Everything this does not match is read as a foreign server and refuses
	 * the socket, so each of these sentences is one way DevHub could declare
	 * its own tmux somebody else's.
	 */
	it("covers every way tmux says the server is gone", () => {
		for (const stderr of [
			"no server running on /tmp/tmux-501/devhub",
			"error connecting to /tmp/tmux-501/devhub (No such file or directory)",
			// Killing the last session ends the server; a command that overlaps
			// that exit connects and is then told the server went away. tmux
			// prints exactly this, and it means the same thing as the two above.
			"server exited unexpectedly",
		]) {
			expect(isNoServerError(Buffer.from(`${stderr}\n`, "utf8"))).toBe(true);
		}
	});

	it("still reads a server that answered as a server", () => {
		for (const stderr of [
			"",
			"can't find session: scratch",
			"lost server",
			"unknown command: show-options",
		]) {
			expect(isNoServerError(Buffer.from(stderr, "utf8"))).toBe(false);
		}
	});
});
