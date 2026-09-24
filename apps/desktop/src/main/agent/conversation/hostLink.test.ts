/**
 * The host and its link, run for real against a fake agent.
 *
 * The host here is started as a plain process group rather than a tmux
 * session, because what is under test is the host's files and the link's
 * reading of them; tmux adds nothing to either. (`tmux.real.test.ts` runs the
 * same host as an Agent session, for the part tmux does add: Stop.) A tmux
 * kill is a SIGHUP to the pane's process group, and that is what `hangUp`
 * sends.
 *
 * "main restarted" is a second `HostLink` on the same directory with nothing
 * carried over but an offset — which is all a restarted DevHub has.
 *
 * `describeHostLink` is the suite for any machine: `ssh.test.ts` and
 * `container.test.ts` run it through the fake ssh and the fake docker, whose
 * "machine" is this one, so the host process and its files are the same and
 * only the transport differs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CancellationToken } from "../../terminal/ports.js";
import { LocalRuntime } from "../../runtime/local.js";
import type { Runtime } from "../../runtime/runtime.js";
import { agentStateDirectory, hostSessionCommand } from "./hostCommand.js";
import { HostLink, HostLinkFailure, type JournalLine } from "./hostLink.js";

/** The gitignored scratch root; never the OS temp directory. */
const SCRATCH_ROOT = fileURLToPath(
	new URL("../../../../../../.spike/", import.meta.url),
);
/** The stand-in CLI: JSON lines out, lines in. Never a model. */
export const FAKE_AGENT = fileURLToPath(
	new URL(
		"../../../../test/fixtures/agent-conversation/fake-agent.sh",
		import.meta.url,
	),
);

const scratch: string[] = [];
const hosts: ChildProcess[] = [];

function stateDirectory(): string {
	mkdirSync(SCRATCH_ROOT, { recursive: true });
	const home = mkdtempSync(join(SCRATCH_ROOT, "devhub-host-"));
	scratch.push(home);
	const directory = agentStateDirectory(
		home,
		"00000000-0000-4000-8000-0000000000e1",
	);
	mkdirSync(directory, { recursive: true });
	return directory;
}

/** The host with the fake agent under it, as its own process group. */
function startHost(
	directory: string,
	cli: readonly string[] = ["/bin/sh", FAKE_AGENT],
): ChildProcess {
	const [file = "", ...args] = cli;
	const command = hostSessionCommand(directory, { file, args, env: {} });
	const host = spawn(command.file, [...command.args], {
		stdio: "ignore",
		detached: true,
	});
	hosts.push(host);
	return host;
}

/** What tmux does to a session's pane on `kill-session`. */
function hangUp(host: ChildProcess): void {
	process.kill(-(host.pid as number), "SIGHUP");
}

afterEach(() => {
	for (const host of hosts.splice(0)) {
		if (host.exitCode === null && host.signalCode === null) {
			try {
				process.kill(-(host.pid as number), "SIGKILL");
			} catch {
				// Not a swallow: the group is already gone, which is the state
				// the teardown exists to reach.
			}
		}
	}
	for (const directory of scratch.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/** Read lines until `done` says so, and leave the iterator open. */
async function readUntil(
	lines: AsyncGenerator<JournalLine>,
	done: (seen: readonly JournalLine[]) => boolean,
): Promise<JournalLine[]> {
	const seen: JournalLine[] = [];
	while (!done(seen)) {
		const next = await lines.next();
		if (next.done === true) {
			throw new Error(`the journal ended after ${JSON.stringify(seen)}`);
		}
		seen.push(next.value);
	}
	return seen;
}

/** Every line until the journal ends by itself. */
async function readAll(
	lines: AsyncIterable<JournalLine>,
): Promise<JournalLine[]> {
	const seen: JournalLine[] = [];
	for await (const line of lines) seen.push(line);
	return seen;
}

async function failureOf(work: Promise<unknown>): Promise<HostLinkFailure> {
	const outcome = await work.then(
		() => undefined,
		(failure: unknown) => failure,
	);
	if (!(outcome instanceof HostLinkFailure)) {
		throw new Error(`expected a HostLinkFailure, got ${String(outcome)}`, {
			cause: outcome,
		});
	}
	return outcome;
}

/** Every behaviour of the link, on whichever machine `make` is. */
export function describeHostLink(name: string, make: () => Runtime): void {
	describe(`the Agent host and its link (${name})`, () => {
		it("delivers the agent's lines as they are written, and takes a line to it", async () => {
			const directory = stateDirectory();
			startHost(directory);
			const link = new HostLink(make(), directory);
			const cancel = new CancellationToken();
			const lines = link.lines(0, cancel);

			const [hello] = await readUntil(lines, (seen) => seen.length === 1);
			expect(hello?.line).toBe('{"type":"hello","argc":0}');
			expect(hello?.offset).toBe(
				Buffer.byteLength('{"type":"hello","argc":0}\n'),
			);

			await link.write('{"say":"日本語も一行"}', 0);
			const [echo] = await readUntil(lines, (seen) => seen.length === 1);
			expect(echo?.line).toBe('{"echo":{"say":"日本語も一行"}}');
			expect(echo?.offset).toBe(
				(hello?.offset ?? 0) +
					Buffer.byteLength('{"echo":{"say":"日本語も一行"}}\n'),
			);

			cancel.cancel();
			expect(await lines.next()).toEqual({ done: true, value: undefined });
			expect(await link.sentLog()).toEqual([
				{ afterOffset: 0, line: '{"say":"日本語も一行"}' },
			]);
		}, 20_000);

		it("attaches from an offset after main restarts, with nothing missing and nothing twice", async () => {
			const directory = stateDirectory();
			startHost(directory);
			const first = new HostLink(make(), directory);
			const firstCancel = new CancellationToken();
			const firstLines = first.lines(0, firstCancel);
			await readUntil(firstLines, (seen) => seen.length === 1);
			await first.write('{"fake":"count","n":200}', 0);
			const before = await readUntil(firstLines, (seen) => seen.length === 37);
			// main goes away in the middle of a burst: the stream is killed and
			// nothing but the last offset survives.
			firstCancel.cancel();
			await firstLines.return(undefined);

			const again = new HostLink(make(), directory);
			const cancel = new CancellationToken();
			const after = await readUntil(
				again.lines(before[before.length - 1]?.offset ?? -1, cancel),
				(seen) => seen.length === 200 - 37,
			);
			cancel.cancel();
			expect([...before, ...after].map((entry) => entry.line)).toEqual(
				Array.from(
					{ length: 200 },
					(_, index) => `{"seq":${String(index + 1)}}`,
				),
			);

			// And from the top, which is what a restarted DevHub replays.
			const replayCancel = new CancellationToken();
			const replay = await readUntil(
				again.lines(0, replayCancel),
				(seen) => seen.length === 201,
			);
			replayCancel.cancel();
			expect(replay[0]?.line).toBe('{"type":"hello","argc":0}');
			expect(replay[200]?.line).toBe('{"seq":200}');
		}, 30_000);

		it("ends the journal when the agent exits, and says with what and why", async () => {
			const directory = stateDirectory();
			startHost(directory);
			const link = new HostLink(make(), directory);
			const lines = link.lines(0, new CancellationToken());
			await readUntil(lines, (seen) => seen.length === 1);
			await link.write('{"before":"exit"}', 0);
			await link.write('{"fake":"exit","code":3}', 0);

			const rest = await readAll(lines);
			expect(rest.map((entry) => entry.line)).toEqual([
				'{"echo":{"before":"exit"}}',
			]);
			const ending = await link.ending();
			expect(ending).toMatchObject({ kind: "exited", code: 3 });
			expect(ending.stderrTail).toContain("fake-agent: exiting with 3");
		}, 20_000);

		it("hands on a last line the agent never finished", async () => {
			const directory = stateDirectory();
			startHost(directory);
			const link = new HostLink(make(), directory);
			const lines = link.lines(0, new CancellationToken());
			await readUntil(lines, (seen) => seen.length === 1);
			await link.write('{"fake":"partial"}', 0);

			const rest = await readAll(lines);
			expect(rest.map((entry) => entry.line)).toEqual(['{"cut":']);
			expect(rest[0]?.offset).toBe(
				readFileSync(join(directory, "out")).byteLength,
			);
			expect(await link.ending()).toMatchObject({ kind: "exited", code: 9 });
		}, 20_000);

		it("tells a host that was killed from one that ended, and refuses to write to it", async () => {
			const directory = stateDirectory();
			const host = startHost(directory);
			const link = new HostLink(make(), directory);
			const lines = link.lines(0, new CancellationToken());
			await readUntil(lines, (seen) => seen.length === 1);

			expect((await failureOf(link.ending())).code).toBe("host_running");
			hangUp(host);

			expect(await readAll(lines)).toEqual([]);
			expect(await link.ending()).toMatchObject({ kind: "vanished" });
			expect(existsSync(join(directory, "exit"))).toBe(false);
			const refused = await failureOf(link.write('{"after":"death"}', 0));
			expect(refused.code).toBe("host_gone");
			expect(refused.message).toContain("nothing is reading its input");
		}, 20_000);

		it("holds a write for a host that has not started yet, rather than refusing it", async () => {
			const directory = stateDirectory();
			const link = new HostLink(make(), directory);
			const written = link.write('{"first":"line"}', 0);
			startHost(directory);
			await written;

			const lines = link.lines(0, new CancellationToken());
			const seen = await readUntil(lines, (so) => so.length === 2);
			await lines.return(undefined);
			expect(seen.map((entry) => entry.line)).toEqual([
				'{"type":"hello","argc":0}',
				'{"echo":{"first":"line"}}',
			]);
		}, 20_000);

		it("says a write timed out when the agent is not reading", async () => {
			const directory = stateDirectory();
			startHost(directory, ["/bin/sh", "-c", "sleep 30"]);
			const link = new HostLink(make(), directory, { writeTimeoutMs: 1500 });
			// Far more than any pipe holds, so the write has to wait for a reader.
			const failure = await failureOf(link.write("x".repeat(1024 * 1024), 0));
			expect(failure.code).toBe("write_failed");
			expect(failure.message).toContain("did not take a line");
		}, 20_000);

		it("fails visibly when the journal is truncated under it", async () => {
			const directory = stateDirectory();
			startHost(directory);
			const link = new HostLink(make(), directory);
			const lines = link.lines(0, new CancellationToken());
			await link.write('{"fake":"count","n":5}', 0);
			const seen = await readUntil(lines, (so) => so.length === 6);

			truncateSync(join(directory, "out"), 0);
			const failure = await failureOf(readAll(lines));
			expect(failure.code).toBe("journal_truncated");
			expect(failure.message).toContain("truncated or replaced");
			expect(failure.offset).toBe(seen[5]?.offset);
		}, 20_000);

		it("refuses an offset past the end of the journal", async () => {
			const directory = stateDirectory();
			startHost(directory);
			const link = new HostLink(make(), directory);
			const first = link.lines(0, new CancellationToken());
			const [hello] = await readUntil(first, (seen) => seen.length === 1);
			await first.return(undefined);

			const failure = await failureOf(
				readAll(
					link.lines((hello?.offset ?? 0) + 100, new CancellationToken()),
				),
			);
			expect(failure.code).toBe("journal_truncated");
			expect(failure.message).toContain("fewer than the");
		}, 20_000);

		it("fails visibly when the follower is killed from outside", async () => {
			const directory = stateDirectory();
			startHost(directory);
			const link = new HostLink(make(), directory);
			const lines = link.lines(0, new CancellationToken());
			const [hello] = await readUntil(lines, (seen) => seen.length === 1);

			// Only this case's `tail`: its argv is the one that names this
			// directory's journal after `-f`.
			spawn("pkill", ["-f", `tail -c \\+[0-9]+ -f ${directory}/out`], {
				stdio: "ignore",
			});
			const failure = await failureOf(readAll(lines));
			expect(failure.code).toBe("stream_lost");
			expect(failure.message).toContain("tail stopped following");
			expect(failure.offset).toBe(hello?.offset);
		}, 20_000);

		it("says the host could not start the agent, and why", async () => {
			const directory = stateDirectory();
			// An `in` that is already there is a FIFO the host cannot make.
			mkdirSync(join(directory, "in"));
			startHost(directory);
			const link = new HostLink(make(), directory);

			const failure = await failureOf(
				readAll(link.lines(0, new CancellationToken())),
			);
			expect(failure.code).toBe("host_not_started");
			expect(failure.message).toContain("cannot make the input pipe");
			const ending = await link.ending();
			expect(ending.kind).toBe("host_failed");
			expect(ending.stderrTail).toContain(
				"devhub-agent-host: cannot make the input pipe",
			);
		}, 20_000);

		it("says the agent was not there, in the shell's own words", async () => {
			const directory = stateDirectory();
			startHost(directory, ["devhub-no-such-agent-cli"]);
			const link = new HostLink(make(), directory);

			expect(await readAll(link.lines(0, new CancellationToken()))).toEqual([]);
			const ending = await link.ending();
			expect(ending).toMatchObject({ kind: "exited", code: 127 });
			expect(ending.stderrTail).toContain("devhub-no-such-agent-cli");
		}, 20_000);

		it("fails visibly on a state directory that is not there", async () => {
			const directory = join(stateDirectory(), "gone");
			const link = new HostLink(make(), directory);

			expect(
				(await failureOf(readAll(link.lines(0, new CancellationToken())))).code,
			).toBe("state_missing");
			expect((await failureOf(link.write("{}", 0))).code).toBe("state_missing");
			expect((await failureOf(link.sentLog())).code).toBe("state_missing");
			expect((await failureOf(link.ending())).code).toBe("state_missing");
		}, 20_000);

		it("keeps each written line with the journal offset it followed, and gives both back", async () => {
			const directory = stateDirectory();
			startHost(directory);
			const link = new HostLink(make(), directory);
			const lines = link.lines(0, new CancellationToken());
			const [hello] = await readUntil(lines, (seen) => seen.length === 1);

			await link.write('{"a":"one line"}', 0);
			await link.write('{"b":"with  spaces "}', hello!.offset);
			const echoes = await readUntil(lines, (seen) => seen.length === 2);

			// The agent was given the lines alone.
			expect(echoes.map((each) => each.line)).toEqual([
				'{"echo":{"a":"one line"}}',
				'{"echo":{"b":"with  spaces "}}',
			]);
			expect(await link.sentLog()).toEqual([
				{ afterOffset: 0, line: '{"a":"one line"}' },
				{ afterOffset: hello!.offset, line: '{"b":"with  spaces "}' },
			]);
			await lines.return(undefined);
		}, 20_000);

		it("fails visibly on an input log line with no offset", async () => {
			const directory = stateDirectory();
			writeFileSync(
				join(directory, "in.log"),
				'12 {"fine":1}\n{"no":"offset"}\n',
			);
			const failure = await failureOf(
				new HostLink(make(), directory).sentLog(),
			);
			expect(failure.code).toBe("unreadable");
			expect(failure.message).toContain("line 2 of the input log");
		}, 20_000);

		it("refuses an offset that is not one", () => {
			const link = new HostLink(make(), stateDirectory());
			expect(() => link.write("{}", -1)).toThrow("is not a journal offset");
		});

		it("refuses a line with a newline in it rather than sending two", () => {
			const link = new HostLink(make(), stateDirectory());
			expect(() => link.write("one\ntwo", 0)).toThrow(
				"must not contain a newline",
			);
		});
	});
}

describeHostLink("local", () => new LocalRuntime());
