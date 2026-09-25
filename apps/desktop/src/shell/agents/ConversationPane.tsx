/**
 * A GUI Agent's pane: its conversation, attached and drawn.
 *
 * The counterpart of `TerminalSurface`'s attachment. It asks main for the
 * conversation once, folds every event after it with the same `applyEvent`
 * main folded them with, and hands the result to `ConversationSurface`, which
 * draws and does nothing else. The calls the surface makes go to the bridge,
 * already bound to this one Agent, and a call that fails goes to the page's
 * root like every other failure on the page.
 */

import { useEffect, useMemo, useState } from "react";
import type { AppAppearance } from "../../ipc/appShell";
import {
  EMPTY_TRANSCRIPT,
  applyEvent,
  type ConversationEvent,
  type RequestAnswer,
  type EntryId,
  type RequestId,
  type Transcript,
} from "../../model/conversation";
import { ConversationSurface } from "../conversation/ConversationSurface";
import {
  SessionPicker,
  type SessionSource,
} from "../components/shell/SessionPicker";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";

export function ConversationPane({
  agentId,
  label,
  cli,
  appearance,
  hidden,
}: {
  readonly agentId: string;
  readonly label: string;
  /** The CLI's name, for what `/resume` says about its sessions. */
  readonly cli: string;
  readonly appearance: AppAppearance | undefined;
  readonly hidden: boolean;
}) {
  const { reportFailure } = useAgents();
  const transcript = useConversation(agentId, reportFailure);
  // Not declared as `ConversationActions`: that interface grows with the
  // surface (the composer, the header), and what this pane binds is every
  // call the bridge can make for one Agent — the surface takes what it uses.
  const actions = useMemo(() => {
    const bridge = devhub();
    return {
      writeClipboard: (text: string) => bridge.writeClipboard(text),
      openExternalUrl: (url: string) => bridge.openExternalUrl(url),
      send: (text: string) => bridge.conversation.send(agentId, text),
      editLastMessage: (message: EntryId, text: string) =>
        bridge.conversation.editLastMessage(agentId, message, text),
      interrupt: () => bridge.conversation.interrupt(agentId),
      answer: (request: RequestId, answer: RequestAnswer) =>
        bridge.conversation.answer(agentId, request, answer),
      setSetting: (setting: "model" | "effort" | "mode", id: string) =>
        bridge.conversation.setSetting(agentId, setting, id),
      openResume: () => setResuming(true),
      reportFailure,
    };
  }, [agentId, reportFailure]);
  const [resuming, setResuming] = useState(false);
  const sessions: SessionSource = useMemo(() => {
    const bridge = devhub().conversation;
    return {
      list: (scope) => bridge.listSessions(agentId, scope),
      preview: (session, cwd) => bridge.previewSession(agentId, session, cwd),
    };
  }, [agentId]);
  return (
    <>
      <ConversationSurface
        transcript={transcript}
        actions={actions}
        appearance={appearance}
        hidden={hidden}
        label={label}
      />
      {/* `/resume`: the Workspace's earlier sessions, one of which this
          Agent then goes on with in place of the one it is in. */}
      {resuming && !hidden ? (
        <SessionPicker
          title="Resume a Session"
          question={`Which earlier session should ${label} go on with? The one it is in now is left as it is.`}
          cli={cli}
          source={sessions}
          onChoose={(session) => {
            void devhub()
              .conversation.resumeSession(agentId, session)
              .then(
                () => setResuming(false),
                (error: unknown) => {
                  setResuming(false);
                  reportFailure(error);
                },
              );
          }}
          onCancel={() => setResuming(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The Agent's transcript as main holds it, kept current.
 *
 * Until the attachment answers it is the empty transcript, which is
 * `connecting` — exactly what the Agent is to this page until then. Events
 * that arrive before the answer are held and folded after it; an event the
 * snapshot already holds is dropped by its revision, and a gap in the
 * revisions is a broken promise of main's, reported rather than folded over.
 *
 * Every event is folded the moment it arrives, so an event the fold refuses
 * is refused at that event and not a frame later. What is drawn is published
 * at most once per animation frame: a streaming answer sends a delta per
 * token, and drawing each of them would redraw the transcript many times
 * inside one frame for a picture only the last of them is on.
 */
function useConversation(
  agentId: string,
  reportFailure: (error: unknown) => void,
): Transcript {
  const [transcript, setTranscript] = useState<Transcript>(EMPTY_TRANSCRIPT);
  useEffect(() => {
    const bridge = devhub();
    let current: { transcript: Transcript; revision: number } | undefined;
    let broken = false;
    let frame: number | undefined;
    const publish = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (current !== undefined) setTranscript(current.transcript);
      });
    };
    const early: [number, ConversationEvent][] = [];
    const fold = (revision: number, event: ConversationEvent) => {
      if (broken) return;
      if (current === undefined) {
        early.push([revision, event]);
        return;
      }
      if (revision <= current.revision) return;
      try {
        if (revision !== current.revision + 1) {
          throw new Error(
            `the conversation of Agent ${agentId} skipped from event ${current.revision} to ${revision}`,
          );
        }
        current = {
          transcript: applyEvent(current.transcript, event),
          revision,
        };
      } catch (error: unknown) {
        // What is drawn stops where it was still true.
        broken = true;
        reportFailure(error);
        return;
      }
      publish();
    };
    let attached = true;
    bridge.conversation
      .attach(agentId, fold)
      .then((attachment) => {
        if (!attached) return;
        current = attachment;
        setTranscript(attachment.transcript);
        for (const [revision, event] of early.splice(0)) fold(revision, event);
      })
      .catch(reportFailure);
    return () => {
      attached = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      bridge.conversation.detach(agentId).catch(reportFailure);
    };
  }, [agentId, reportFailure]);
  return transcript;
}
