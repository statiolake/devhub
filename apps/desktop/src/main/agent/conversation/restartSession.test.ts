/**
 * Restart session inside a GUI Agent, end to end on this machine: the real
 * host, the fake agent playing a Claude stopped in the middle of a turn and
 * started again with `--resume` on the same session
 * (`claude-restart.*.ndjson`), the real Claude adapter and conversation — and
 * a second DevHub attaching to what the first left.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Transcript } from "../../../model/conversation.js";
import { LocalRuntime } from "../../runtime/local.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { resumeOff } from "./limitResumeTestKit.js";
import { AgentConversation, hostOn } from "./conversation.js";
import {
	agentStateDirectory,
	guiAgentCli,
	hostSessionCommand,
} from "./hostCommand.js";
import { HostLink } from "./hostLink.js";
import { RESTARTED } from "./protocolAdapter.js";

/** The gitignored scratch root; never the OS temp directory. */
const SCRATCH_ROOT = fileURLToPath(
	new URL("../../../../../../.spike/", import.meta.url),
);
const FAKE_AGENT = fileURLToPath(
	new URL(
		"../../../../test/fixtures/agent-conversation/fake-agent.sh",
		import.meta.url,
	),
);
const FIXTURES = fileURLToPath(
	new URL("../../../../test/fixtures/agent-conversation/", import.meta.url),
);
const SESSION = "00000000-0000-4000-8000-0000000000e5";

const scratch: string[] = [];
const hosts: ChildProcess[] = [];

afterEach(() => {
	for (const host of hosts.splice(0)) {
		if (host.exitCode === null && host.signalCode === null) {
			process.kill(-(host.pid as number), "SIGKILL");
		}
	}
	for (const directory of scratch.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/** The conversation as a reader follows it: words, calls and DevHub's notices. */
function lines(transcript: Transcript): string[] {
	return transcript.entries.flatMap((entry) => {
		switch (entry.kind) {
			case "user":
				return [`> ${entry.text}`];
			case "assistant":
				return entry.blocks.flatMap((block) =>
					block.kind === "text" ? [`< ${block.markdown}`] : [],
				);
			case "tool":
				return [`${entry.tool} ${entry.status}`];
			case "notice":
				return [`-- ${entry.text}`];
			default:
				return [];
		}
	});
}

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

const idle = (transcript: Transcript) =>
	transcript.state.phase === "ready" && transcript.state.turn === "none";

describe("Restart session through a real host", () => {
	it("stops the fake Claude mid-turn, starts it again on the same session under a quiet divider, and a new DevHub replays to the same", async () => {
		mkdirSync(SCRATCH_ROOT, { recursive: true });
		const home = mkdtempSync(join(SCRATCH_ROOT, "devhub-restart-"));
		scratch.push(home);
		const directory = agentStateDirectory(
			home,
			"0123456789ab",
			"00000000-0000-4000-8000-0000000000e4",
		);
		mkdirSync(directory, { recursive: true });
		const profile = {
			kind: "claude",
			command: "/bin/sh",
			args: [FAKE_AGENT],
			env: new Map<string, string>(),
		} as const;
		const command = hostSessionCommand(directory, guiAgentCli(profile));
		const hosted = (link: HostLink) =>
			hostOn(link, (session) => guiAgentCli(profile, session));
		const host = spawn(command.file, [...command.args], {
			stdio: "ignore",
			detached: true,
			env: {
				...process.env,
				FAKE_AGENT_SCRIPT: join(FIXTURES, "claude-restart.first.ndjson"),
				// Started again on any other session, the fake exits instead.
				FAKE_AGENT_RESUME_SCRIPT: join(
					FIXTURES,
					"claude-restart.restarted.ndjson",
				),
				FAKE_AGENT_RESUME_SESSION: SESSION,
			},
		});
		hosts.push(host);

		const conversation = new AgentConversation(
			hosted(new HostLink(new LocalRuntime(), directory)),
			new ClaudeAdapter("boot-a"),
			() => undefined,
			resumeOff(),
		);
		conversation.start();
		await until(conversation, idle);
		const say = (text: string) =>
			conversation.command({
				kind: "send",
				images: [],
				text,
				origin: "person",
			});
		await say("Say one");
		await until(
			conversation,
			(transcript) => idle(transcript) && lines(transcript).includes("< One."),
		);
		await say("Keep going");
		await until(conversation, (transcript) =>
			lines(transcript).includes("Bash running"),
		);

		await conversation.restart();
		const restarted = conversation.reading().transcript;
		expect(restarted.session.sessionId).toBe(SESSION);
		expect(restarted.state).toEqual({ phase: "ready", turn: "none" });
		expect(lines(restarted)).toEqual([
			"> Say one",
			"< One.",
			"> Keep going",
			"Bash interrupted",
			`-- ${RESTARTED}`,
		]);

		await say("Go on");
		await until(
			conversation,
			(transcript) =>
				idle(transcript) && lines(transcript).at(-1) === "< Going on.",
		);
		const live = conversation.reading().transcript;
		expect(live.session.sessionId).toBe(SESSION);
		expect(lines(live).slice(-3)).toEqual([
			`-- ${RESTARTED}`,
			"> Go on",
			"< Going on.",
		]);
		await conversation.stop();

		const link = new HostLink(new LocalRuntime(), directory);
		const written = (await link.sentLog()).length;
		const again = new AgentConversation(
			hosted(link),
			new ClaudeAdapter("boot-b"),
			() => undefined,
			resumeOff(),
		);
		again.start();
		await until(
			again,
			(transcript) => transcript.entries.length === live.entries.length,
		);
		expect(again.reading().transcript).toEqual(live);
		expect(await link.sentLog()).toHaveLength(written);
		await again.stop();
	}, 30_000);
});
