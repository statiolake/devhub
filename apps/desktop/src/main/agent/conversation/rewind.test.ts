/**
 * Rewinding to before an earlier message, end to end on this machine: the
 * real host, the fake agent playing a Claude that is started again at the cut
 * (`claude-rewind.*.ndjson`), the real Claude adapter and conversation — and
 * a second DevHub attaching to what the first left.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { rewindTargets, type Transcript } from "../../../model/conversation.js";
import { LocalRuntime } from "../../runtime/local.js";
import { ClaudeAdapter } from "./claude/adapter.js";
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

const scratch: string[] = [];
const hosts: ChildProcess[] = [];

function stateDirectory(): string {
	mkdirSync(SCRATCH_ROOT, { recursive: true });
	const home = mkdtempSync(join(SCRATCH_ROOT, "devhub-edit-"));
	scratch.push(home);
	const directory = agentStateDirectory(
		home,
		"0123456789ab",
		"00000000-0000-4000-8000-0000000000e2",
	);
	mkdirSync(directory, { recursive: true });
	return directory;
}

afterEach(() => {
	for (const host of hosts.splice(0)) {
		if (host.exitCode === null && host.signalCode === null) {
			// The whole group: the host and the CLI beside it.
			process.kill(-(host.pid as number), "SIGKILL");
		}
	}
	for (const directory of scratch.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("rewinding through a real host", () => {
	const FIXTURES = fileURLToPath(
		new URL("../../../../test/fixtures/agent-conversation/", import.meta.url),
	);

	it("starts the fake Claude again at the cut before an earlier message, drops every turn from it on, and a new DevHub replays to the same", async () => {
		const directory = stateDirectory();
		// A resumed launch, as Continue in GUI makes: its record already picks
		// a session, which the rewind's must replace rather than follow.
		const profile = {
			kind: "claude",
			command: "/bin/sh",
			args: [FAKE_AGENT, "--resume", "the launch's session"],
			env: new Map<string, string>(),
		} as const;
		const command = hostSessionCommand(directory, guiAgentCli(profile));
		const host = spawn(command.file, [...command.args], {
			stdio: "ignore",
			detached: true,
			env: {
				...process.env,
				FAKE_AGENT_SCRIPT: join(FIXTURES, "claude-rewind.first.ndjson"),
				FAKE_AGENT_REWIND_SCRIPT: join(
					FIXTURES,
					"claude-rewind.rewound.ndjson",
				),
			},
		});
		hosts.push(host);

		const texts = (conversation: AgentConversation) =>
			conversation
				.reading()
				.transcript.entries.flatMap((entry) =>
					entry.kind === "user"
						? [`> ${entry.text}`]
						: entry.kind === "assistant"
							? entry.blocks.map((block) =>
									block.kind === "text" ? `< ${block.markdown}` : "",
								)
							: [],
				);
		const until = async (
			conversation: AgentConversation,
			done: (transcript: Transcript) => boolean,
		) => {
			for (let tries = 0; tries < 200; tries += 1) {
				if (done(conversation.reading().transcript)) return;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			throw new Error(
				`the conversation did not get there: ${JSON.stringify(conversation.reading())}`,
			);
		};
		const idle = (transcript: Transcript) =>
			transcript.state.phase === "ready" && transcript.state.turn === "none";

		const hosted = (link: HostLink) =>
			hostOn(link, (session) => guiAgentCli(profile, session));
		const conversation = new AgentConversation(
			hosted(new HostLink(new LocalRuntime(), directory)),
			new ClaudeAdapter("boot-a"),
			() => undefined,
		);
		conversation.start();
		await until(conversation, idle);
		const turnsEnded = (count: number) => (transcript: Transcript) =>
			idle(transcript) &&
			transcript.entries.filter((entry) => entry.kind === "turn-end").length ===
				count;
		for (const [index, text] of ["Say one", "Say two", "Say three"].entries()) {
			await conversation.submit(text);
			await until(conversation, turnsEnded(index + 1));
		}
		const { entries } = conversation.reading().transcript;
		const targets = [...rewindTargets(conversation.reading().transcript)];
		expect(
			targets.map((id) => {
				const target = entries.find((entry) => entry.id === id);
				return target?.kind === "user" ? target.text : undefined;
			}),
		).toEqual(["Say one", "Say two", "Say three"]);

		expect(await conversation.rewind(targets[1]!)).toBe("rewound");
		expect(texts(conversation)).toEqual(["> Say one", "< One."]);
		await until(conversation, idle);
		await conversation.submit("Say four");
		await until(conversation, turnsEnded(2));
		expect(texts(conversation)).toEqual([
			"> Say one",
			"< One.",
			"> Say four",
			"< Four.",
		]);
		const live = conversation.reading().transcript;
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
