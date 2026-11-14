/**
 * Moving a running Bash command to the background inside a GUI Agent, end to
 * end on this machine: the real host, the fake agent playing a Claude whose
 * foreground command waits until it is asked to move
 * (`claude-background.ndjson`, in the shapes Claude Code 2.1.325 declares),
 * the real Claude adapter and conversation.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	entryId,
	workState,
	type ToolEntry,
	type Transcript,
} from "../../../model/conversation.js";
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
const FIXTURE = fileURLToPath(
	new URL(
		"../../../../test/fixtures/agent-conversation/claude-background.ndjson",
		import.meta.url,
	),
);

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

const BUILD = entryId("tool:toolu_b1");

function build(transcript: Transcript): ToolEntry {
	const found = transcript.entries.find((each) => each.id === BUILD);
	if (found?.kind !== "tool") throw new Error("no build call");
	return found;
}

describe("Run in Background through a real host", () => {
	it("asks the fake Claude to move the waiting command, and the turn goes on while it runs", async () => {
		mkdirSync(SCRATCH_ROOT, { recursive: true });
		const home = mkdtempSync(join(SCRATCH_ROOT, "devhub-background-"));
		scratch.push(home);
		const directory = agentStateDirectory(
			home,
			"0123456789ab",
			"00000000-0000-4000-8000-0000000000b8",
		);
		mkdirSync(directory, { recursive: true });
		const profile = {
			kind: "claude",
			command: "/bin/sh",
			args: [FAKE_AGENT],
			env: new Map<string, string>(),
		} as const;
		const command = hostSessionCommand(directory, guiAgentCli(profile));
		const host = spawn(command.file, [...command.args], {
			stdio: "ignore",
			detached: true,
			env: { ...process.env, FAKE_AGENT_SCRIPT: FIXTURE },
		});
		hosts.push(host);

		const conversation = new AgentConversation(
			hostOn(new HostLink(new LocalRuntime(), directory), (session) =>
				guiAgentCli(profile, session),
			),
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

		await say("Build it");
		// The command the turn waits on is offered once the CLI made it a task.
		await until(
			conversation,
			(transcript) => transcript.foregroundTasks.length === 1,
		);
		expect(conversation.reading().transcript.foregroundTasks).toEqual([
			{ id: "b7", call: BUILD },
		]);
		expect(build(conversation.reading().transcript).status).toBe("running");

		// The fake exits if the line DevHub writes is not the fixture's.
		await conversation.command({ kind: "background", call: BUILD });
		await until(conversation, idle);
		const after = conversation.reading().transcript;
		expect(after.foregroundTasks).toEqual([]);
		expect(build(after).status).toBe("succeeded");
		expect(workState(build(after))).toBe("running");
		expect(after.backgroundTasks).toMatchObject([
			{ id: "b7", kind: "shell", title: "Build the app", call: BUILD },
		]);
		const said = after.entries.flatMap((entry) =>
			entry.kind === "assistant"
				? entry.blocks.flatMap((block) =>
						block.kind === "text" ? [block.markdown] : [],
					)
				: [],
		);
		expect(said).toEqual(["The build goes on in the background."]);

		await say("Done yet?");
		await until(
			conversation,
			(transcript) =>
				idle(transcript) && transcript.backgroundTasks.length === 0,
		);
		const done = conversation.reading().transcript;
		expect(workState(build(done))).toBe("succeeded");
		expect(build(done).background).toEqual({
			state: "completed",
			summary: "Build the app",
		});
		await conversation.stop();
	}, 30_000);
});
