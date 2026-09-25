/**
 * `/resume` inside a GUI Agent, end to end on this machine: the real host, the
 * fake agent playing a Claude started again on another session
 * (`claude-resume.*.ndjson`), the real Claude adapter and conversation — and a
 * second DevHub attaching to what the first left.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Transcript } from "../../../model/conversation.js";
import { LocalRuntime } from "../../runtime/local.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { AgentConversation, hostOn } from "./conversation.js";
import {
	agentStateDirectory,
	guiAgentCli,
	hostSessionCommand,
} from "./hostCommand.js";
import { HostLink } from "./hostLink.js";
import { claudeHistoryLines } from "./resume.js";

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
const OTHER = "00000000-0000-4000-8000-0000000000a1";

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

function texts(transcript: Transcript): string[] {
	return transcript.entries.flatMap((entry) =>
		entry.kind === "user"
			? [`> ${entry.text}`]
			: entry.kind === "assistant"
				? entry.blocks.flatMap((block) =>
						block.kind === "text" ? [`< ${block.markdown}`] : [],
					)
				: [],
	);
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
const turnsEnded = (count: number) => (transcript: Transcript) =>
	idle(transcript) &&
	transcript.entries.filter((entry) => entry.kind === "turn-end").length ===
		count;

describe("/resume through a real host", () => {
	it("starts the fake Claude again on the other session, draws its past in place of this one's, and a new DevHub replays to the same", async () => {
		mkdirSync(SCRATCH_ROOT, { recursive: true });
		const home = mkdtempSync(join(SCRATCH_ROOT, "devhub-resume-"));
		scratch.push(home);
		const directory = agentStateDirectory(
			home,
			"0123456789ab",
			"00000000-0000-4000-8000-0000000000e3",
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
				FAKE_AGENT_SCRIPT: join(FIXTURES, "claude-resume.first.ndjson"),
				FAKE_AGENT_RESUME_SCRIPT: join(
					FIXTURES,
					"claude-resume.resumed.ndjson",
				),
			},
		});
		hosts.push(host);

		const conversation = new AgentConversation(
			hosted(new HostLink(new LocalRuntime(), directory)),
			new ClaudeAdapter("boot-a"),
			() => undefined,
		);
		conversation.start();
		await until(conversation, idle);
		await conversation.command({
			kind: "send",
			text: "Say one",
			origin: "person",
		});
		await until(conversation, turnsEnded(1));

		const history = claudeHistoryLines(
			OTHER,
			readFileSync(
				fileURLToPath(
					new URL(
						"./fixtures/claude-session-file.handwritten.jsonl",
						import.meta.url,
					),
				),
				"utf8",
			),
		);
		await conversation.resumeSession(OTHER, history);
		const resumed = conversation.reading().transcript;
		expect(resumed.session.sessionId).toBe(OTHER);
		expect(texts(resumed)).not.toContain("> Say one");
		expect(texts(resumed)).toContain("> List the files in src");

		await conversation.command({
			kind: "send",
			text: "Go on",
			origin: "person",
		});
		await until(
			conversation,
			(transcript) =>
				idle(transcript) && texts(transcript).at(-1) === "< Going on.",
		);
		const live = conversation.reading().transcript;
		expect(texts(live).slice(-2)).toEqual(["> Go on", "< Going on."]);
		await conversation.stop();

		const link = new HostLink(new LocalRuntime(), directory);
		const written = (await link.sentLog()).length;
		const again = new AgentConversation(
			hosted(link),
			new ClaudeAdapter("boot-b"),
			() => undefined,
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
