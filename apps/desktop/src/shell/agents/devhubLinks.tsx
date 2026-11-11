/**
 * `devhub:` links on the Agents page: what they resolve against and where a
 * click goes (`shell/conversation/DevhubLink.tsx` draws them).
 *
 * Resolved against the page's own snapshot and board, so a chip names the
 * place as it is now. A click is an explicit move through the intents the
 * window already has — no new door:
 *
 * - an agent, a workspace, the Orchestrator row: `select_context` with
 *   `reason: "explicit"`, a place in Back and Forward at once;
 * - an escalation: one move to the Orchestrator row with the escalation
 *   open over its board (`show_orchestrator_view`, `reason: "explicit"`),
 *   so it is one entry in Back and Forward and Back from it is where the
 *   link was clicked; the board follows the model (`orchestratorHistory.ts`);
 * - a file: main opens it in the workspace that holds it, through the
 *   open-file routing, as an explicit move (`openLinkedFile`);
 * - a session: the agent running it, selected; resuming one is still the
 *   person's own `/resume`.
 */

import { useMemo, type ReactNode } from "react";
import type { AppIntent, AppOutcome, AppSnapshot } from "../../ipc/appShell";
import type { OrchestratorBoardWire } from "../../ipc/contract";
import type { FileRange } from "../../ipc/conversation";
import type { LinkPlaces, ResolvedLink } from "../../model/devhubLink";
import {
  DevhubLinksProvider,
  type DevhubLinks,
} from "../conversation/DevhubLink";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";

/** The places a link can name, from the snapshot and the board. */
export function linkPlaces(
  snapshot: AppSnapshot | undefined,
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
    escalations: [...board.needsAnswer, ...board.inProgress, ...board.closed],
    orchestrator: true,
  };
}

export interface LinkNavigationPorts {
  readonly dispatch: (intent: AppIntent) => Promise<AppOutcome | undefined>;
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
    context: Extract<AppIntent, { type: "select_context" }>["context"],
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
    case "escalation":
      await ports.dispatch({
        type: "show_orchestrator_view",
        view: { kind: "escalation", id: target.escalation.id },
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

/** `devhub:` links for everything under it, bound to this page. */
export function AgentsDevhubLinks({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { state, board, dispatch, reportFailure } = useAgents();
  const snapshot = state.status === "ready" ? state.snapshot : undefined;
  const value = useMemo<DevhubLinks>(() => {
    const ports: LinkNavigationPorts = {
      dispatch,
      openLinkedFile: (workspaceId, path, range) =>
        devhub().openLinkedFile(workspaceId, path, range),
      sessionAgent: (session) => devhub().devhubSessionAgent(session),
    };
    return {
      places: linkPlaces(snapshot, board),
      navigate: (target) => navigateLink(target, ports),
      sessionAgent: ports.sessionAgent,
      reportFailure,
    };
  }, [snapshot, board, dispatch, reportFailure]);
  return <DevhubLinksProvider value={value}>{children}</DevhubLinksProvider>;
}
