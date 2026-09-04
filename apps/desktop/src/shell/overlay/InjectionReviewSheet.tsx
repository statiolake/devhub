/**
 * The wording DevHub is about to say, before it says it.
 *
 * This sheet is up *while the agent starts behind it*, and that is the whole
 * reason it is a modal rather than one more question in the Issue wizard's
 * chain. Two waits run at once — a person reading a rendered template, and a
 * CLI drawing its first prompt — and neither is made to queue behind the other.
 * Whichever finishes second is the one the send waits on: confirming does not
 * type anything, it only removes the queue's reason for refusing
 * (`main/agent/injection.ts`).
 *
 * Escape cancels the message and nothing else. The agent stays running, because
 * it was started for a reason and reading its first instruction and deciding
 * against that wording is not deciding against the agent. What is cancelled is
 * recorded — the row says so — because a message that disappeared silently is
 * indistinguishable from one still waiting for a prompt that never comes.
 *
 * It wears the picker's chrome: the same heading band, the same footer, the
 * same Escape. A person should not have to work out which kind of sheet they
 * are looking at to know what the keys do.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isImeComposing } from "../accessibility/ime";
import { useAppShell } from "../useAppShell";

export interface InjectionReviewSheetProps {
  readonly agentId: string;
  readonly injectionId: string;
  readonly actionName: string;
  readonly text: string;
  readonly onDismiss: () => void;
}

export function InjectionReviewSheet({
  agentId,
  injectionId,
  actionName,
  text,
  onDismiss,
}: InjectionReviewSheetProps) {
  const { state, confirmInjection, cancelInjection } = useAppShell();
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const headingId = useId();
  const questionId = useId();

  /**
   * Every agent there is, or nothing while this page is still being told.
   *
   * The same distinction the rename sheet draws, and for the same reason: the
   * overlay page is built when the first modal opens, so its projection is in
   * flight while this mounts. "I have not been told" is not "the agent is
   * gone", and reading them as one thing would put a failure on screen for
   * every message DevHub ever queues.
   */
  const agents =
    state.status === "ready"
      ? state.snapshot.workspaces.flatMap((workspace) => workspace.agents)
      : undefined;
  const agent = agents?.find((candidate) => candidate.id === agentId);

  /**
   * The agent this message was for is not there to receive it.
   *
   * Shown rather than dismissed. A launch that failed, or an agent somebody
   * stopped while the sheet stood, is exactly the case where closing the sheet
   * silently would leave a person believing their message went — so the sheet
   * stays, says what happened, and offers only the way out.
   */
  const gone =
    agents !== undefined &&
    (agent === undefined || agent.controlState !== "running")
      ? agent === undefined
        ? "That agent has ended, so this message cannot be sent."
        : "That agent is no longer running, so this message cannot be sent."
      : undefined;

  useEffect(() => {
    field.current?.focus();
    // The caret at the end rather than the whole template selected: this is a
    // sentence to amend, not a name to type over.
    const length = field.current?.value.length ?? 0;
    field.current?.setSelectionRange(length, length);
  }, []);

  const send = useCallback(async () => {
    if (busy || gone !== undefined || value.trim().length === 0) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await confirmInjection(agentId, injectionId, value);
      onDismiss();
    } catch (error: unknown) {
      setBusy(false);
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, [agentId, busy, confirmInjection, gone, injectionId, onDismiss, value]);

  /**
   * Closing is cancelling, wherever the close came from.
   *
   * Escape, the Cancel button and a click on the scrim are one act with one
   * consequence, so they are one function. A sheet where two of the three ways
   * out did different things to the queue would teach nothing that stayed true.
   */
  const cancel = useCallback(() => {
    if (busy) return;
    void cancelInjection(agentId, injectionId).finally(onDismiss);
  }, [agentId, busy, cancelInjection, injectionId, onDismiss]);

  return createPortal(
    <div
      className="mac-scrim mac"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <section
        className="mac-sheet picker injection-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={questionId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
            return;
          }
          // Command-Return sends, because Return is a newline in a message that
          // is several lines long and the template already has some.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            if (isImeComposing(event.nativeEvent, composing.current)) return;
            event.preventDefault();
            void send();
          }
        }}
      >
        <header className="picker-header">
          <div className="picker-heading">
            <h2 className="picker-title" id={headingId}>
              {actionName}
            </h2>
            {agent ? (
              <span className="picker-step mac-caption">
                {agent.displayName}
              </span>
            ) : null}
          </div>
          <p className="picker-question mac-caption" id={questionId}>
            Review the prompt before it is sent
          </p>
        </header>

        <div className="picker-body injection-review-body">
          <textarea
            ref={field}
            className="injection-review-field"
            aria-label="Message to send"
            spellCheck={false}
            value={value}
            disabled={busy || gone !== undefined}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </div>

        <footer className="picker-footer">
          {/* Why it has not gone yet, in the sheet's own voice. The agent is
              starting behind this sheet, so "waiting for the agent" is news
              rather than an excuse — and it is what makes the two waits
              visible as two. */}
          <p className="picker-note mac-caption" role="status">
            {gone ??
              failure ??
              (agent?.status === "idle"
                ? "The agent is ready. It will be sent as soon as you confirm."
                : "It is sent once you confirm and the agent's prompt is free.")}
          </p>
          {gone !== undefined || failure !== undefined ? (
            <p className="picker-note picker-note-failure" role="alert">
              {gone ?? failure}
            </p>
          ) : null}
          <div className="picker-actions">
            <span />
            <div className="injection-review-buttons">
              <button
                type="button"
                className="mac-button"
                disabled={busy}
                onClick={cancel}
              >
                {gone === undefined ? "Cancel" : "Close"}
              </button>
              <button
                type="button"
                className="mac-button default"
                disabled={
                  busy || gone !== undefined || value.trim().length === 0
                }
                onClick={() => {
                  void send();
                }}
              >
                {busy ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
