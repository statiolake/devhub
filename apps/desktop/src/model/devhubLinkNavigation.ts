/**
 * Where a `devhub:` link goes: what it is resolved against, and the move that
 * follows it — one function for every door a link comes in by.
 *
 * A chip clicked on the Agents page (`shell/agents/devhubLinks.tsx`) and a
 * link the system hands DevHub from outside — Slack, Notes, a browser
 * (`main/shell/openFromUrl.ts`) — resolve against the same places and move
 * through the same intents, so a link means one thing wherever it is
 * clicked. A click is an explicit move through the intents the window
 * already has — no new door:
 *
 * - an agent, a workspace, the Orchestrator row: `select_context` with
 *   `reason: "explicit"`, a place in Back and Forward at once;
 * - a task, or an escalation (its task): one move to the Orchestrator row
 *   with the task open over its board (`show_orchestrator_view`, `reason: "explicit"`),
 *   so it is one entry in Back and Forward and Back from it is where the
 *   link was clicked; the board follows the model (`orchestratorHistory.ts`);
 * - a file: main opens it in the workspace that holds it, through the
 *   open-file routing, as an explicit move (`openLinkedFile`);
 * - a session: the agent running it, selected; resuming one is still the
 *   person's own `/resume`.
 *
 * Pure: the ports are the page's bridge or main's own dispatch.
 */

import type {
  AppIntentWire,
  AppOutcomeWire,
  AppSnapshotWire,
} from "../ipc/appShell.js";
import type { OrchestratorBoardWire } from "../ipc/contract.js";
import type { FileRange } from "../ipc/conversation.js";
import type { LinkPlaces, ResolvedLink } from "./devhubLink.js";

/** The places a link can name, from the snapshot and the board. */
export function linkPlaces(
  snapshot: AppSnapshotWire | undefined,
  board: OrchestratorBoardWire,
): LinkPlaces {
  return {
    workspaces: (snapshot?.workspaces ?? []).map((workspace) => ({
      id: workspace.id,
      label:
        workspace.id === snapshot?.scratchWorkspaceId
          ? "Scratch"
          : workspace.label,
      root: workspace.root,
      local: workspace.location.kind === "local",
      agents: workspace.agents.map((agent) => ({
        id: agent.id,
        displayName: agent.displayName,
        status: agent.status,
      })),
    })),
    tasks: [
      ...board.answer,
      ...board.inProgress,
      ...board.waiting,
      ...board.done,
    ],
    escalations: [
      ...board.answer,
      ...board.inProgress,
      ...board.waiting,
      ...board.done,
    ].flatMap((task) => task.escalations),
    orchestrator: true,
  };
}

export interface LinkNavigationPorts {
  readonly dispatch: (
    intent: AppIntentWire,
  ) => Promise<AppOutcomeWire | undefined>;
  readonly openLinkedFile: (
    workspaceId: string,
    path: string,
    range: FileRange | undefined,
  ) => Promise<void>;
  readonly sessionAgent: (session: string) => Promise<string | null>;
}

/** Go where a resolved link leads, as an explicit move. */
export async function navigateLink(
  target: ResolvedLink,
  ports: LinkNavigationPorts,
): Promise<void> {
  const select = (
    context: Extract<AppIntentWire, { type: "select_context" }>["context"],
  ) => ports.dispatch({ type: "select_context", context, reason: "explicit" });
  switch (target.kind) {
    case "agent":
      await select({ kind: "agent", agentId: target.agent.id });
      return;
    case "workspace":
      await select({ kind: "workspace", workspaceId: target.workspace.id });
      return;
    case "orchestrator":
      await select({ kind: "orchestrator" });
      return;
    case "task":
    case "escalation":
      await ports.dispatch({
        type: "show_orchestrator_view",
        view: { kind: "task", id: target.task.id },
        reason: "explicit",
      });
      return;
    case "file":
      await ports.openLinkedFile(
        target.workspace.id,
        target.path,
        target.line === undefined
          ? undefined
          : { kind: "line", line: target.line, column: target.column ?? 1 },
      );
      return;
    case "session": {
      const agentId = await ports.sessionAgent(target.session);
      if (agentId === null)
        throw new Error(
          `No open agent is running the session ${target.session} (見つかりません). Resume it from an agent's /resume.`,
        );
      await select({ kind: "agent", agentId });
      return;
    }
  }
}
