import { describe, expect, it, vi } from "vitest";
import type { AgentId, AgentStatus, WorkspaceId } from "../../model/domain.js";
import type { SendToAgentRowWire } from "../../ipc/contract.js";
import {
	NEW_AGENT_PROMPT_TIMEOUT_MS,
	SendRefused,
	SendToAgent,
	sendRows,
	type SendTargetAgent,
	type SendTargetProfile,
	type SendTargetWorkspace,
	type SendToAgentPorts,
} from "./sendToAgent.js";

const WORKBENCH = { workbench: "app" };
const ROOT = "/Users/me/src/app";
const GUI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" as AgentId;
const TUI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2" as AgentId;
const CREATED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3" as AgentId;
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1" as WorkspaceId;

function agent(
	id: AgentId,
	overrides: Partial<SendTargetAgent> = {},
): SendTargetAgent {
	return {
		id,
		displayName: id === GUI ? "Claude" : "Codex",
		profileDisplayName: id === GUI ? "Claude" : "Codex",
		profileKind: id === GUI ? "claude" : "codex",
		presentation: id === GUI ? "gui" : "tui",
		status: "idle",
		ordinal: id === GUI ? 1 : 2,
		...overrides,
	};
}

const PROFILES: SendTargetProfile[] = [
	{ id: "claude", displayName: "Claude", presentation: "gui" },
	{ id: "claude-tui", displayName: "Claude (terminal)", presentation: "tui" },
];

const PAYLOAD = {
	version: 1,
	uri: `file://${ROOT}/src/a.ts`,
	path: `${ROOT}/src/a.ts`,
	languageId: "typescript",
	ranges: [{ startLine: 3, endLine: 4, text: "a();\nb();" }],
};

/** The ports, with every Agent the model has and the row the person picks. */
function harness(options: {
	agents?: SendTargetAgent[];
	pick?: (rows: readonly SendToAgentRowWire[]) => number;
	created?: SendTargetAgent;
	/** The created Agent's status, reading by reading. */
	statuses?: AgentStatus[];
}) {
	const agents = new Map(
		(options.agents ?? [agent(GUI), agent(TUI)]).map((each) => [each.id, each]),
	);
	const workspace = (): SendTargetWorkspace => ({
		id: WORKSPACE,
		root: ROOT,
		agents: [...agents.values()],
		lastAgentId: undefined,
		canCreateAgent: true,
	});
	const statuses = [...(options.statuses ?? [])];
	const shown: AgentId[] = [];
	const created: string[] = [];
	const drafts: [AgentId, string][] = [];
	const pasted: [AgentId, string][] = [];
	const offered: (readonly SendToAgentRowWire[])[] = [];
	const ports: SendToAgentPorts = {
		workspaceOf: (sender) => (sender === WORKBENCH ? workspace() : undefined),
		profiles: () => PROFILES,
		choose: (rows) => {
			offered.push(rows);
			return Promise.resolve(options.pick?.(rows) ?? 0);
		},
		show: (agentId) => {
			shown.push(agentId);
			return Promise.resolve();
		},
		create: (_workspaceId, profileId) => {
			created.push(profileId);
			agents.set(CREATED, options.created ?? agent(CREATED));
			return Promise.resolve(CREATED);
		},
		agent: (agentId) => {
			const found = agents.get(agentId);
			if (found === undefined || agentId !== CREATED || statuses.length === 0)
				return found;
			return {
				...found,
				status: statuses.length > 1 ? statuses.shift()! : statuses[0]!,
			};
		},
		insertDraft: (agentId, text) => {
			drafts.push([agentId, text]);
		},
		paste: (agentId, text) => {
			pasted.push([agentId, text]);
			return Promise.resolve();
		},
		sleep: vi.fn(() => Promise.resolve()),
	};
	return {
		send: new SendToAgent(ports),
		ports,
		shown,
		created,
		drafts,
		pasted,
		offered,
	};
}

const byLabel =
	(label: string) =>
	(rows: readonly SendToAgentRowWire[]): number =>
		rows.findIndex((row) => row.label === label);

describe("the list of Agents", () => {
	const workspace: SendTargetWorkspace = {
		id: WORKSPACE,
		root: ROOT,
		agents: [
			agent(GUI, { ordinal: 1 }),
			agent(TUI, { ordinal: 2, status: "working" }),
			agent(CREATED, { ordinal: 3, displayName: "Review" }),
		],
		lastAgentId: GUI,
		canCreateAgent: true,
	};

	it("is the Agent last selected, then the rest newest first, then a New row per profile", () => {
		const { rows } = sendRows(workspace, PROFILES, undefined);
		expect(rows.map((row) => row.label)).toEqual([
			"Claude",
			"Review",
			"Codex",
			"New Claude",
			"New Claude (terminal)",
		]);
		expect(rows[2]).toEqual({
			label: "Codex",
			detail: "Codex · terminal · working",
			kind: "agent",
		});
		expect(rows[3]).toEqual({
			label: "New Claude",
			detail: "Starts a GUI Agent",
			kind: "new",
		});
	});

	it("leads with the choice made last time, said so", () => {
		const { rows, choices } = sendRows(workspace, PROFILES, "new:claude-tui");
		expect(rows[0]?.label).toBe("New Claude (terminal)");
		expect(rows[0]?.detail).toBe("Starts a terminal Agent · last used");
		expect(choices[0]).toEqual({ kind: "new", profileId: "claude-tui" });
		const again = sendRows(workspace, PROFILES, `agent:${TUI}`);
		expect(again.rows.map((row) => row.label).slice(0, 2)).toEqual([
			"Codex",
			"Claude",
		]);
	});

	it("offers no New rows where no Agent can be started", () => {
		const { rows } = sendRows(
			{ ...workspace, canCreateAgent: false },
			PROFILES,
			undefined,
		);
		expect(rows.every((row) => row.kind === "agent")).toBe(true);
	});
});

describe("sending to an Agent there already is", () => {
	it("shows a GUI Agent beside the editor and puts the link and the text after its draft", async () => {
		const test = harness({ pick: byLabel("Claude") });
		await test.send.send(WORKBENCH, PAYLOAD);
		expect(test.shown).toEqual([GUI]);
		expect(test.created).toEqual([]);
		expect(test.drafts).toEqual([
			[GUI, "[src/a.ts:3-4](src/a.ts#L3-L4)\n```typescript\na();\nb();\n```\n"],
		]);
		expect(test.pasted).toEqual([]);
	});

	it("pastes into a terminal Agent's prompt, in the form its CLI reads, without pressing Return", async () => {
		const test = harness({ pick: byLabel("Codex") });
		await test.send.send(WORKBENCH, PAYLOAD);
		expect(test.shown).toEqual([TUI]);
		expect(test.pasted).toEqual([
			[TUI, "src/a.ts:3-4\n```typescript\na();\nb();\n```\n"],
		]);
		const claude = harness({
			agents: [agent(TUI, { profileKind: "claude", displayName: "Claude" })],
			pick: () => 0,
		});
		await claude.send.send(WORKBENCH, PAYLOAD);
		expect(claude.pasted[0]?.[1]).toBe(
			"@src/a.ts#L3-4\n```typescript\na();\nb();\n```\n",
		);
	});

	it("does not type into a terminal Agent that is asking a question", async () => {
		const test = harness({
			agents: [agent(TUI, { status: "waiting" })],
			pick: () => 0,
		});
		await expect(test.send.send(WORKBENCH, PAYLOAD)).rejects.toThrow(
			SendRefused,
		);
		expect(test.shown).toEqual([TUI]);
		expect(test.pasted).toEqual([]);
	});

	it("does nothing when the sheet is cancelled", async () => {
		const test = harness({ pick: () => -1 });
		await test.send.send(WORKBENCH, PAYLOAD);
		expect(test.shown).toEqual([]);
		expect(test.drafts).toEqual([]);
		expect(test.pasted).toEqual([]);
	});
});

describe("sending to a new Agent", () => {
	it("starts a GUI one beside the editor and hands its composer the text", async () => {
		const test = harness({
			pick: byLabel("New Claude"),
			created: agent(CREATED, {
				presentation: "gui",
				profileKind: "claude",
				status: "unknown",
			}),
		});
		await test.send.send(WORKBENCH, PAYLOAD);
		expect(test.created).toEqual(["claude"]);
		expect(test.shown).toEqual([]);
		expect(test.drafts.map(([id]) => id)).toEqual([CREATED]);
	});

	it("starts a terminal one and pastes once its prompt has been up a while", async () => {
		const test = harness({
			pick: byLabel("New Claude (terminal)"),
			created: agent(CREATED, { presentation: "tui", profileKind: "claude" }),
			statuses: [
				"working",
				"idle",
				"waiting",
				...Array<AgentStatus>(6).fill("idle"),
			],
		});
		await test.send.send(WORKBENCH, PAYLOAD);
		expect(test.created).toEqual(["claude-tui"]);
		expect(test.pasted).toEqual([
			[CREATED, "@src/a.ts#L3-4\n```typescript\na();\nb();\n```\n"],
		]);
		// The idle before the question does not count; five settled readings
		// after it do, a quarter second apart: six waits in all.
		expect(vi.mocked(test.ports.sleep).mock.calls.length).toBe(6);
	});

	it("refuses to type into one still asking a question when the wait is over", async () => {
		const test = harness({
			pick: byLabel("New Claude (terminal)"),
			created: agent(CREATED, { presentation: "tui", profileKind: "claude" }),
			statuses: ["waiting"],
		});
		await expect(test.send.send(WORKBENCH, PAYLOAD)).rejects.toThrow(
			/asking a question/u,
		);
		expect(test.pasted).toEqual([]);
		expect(vi.mocked(test.ports.sleep).mock.calls.length).toBe(
			NEW_AGENT_PROMPT_TIMEOUT_MS / 250,
		);
	});

	it("is remembered, and leads the list the next time, in this Workspace and the next", async () => {
		const test = harness({ pick: byLabel("New Claude (terminal)") });
		await test.send.send(WORKBENCH, PAYLOAD);
		await test.send.send(WORKBENCH, PAYLOAD);
		expect(test.offered[1]?.[0]?.label).toBe("New Claude (terminal)");
	});
});

describe("refusals", () => {
	it("names an editor that is no Workspace's, and a selection with nothing to send", async () => {
		const test = harness({});
		await expect(test.send.send({ other: true }, PAYLOAD)).rejects.toThrow(
			SendRefused,
		);
		const nothing = harness({ pick: byLabel("Claude") });
		await expect(
			nothing.send.send(WORKBENCH, {
				...PAYLOAD,
				uri: "untitled:Untitled-1",
				path: undefined,
				ranges: [{ startLine: 1, endLine: 1, text: "" }],
			}),
		).rejects.toThrow(/Nothing is selected/u);
		expect(nothing.drafts).toEqual([]);
	});

	it("refuses a payload that is not one before asking anything", async () => {
		const test = harness({});
		await expect(test.send.send(WORKBENCH, { version: 9 })).rejects.toThrow();
		expect(test.offered).toEqual([]);
	});
});
