/**
 * The conversation's Markdown renderer, set up for the Orchestrator screen's
 * left pane — an escalation's thread, a file in the orchestrator's folder —
 * where nothing is a conversation: links, copies and diagrams go through the
 * bridge, and a file path is looked up on `agentId`'s machine.
 */

import { useMemo } from "react";
import { Markdown } from "../conversation/Markdown";
import {
  AgentCwdProvider,
  ConversationActionsProvider,
  type ConversationActions,
} from "../conversation/ConversationContext";
import { PathLinks, PathLinksProvider } from "../conversation/pathLinks";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";

/**
 * What the conversation's renderer asks of the page, for an escalation's
 * thread: links, copies and diagrams through the bridge; a file path is
 * looked up on the agent the escalation is about (or the orchestrator's).
 * Nothing here sends anything to an agent — the composer below is the
 * board's own.
 */
function useThreadActions(
  agentId: string | undefined,
  reportFailure: (error: unknown) => void,
): ConversationActions {
  return useMemo(() => {
    const bridge = devhub();
    const none = () =>
      Promise.reject(new Error("an escalation's thread sends nothing"));
    return {
      writeClipboard: (text) => bridge.writeClipboard(text),
      writeClipboardImage: (png) => bridge.writeClipboardImage(png),
      writeClipboardRich: (content) => bridge.writeClipboardRich(content),
      saveSlidesPdf: (request) => bridge.saveSlidesPdf(request),
      saveSlideImages: (request) => bridge.saveSlideImages(request),
      showContextMenu: (request) => bridge.showContextMenu(request),
      openExternalUrl: (url) => bridge.openExternalUrl(url),
      send: none,
      startEditingPending: none,
      editPending: none,
      stopEditingPending: none,
      removePending: none,
      sendPendingNow: none,
      instruct: none,
      rewind: none,
      cancelLimitResume: none,
      interrupt: none,
      stopTask: none,
      answer: none,
      setSetting: none,
      cliDefaults: () => Promise.resolve(undefined),
      setCliDefault: none,
      openResume: () => undefined,
      openMcp: () => undefined,
      restart: none,
      saveDraft: () => Promise.resolve(),
      resolvePaths: (cwd, paths) =>
        agentId === undefined
          ? Promise.resolve(paths.map(() => null))
          : bridge.conversation.resolvePaths(agentId, cwd, paths),
      readEmbedFile: (path) =>
        agentId === undefined
          ? Promise.resolve(null)
          : bridge.conversation.readEmbedFile(agentId, path),
      embedSignature: (path) =>
        agentId === undefined
          ? Promise.resolve(null)
          : bridge.conversation.embedSignature(agentId, path),
      openFile: (path, range) =>
        agentId === undefined
          ? none()
          : bridge.conversation.openFile(agentId, path, range),
      reportFailure,
    } satisfies ConversationActions;
  }, [agentId, reportFailure]);
}

/** The conversation's renderer, set up for a thread outside a conversation. */
export function RichText({
  source,
  agentId,
}: {
  readonly source: string;
  readonly agentId: string | undefined;
}) {
  const { reportFailure } = useAgents();
  const actions = useThreadActions(agentId, reportFailure);
  const links = useMemo(
    () => new PathLinks(actions.resolvePaths, actions.reportFailure),
    [actions],
  );
  return (
    <ConversationActionsProvider value={actions}>
      <PathLinksProvider value={links}>
        <AgentCwdProvider value={undefined}>
          <Markdown source={source} streaming={false} />
        </AgentCwdProvider>
      </PathLinksProvider>
    </ConversationActionsProvider>
  );
}
