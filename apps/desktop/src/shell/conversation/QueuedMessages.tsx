/**
 * The messages DevHub holds for an Agent that is busy (`Transcript.pending`),
 * drawn at the end of the transcript — after the activity line, in the same
 * scroll as everything else — oldest first. They are the person's words not
 * yet sent, so they read as the next lines of the conversation, and a long
 * one scrolls away with the rest instead of standing over it.
 *
 * Each is the person's own bubble, not yet solid, under one quiet line that
 * says it waits and where. Each can be sent now (a running turn takes it in
 * as it goes), changed in place, or removed. One open to be changed is held
 * by main, unsent, from Edit until Save or Cancel, and let go if it goes away
 * with it open; the caret starts at the end of its words. A long one is cut
 * to a few lines (`Clip`), with Show all under it.
 *
 * What is being changed is part of the Agent's draft (`Composer`): the list
 * reports each open edit's words (`reportEdit`), and the keyboard leaving one
 * tells main the draft at once (`flushDraft`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConversationState,
  PendingId,
  PendingMessage,
} from "../../model/conversation";
import { Clip } from "./Clip";
import { useConversationActions } from "./ConversationContext";
import { ImageView } from "./EntryParts";
import { PersonBubble } from "./EntryView";
import { ClockIcon, CloseIcon, EditIcon, SendIcon } from "./icons";
import { SEND_KEY, useMessageKeys } from "./messageKeys";
import { SkillText } from "./skillTokens";

/**
 * What a held message says about itself, in the one quiet line over its
 * bubble: that it is queued and where, that it is being changed, or why it
 * was not sent. The longer account of what "queued" means is the line's
 * tooltip (`PENDING_TOOLTIP`), not a second line under every message.
 */
export function pendingStatus(
  message: PendingMessage,
  position: number,
  total: number,
  editing: boolean,
): string {
  if (message.failure !== undefined) return `Not sent: ${message.failure}`;
  if (editing || message.editing) return "Editing · not sent until saved";
  return total > 1 ? `Queued · ${position} of ${total}` : "Queued";
}

/** What "queued" means, said once, under the pointer. */
export const PENDING_TOOLTIP =
  "Sent when the Agent is ready for it, after the turn that is running";

/** Whether a held message can go now: the CLI is up and takes one (a running turn takes it in). */
export function canSendNow(state: ConversationState): boolean {
  return state.phase === "ready" && state.turn !== "rewinding";
}

export type ReportEdit = (
  pending: PendingId,
  words: string | undefined,
) => void;

/**
 * The words of each held message open to be changed, kept where both the
 * list and the composer (whose draft they are part of) can read them.
 */
export function usePendingEdits(): {
  readonly edits: ReadonlyMap<PendingId, string>;
  readonly reportEdit: ReportEdit;
} {
  const [edits, setEdits] = useState<ReadonlyMap<PendingId, string>>(
    () => new Map(),
  );
  const reportEdit = useCallback<ReportEdit>(
    (pending, words) =>
      setEdits((current) => {
        if (current.get(pending) === words) return current;
        const next = new Map(current);
        if (words === undefined) next.delete(pending);
        else next.set(pending, words);
        return next;
      }),
    [],
  );
  return { edits, reportEdit };
}

/** The held messages, oldest first; nothing when none is held. */
export function QueuedMessages({
  pending,
  state,
  reportEdit,
  flushDraft,
}: {
  readonly pending: readonly PendingMessage[];
  readonly state: ConversationState;
  /** Its changed words while one is open to be changed, else `undefined`: part of the draft. */
  readonly reportEdit: ReportEdit;
  /** Tell main the draft now: the keyboard left a message being changed. */
  readonly flushDraft: () => void;
}) {
  if (pending.length === 0) return null;
  const sendable = canSendNow(state);
  return (
    <ol
      className="conversation-pending"
      aria-label="Waiting to be sent"
      onBlur={flushDraft}
    >
      {pending.map((message, index) => (
        <PendingItem
          key={message.id}
          message={message}
          position={index + 1}
          total={pending.length}
          canSendNow={sendable}
          reportEdit={reportEdit}
        />
      ))}
    </ol>
  );
}

/**
 * One message DevHub holds, with what can be done to it: Send now, Edit (in
 * place: ⌘Return saves, Esc gives it up) and Remove.
 */
function PendingItem({
  message,
  position,
  total,
  canSendNow,
  reportEdit,
}: {
  readonly message: PendingMessage;
  /** Its place in the queue, from 1. */
  readonly position: number;
  readonly total: number;
  readonly canSendNow: boolean;
  readonly reportEdit: ReportEdit;
}) {
  const {
    startEditingPending,
    editPending,
    stopEditingPending,
    removePending,
    sendPendingNow,
    reportFailure,
  } = useConversationActions();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  useEffect(() => {
    reportEdit(message.id, draft);
  }, [reportEdit, message.id, draft]);
  useEffect(
    () => () => reportEdit(message.id, undefined),
    [reportEdit, message.id],
  );
  // Main holds the message while the editor is open; the list going away
  // with it open lets go, so it is not held for an edit nobody finishes.
  const editing = useRef(false);
  editing.current = draft !== undefined;
  const release = useRef<() => void>(() => undefined);
  release.current = () => {
    void stopEditingPending(message.id).catch(reportFailure);
  };
  useEffect(
    () => () => {
      if (editing.current) release.current();
    },
    [],
  );
  const open = () => {
    void startEditingPending(message.id).then(
      () => setDraft(message.text),
      reportFailure,
    );
  };
  const cancel = () => {
    setDraft(undefined);
    release.current();
  };
  const save = () => {
    if (draft === undefined) return;
    if (draft.trim() === "" && message.images.length === 0) {
      void removePending(message.id).catch(reportFailure);
      return;
    }
    void editPending(message.id, draft).then(
      () => setDraft(undefined),
      reportFailure,
    );
  };
  const keys = useMessageKeys(save, (event) => {
    if (event.key === "Escape") {
      // Gives the edit up; the turn is not interrupted by the same key.
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  });
  return (
    <li
      className="conversation-pending-item"
      data-failed={message.failure !== undefined || undefined}
      data-editing={draft !== undefined || undefined}
    >
      <div
        className="conversation-pending-label"
        title={message.failure === undefined ? PENDING_TOOLTIP : undefined}
        // What the page says about the message, not its words: not found.
        data-find-skip=""
      >
        <ClockIcon />
        <span className="conversation-pending-status">
          {pendingStatus(message, position, total, draft !== undefined)}
        </span>
      </div>
      <div className="conversation-pending-row">
        {draft === undefined ? (
          <div className="conversation-pending-actions">
            <button
              type="button"
              className="conversation-pending-now"
              aria-label="Send now"
              title="Send now — a running turn takes it in as it goes"
              disabled={!canSendNow}
              onClick={() => {
                void sendPendingNow(message.id).catch(reportFailure);
              }}
            >
              <SendIcon />
            </button>
            <button
              type="button"
              className="conversation-pending-edit"
              aria-label="Edit"
              title="Edit"
              onClick={open}
            >
              <EditIcon />
            </button>
            <button
              type="button"
              className="conversation-pending-remove"
              aria-label="Remove"
              title="Remove"
              onClick={() => {
                void removePending(message.id).catch(reportFailure);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ) : null}
        <div className="conversation-user" data-origin="person">
          {message.images.length > 0 ? (
            <div className="conversation-images">
              {message.images.map((image, index) => (
                <ImageView key={index} image={image} />
              ))}
            </div>
          ) : null}
          {draft === undefined ? (
            <PersonBubble origin="person">
              {message.text !== "" ? (
                <Clip>
                  <SkillText text={message.text} />
                </Clip>
              ) : null}
            </PersonBubble>
          ) : (
            <textarea
              className="conversation-pending-input"
              aria-label="Waiting message"
              rows={3}
              value={draft}
              autoFocus
              onFocus={(event) => {
                const end = event.currentTarget.value.length;
                event.currentTarget.setSelectionRange(end, end);
              }}
              onChange={(event) => setDraft(event.target.value)}
              {...keys}
            />
          )}
        </div>
      </div>
      {draft === undefined ? null : (
        <div className="conversation-pending-footer">
          <button
            type="button"
            className="conversation-pending-cancel"
            onClick={cancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="conversation-pending-save"
            title={`Save (${SEND_KEY})`}
            onClick={save}
          >
            Save
          </button>
        </div>
      )}
    </li>
  );
}
