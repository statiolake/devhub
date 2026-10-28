/**
 * "Send to Agent…": the editor's selection, with its file, into the input box
 * of one of the Workspace's Agents — shown beside the editor, the input box
 * focused, nothing sent.
 *
 * The workbench sends what is selected (`vscode:devhubSendToAgent`, the
 * overlay's `devhubSendToAgent.contribution.ts`); which Workspace that is, is
 * which workbench sent it. Then:
 *
 * 1. **Which Agent.** A sheet on the modal layer (`send-to-agent`, the
 *    command palette's kind of list): the Workspace's Agents, the one last
 *    chosen first, then the Agent last selected there and the rest newest
 *    first, each with its profile, presentation and status; then a "New …"
 *    row per configured profile, which starts one the way New Agent does.
 *    The choice is remembered per Workspace (and, for a new one, across
 *    Workspaces) and leads the list next time.
 * 2. **Shown beside the editor.** The Agent is selected `beside`: the split,
 *    the editor on the left and the Agent on the right, with the keyboard in
 *    the Agent. A new Agent is created that way (`create_agent`, presentation
 *    `beside`).
 * 3. **The text, in its input box.** In the form that Agent reads
 *    (`agent/sendSelection.ts`). A GUI Agent's composer gets it after its
 *    draft (`AgentInsertions`, to the Agents page); a terminal Agent's pane
 *    gets it as a bracketed paste with no Return
 *    (`TmuxTerminalRuntime.pasteAgentText`). A terminal Agent that is asking
 *    a question (a menu, a trust prompt) is not typed into: the keys would
 *    answer it. A new terminal Agent is waited for until its prompt is up.
 */

import {
	agentAtPrompt,
	type AgentId,
	type AgentPresentation,
	type AgentProfileKind,
	type AgentStatus,
	type WorkspaceId,
} from "../../model/domain.js";
import type { SendToAgentRowWire } from "../../ipc/contract.js";
import {
	parseSendSelection,
	referenceStyle,
	selectionInsertion,
	type SendSelection,
} from "../agent/sendSelection.js";

export const SEND_TO_AGENT_CHANNEL = "vscode:devhubSendToAgent";

/** An Agent, as the sheet lists it and the send reaches it. */
export interface SendTargetAgent {
	readonly id: AgentId;
	readonly displayName: string;
	readonly profileDisplayName: string;
	readonly profileKind: AgentProfileKind;
	readonly presentation: AgentPresentation;
	readonly status: AgentStatus;
	readonly ordinal: number;
}

export interface SendTargetWorkspace {
	readonly id: WorkspaceId;
	/** Where its Agents run: the directory a path is made relative to. */
	readonly root: string;
	readonly agents: readonly SendTargetAgent[];
	/** The Agent last selected here, which leads the Agents after the remembered one. */
	readonly lastAgentId: AgentId | undefined;
	readonly canCreateAgent: boolean;
}

export interface SendTargetProfile {
	readonly id: string;
	readonly displayName: string;
	readonly presentation: AgentPresentation;
}

/** What the sheet's rows stand for. */
export type SendChoice =
	| { readonly kind: "agent"; readonly agentId: AgentId }
	| { readonly kind: "new"; readonly profileId: string };

export interface SendToAgentPorts {
	/** The Workspace whose workbench sent this, or none. */
	readonly workspaceOf: (sender: unknown) => SendTargetWorkspace | undefined;
	readonly profiles: () => readonly SendTargetProfile[];
	/** Put the sheet up; the index of the row chosen, -1 for none. */
	readonly choose: (rows: readonly SendToAgentRowWire[]) => Promise<number>;
	/** Show the Agent beside its Workspace's editor, with the keyboard in it. */
	readonly show: (agentId: AgentId) => Promise<void>;
	/** Start an Agent from a profile, shown beside the editor; its id. */
	readonly create: (
		workspaceId: WorkspaceId,
		profileId: string,
	) => Promise<AgentId>;
	/** The Agent as the model has it now. */
	readonly agent: (agentId: AgentId) => SendTargetAgent | undefined;
	/** Into a GUI Agent's composer, after its draft, focused. */
	readonly insertDraft: (agentId: AgentId, text: string) => void;
	/** Into a terminal Agent's prompt, as a paste with no Return. */
	readonly paste: (agentId: AgentId, text: string) => Promise<void>;
	readonly sleep: (ms: number) => Promise<void>;
}

/** How long a new terminal Agent is waited for to show its prompt. */
export const NEW_AGENT_PROMPT_TIMEOUT_MS = 30_000;
const PROMPT_POLL_MS = 250;
/** How long its prompt must have been up: `IDLE_SETTLE_MS`'s second. */
const PROMPT_SETTLE_MS = 1_000;

/** A send that cannot go where it was asked to, and why, for the person. */
export class SendRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SendRefused";
	}
}

function choiceKey(choice: SendChoice): string {
	return choice.kind === "agent"
		? `agent:${choice.agentId}`
		: `new:${choice.profileId}`;
}

function statusWords(status: AgentStatus): string {
	switch (status) {
		case "working":
			return "working";
		case "background":
			return "idle, tasks running";
		case "waiting":
			return "waiting for you";
		case "idle":
			return "idle";
		case "error":
			return "failed";
		case "unknown":
			return "status unknown";
	}
}

function presentationWords(presentation: AgentPresentation): string {
	return presentation === "gui" ? "GUI" : "terminal";
}

/**
 * The sheet's rows: the remembered choice first, then the Agents (the one
 * last selected, then newest first), then a New row per profile.
 */
export function sendRows(
	workspace: SendTargetWorkspace,
	profiles: readonly SendTargetProfile[],
	remembered: string | undefined,
): { readonly rows: SendToAgentRowWire[]; readonly choices: SendChoice[] } {
	const agents = [...workspace.agents].sort((a, b) => {
		if (a.id === workspace.lastAgentId) return -1;
		if (b.id === workspace.lastAgentId) return 1;
		return b.ordinal - a.ordinal;
	});
	const entries: { row: SendToAgentRowWire; choice: SendChoice }[] = [
		...agents.map((agent) => ({
			choice: { kind: "agent", agentId: agent.id } as SendChoice,
			row: {
				label: agent.displayName,
				detail: `${agent.profileDisplayName} · ${presentationWords(agent.presentation)} · ${statusWords(agent.status)}`,
				kind: "agent" as const,
			},
		})),
		...(workspace.canCreateAgent ? profiles : []).map((profile) => ({
			choice: { kind: "new", profileId: profile.id } as SendChoice,
			row: {
				label: `New ${profile.displayName}`,
				detail: `Starts a ${presentationWords(profile.presentation)} Agent`,
				kind: "new" as const,
			},
		})),
	];
	const first = entries.findIndex(
		(entry) => choiceKey(entry.choice) === remembered,
	);
	if (first > 0) entries.unshift(...entries.splice(first, 1));
	if (first >= 0) {
		const lead = entries[0]!;
		entries[0] = {
			...lead,
			row: { ...lead.row, detail: `${lead.row.detail} · last used` },
		};
	}
	return {
		rows: entries.map((entry) => entry.row),
		choices: entries.map((entry) => entry.choice),
	};
}

export class SendToAgent {
	/** The last choice in each Workspace. */
	readonly #byWorkspace = new Map<WorkspaceId, string>();
	/** The last New row chosen anywhere, for a Workspace with no choice of its own. */
	#lastNew: string | undefined;

	constructor(private readonly ports: SendToAgentPorts) {}

	/** One send, from the workbench `sender`. */
	async send(sender: unknown, raw: unknown): Promise<void> {
		const selection = parseSendSelection(raw);
		const workspace = this.ports.workspaceOf(sender);
		if (workspace === undefined)
			throw new SendRefused(
				"This editor is not one of DevHub's Workspaces, so there is no Agent to send to.",
			);
		const remembered = this.#byWorkspace.get(workspace.id) ?? this.#lastNew;
		const { rows, choices } = sendRows(
			workspace,
			this.ports.profiles(),
			remembered,
		);
		if (rows.length === 0)
			throw new SendRefused(
				"This Workspace has no Agents and no profile to start one from.",
			);
		const choice = choices[await this.ports.choose(rows)];
		if (choice === undefined) return;
		const key = choiceKey(choice);
		this.#byWorkspace.set(workspace.id, key);
		if (choice.kind === "new") this.#lastNew = key;
		await this.deliver(workspace, selection, choice);
	}

	private async deliver(
		workspace: SendTargetWorkspace,
		selection: SendSelection,
		choice: SendChoice,
	): Promise<void> {
		let agentId: AgentId;
		if (choice.kind === "agent") {
			agentId = choice.agentId;
			await this.ports.show(agentId);
		} else {
			agentId = await this.ports.create(workspace.id, choice.profileId);
		}
		const agent = this.ports.agent(agentId);
		if (agent === undefined)
			throw new SendRefused("The Agent is no longer there.");
		const text = selectionInsertion(selection, {
			style: referenceStyle(agent.presentation, agent.profileKind),
			root: workspace.root,
		});
		if (text === undefined)
			throw new SendRefused(
				"Nothing is selected, and the document is not a file to refer to.",
			);
		if (agent.presentation === "gui") {
			this.ports.insertDraft(agentId, text);
			return;
		}
		const ready = choice.kind === "new" ? await this.promptOf(agentId) : agent;
		if (ready.status === "waiting")
			throw new SendRefused(
				`${ready.displayName} is asking a question; answer it, then send the selection again. Nothing was typed: the keys would have answered it.`,
			);
		await this.ports.paste(agentId, text);
	}

	/**
	 * A new terminal Agent once its prompt has been up for a second (a CLI
	 * that is starting flickers through screens, as `injection.ts` says), or
	 * as it is when it has not come up in time — a CLI whose screen DevHub
	 * cannot read never says. A question it asks meanwhile (whether to trust
	 * the folder) is waited through: answered, the prompt comes up.
	 */
	private async promptOf(agentId: AgentId): Promise<SendTargetAgent> {
		let settled = 0;
		for (
			let waited = 0;
			waited < NEW_AGENT_PROMPT_TIMEOUT_MS;
			waited += PROMPT_POLL_MS
		) {
			const agent = this.ports.agent(agentId);
			if (agent === undefined)
				throw new SendRefused("The Agent stopped before it was ready.");
			settled = agentAtPrompt(agent.status) ? settled + PROMPT_POLL_MS : 0;
			if (settled > PROMPT_SETTLE_MS) return agent;
			await this.ports.sleep(PROMPT_POLL_MS);
		}
		const agent = this.ports.agent(agentId);
		if (agent === undefined)
			throw new SendRefused("The Agent stopped before it was ready.");
		return agent;
	}
}
