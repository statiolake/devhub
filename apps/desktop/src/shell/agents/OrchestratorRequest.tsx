/**
 * The board header's +: a request to the orchestrator, in the person's
 * words (`main/orchestrator/requests.ts`, `docs/orchestrator.md`,
 * "Requests"). A click on +, or `Cmd+Q +` ("Orchestrator: New Request…" in
 * the palette), opens a small composer under the header — the conversation
 * composer's box — that sends with ⌘Return (or its button) and closes with
 * Esc, giving the keyboard back to the +. Sent, the request is on the
 * board's 依頼 lane at once, and goes to the orchestrator as the person's
 * own message (held only while the mode is off).
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { OrchestratorRequestWire } from "../../ipc/contract";
import { devhub } from "./client";

export function RequestButton({
  onSend,
}: {
  readonly onSend: (text: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const button = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // `Cmd+Q +` from anywhere: main has shown the screen; the composer opens.
  useEffect(() => {
    const subscribe = devhub().onOpenOrchestratorRequest;
    if (typeof subscribe !== "function") return undefined;
    return subscribe(() => {
      setOpen(true);
    });
  }, []);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    setFailure(undefined);
    button.current?.focus();
  };
  const send = () => {
    const words = text.trim();
    if (words === "" || sending) return;
    setSending(true);
    setFailure(undefined);
    onSend(words)
      .then(() => {
        setText("");
        setSending(false);
        close();
      })
      .catch((error: unknown) => {
        setSending(false);
        setFailure(error instanceof Error ? error.message : String(error));
      });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  };
  return (
    <span className="orchestrator-request-wrap">
      <button
        ref={button}
        type="button"
        className="orchestrator-request-button"
        aria-label="New request to the orchestrator"
        title="New request to the orchestrator (⌘Q +)"
        aria-expanded={open}
        aria-controls="orchestrator-request-composer"
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 2v8M2 6h8" />
        </svg>
      </button>
      {open ? (
        <div
          id="orchestrator-request-composer"
          className="orchestrator-request-composer"
          role="dialog"
          aria-label="New request"
        >
          <p className="orchestrator-request-hint">
            オーケストレーターへの依頼。タスクとして登録されるまで、ボードの「依頼」に出ます。
          </p>
          <div className="conversation-composer-box orchestrator-request-box">
            <textarea
              ref={field}
              className="conversation-composer-input orchestrator-request-input"
              aria-label="Request"
              placeholder="例: 請求書 CSV の文字化けを調べて直す"
              rows={3}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          {failure === undefined ? null : (
            <p className="orchestrator-composer-error" role="alert">
              {failure}
            </p>
          )}
          <div className="orchestrator-request-actions">
            <span className="orchestrator-request-keys">
              ⌘Return で送信 · Esc で閉じる
            </span>
            <button
              type="button"
              className="orchestrator-request-cancel"
              onClick={close}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="orchestrator-request-send"
              disabled={text.trim() === "" || sending}
              onClick={send}
            >
              送信
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

const STATE_WORDS: Record<OrchestratorRequestWire["state"], string> = {
  held: "送信待ち",
  sent: "受付待ち",
  filed: "登録済み",
};

/** One request on the board's 依頼 lane: its words, its state, where it went. */
export function RequestCard({
  request,
  age,
}: {
  readonly request: OrchestratorRequestWire;
  readonly age: string;
}) {
  return (
    <li>
      <div
        className="orchestrator-card orchestrator-request-card"
        data-request-id={request.id}
        data-state={request.state}
      >
        <span className="orchestrator-card-head">
          <span className="orchestrator-card-id">req {request.id}</span>
          <span className="orchestrator-card-title">{request.text}</span>
          <span className="orchestrator-card-age">{age}</span>
        </span>
        <span className="orchestrator-card-meta">
          <span className="orchestrator-chip orchestrator-request-state">
            {STATE_WORDS[request.state]}
          </span>
          {request.priority === "high" ? (
            <span className="orchestrator-chip is-followup">優先</span>
          ) : null}
          {request.filed?.note === undefined ? null : (
            <span className="orchestrator-request-note">
              {request.filed.note}
            </span>
          )}
        </span>
      </div>
    </li>
  );
}
