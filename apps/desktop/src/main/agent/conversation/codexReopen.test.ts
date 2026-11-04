/**
 * A Codex thread closed in one GUI Agent and reopened in another, end to end
 * on this machine: the real host, the real Codex adapter and conversation, and
 * a fake app-server that keeps Codex's writer lock (one live process per
 * thread, held until that process exits — `fake-codex-app-server.sh`).
 *
 * The report this pins: "reopening a closed Codex GUI Agent says the thread
 * already has an active writer, and `codex resume` plus `exit` in a terminal
 * does not fix it". A GUI Agent that had gone on with another thread
 * (`/resume`) did so on the app-server already running, which kept the first
 * thread open, and its lock, for as long as the Agent ran; the terminal's
 * `codex` only ever showed that thread read-only, so its exit freed nothing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Transcript } from "../../../model/conversation.js";
import { LocalRuntime } from "../../runtime/local.js";
import { CodexAdapter } from "./codex/adapter.js";
import { AgentConversation, hostOn } from "./conversation.js";
import {
	agentStateDirectory,
	guiAgentCli,
	hostSessionCommand,
} from "./hostCommand.js";
import { HostLink } from "./hostLink.js";
import { resumeOff } from "./limitResumeTestKit.js";

/** The gitignored scratch root; never the OS temp directory. */
const SCRATCH_ROOT = fileURLToPath(
	new URL("../../../../../../.spike/", import.meta.url),
);
const FAKE_APP_SERVER = fileURLToPath(
	new URL(
		"../../../../test/fixtures/agent-conversation/fake-codex-app-server.sh",
		import.meta.url,
	),
);
const HANDSHAKE = fileURLToPath(
	new URL("./codex/fixtures/handshake.handwritten.ndjson", import.meta.url),
);
const FIRST = "00000000-0000-7000-8000-0000000000c1";
const SECOND = "00000000-0000-7000-8000-0000000000c2";
const CWD = "/home/testuser/project";

const scratch: string[] = [];
const hosts: ChildProcess[] = [];
const conversations: AgentConversation[] = [];

afterEach(async () => {
	for (const conversation of conversations.splice(0)) await conversation.stop();
	for (const host of hosts.splice(0)) {
		if (host.exitCode === null && host.signalCode === null) {
			process.kill(-(host.pid as number), "SIGKILL");
		}
	}
	for (const directory of scratch.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

async function until(
	conversation: AgentConversation,
	done: (transcript: Transcript) => boolean,
): Promise<void> {
	for (let tries = 0; tries < 200; tries += 1) {
		if (done(conversation.reading().transcript)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(
		`the conversation did not get there: ${JSON.stringify(conversation.reading())}`,
	);
}

const settled = (transcript: Transcript) =>
	transcript.state.phase === "broken" ||
	(transcript.state.phase === "ready" && transcript.state.turn === "none");

const profile = {
	kind: "codex",
	command: "/bin/sh",
	args: [FAKE_APP_SERVER],
	env: new Map<string, string>(),
} as const;

/** One GUI Agent on `thread`: its host started as tmux would, and DevHub following it. */
function agent(
	home: string,
	locks: string,
	id: string,
	thread: string,
): { readonly conversation: AgentConversation; readonly host: ChildProcess } {
	const directory = agentStateDirectory(home, "0123456789ab", id);
	mkdirSync(directory, { recursive: true });
	const command = hostSessionCommand(directory, guiAgentCli(profile));
	const host = spawn(command.file, [...command.args], {
		stdio: "ignore",
		detached: true,
		env: {
			...process.env,
			FAKE_CODEX_LOCKS: locks,
			FAKE_CODEX_HANDSHAKE: HANDSHAKE,
		},
	});
	hosts.push(host);
	const conversation = new AgentConversation(
		hostOn(new HostLink(new LocalRuntime(), directory), (session) =>
			guiAgentCli(profile, session),
		),
		new CodexAdapter({
			clientVersion: "0.1.0",
			cwd: CWD,
			resumeThreadId: thread,
		}),
		() => undefined,
		resumeOff(),
	);
	conversations.push(conversation);
	conversation.start();
	return { conversation, host };
}

/** DevHub's Stop: tmux kills the session, which hangs up on the host and the CLI it runs. */
async function stop(
	conversation: AgentConversation,
	host: ChildProcess,
): Promise<void> {
	const gone = new Promise((resolve) => host.once("exit", resolve));
	process.kill(-(host.pid as number), "SIGHUP");
	await gone;
	await conversation.stop();
}

describe("a Codex thread closed in one GUI Agent and reopened in another", () => {
	it("is free once the Agent has gone on with another thread (/resume), and once the Agent is stopped", async () => {
		mkdirSync(SCRATCH_ROOT, { recursive: true });
		const home = mkdtempSync(join(SCRATCH_ROOT, "devhub-codex-reopen-"));
		scratch.push(home);
		const locks = join(home, "thread-writer-locks");

		// Agent A opens the first thread, then goes on with the second.
		const a = agent(home, locks, "00000000-0000-4000-8000-0000000000f1", FIRST);
		await until(a.conversation, settled);
		expect(a.conversation.reading().transcript.state).toEqual({
			phase: "ready",
			turn: "none",
		});
		await a.conversation.resumeSession(SECOND, []);
		const resumed = a.conversation.reading().transcript;
		expect(resumed.session.sessionId).toBe(SECOND);
		expect(resumed.state).toEqual({ phase: "ready", turn: "none" });

		// The first thread, reopened in Agent B while A runs on: A let go of it.
		const b = agent(home, locks, "00000000-0000-4000-8000-0000000000f2", FIRST);
		await until(b.conversation, settled);
		expect(b.conversation.reading().transcript.state).toEqual({
			phase: "ready",
			turn: "none",
		});
		expect(b.conversation.reading().transcript.session.sessionId).toBe(FIRST);

		// A thread another Agent has open is refused, saying what to do.
		const c = agent(
			home,
			locks,
			"00000000-0000-4000-8000-0000000000f3",
			SECOND,
		);
		await until(c.conversation, settled);
		expect(c.conversation.reading().transcript.state).toMatchObject({
			phase: "broken",
			failure: {
				code: "refused",
				detail: expect.stringMatching(
					/already has an active writer \(-32600\)\. Another Codex process has this thread open/,
				) as string,
			},
		});

		// Closing A frees the second thread, and Try again (a restart) opens it.
		await stop(a.conversation, a.host);
		await c.conversation.restart();
		const reopened = c.conversation.reading().transcript;
		expect(reopened.state).toEqual({ phase: "ready", turn: "none" });
		expect(reopened.session.sessionId).toBe(SECOND);
	}, 30_000);
});
