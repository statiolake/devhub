/**
 * An escalation's notes and the person's 対応中にする.
 *
 * A note (`kind`, see `model/escalations.ts`) is a quiet system line in the
 * thread, not anybody's answer: an agent went working (`direct`, `resumed`,
 * with a chip to the agent — what was said is in its conversation), the
 * person moved it to 対応中 (`taken`), or the orchestrator parked it there
 * (`held`), with their optional note.
 *
 * `TakeEscalation` is the person's 対応中にする on a 要回答 one: a small
 * button, then an optional one-line note and a confirm.
 */

import { useState } from "react";
import type {
  BoardAgentRefWire,
  EscalationEntryWire,
} from "../../ipc/contract";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";

export type NoteKind = NonNullable<EscalationEntryWire["kind"]>;

/** `14:05`: the clock time a note gives. */
export function noteTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The note's words: before the agent's chip and after it (`direct`,
 * `resumed`), or the whole line (`taken`, `held`: `before`, with the note).
 */
export function noteWords(
  kind: NoteKind,
  at: number,
  note = "",
): { readonly before: string; readonly after: string } {
  const time = noteTime(at);
  const with_ = note === "" ? "" : `: ${note}`;
  switch (kind) {
    case "direct":
      return {
        before: "人が ",
        after: ` と直接やりとりしました（${time}）— 内容はエージェントの会話を参照`,
      };
    case "resumed":
      return {
        before: "",
        after: ` が作業を再開しました（${time}）— 回答待ちは一旦解除`,
      };
    case "taken":
      return { before: `人が対応中にしました（${time}）${with_}`, after: "" };
    case "held":
      return {
        before: `オーケストレーターが対応中にしました（${time}）${with_}`,
        after: "",
      };
  }
}

export function EscalationNote({
  entry,
  agents,
  onFocusAgent,
}: {
  readonly entry: EscalationEntryWire & { readonly kind: NoteKind };
  readonly agents: readonly BoardAgentRefWire[];
  readonly onFocusAgent: (agentId: string) => void;
}) {
  const words = noteWords(entry.kind, entry.at, entry.markdown);
  const agentId = entry.agent;
  const agent = agents.find((one) => one.agentId === agentId);
  return (
    <div className="orchestrator-entry-note" data-kind={entry.kind} role="note">
      {words.before}
      {agentId === undefined ? null : (
        <button
          type="button"
          className="orchestrator-chip is-agent is-link"
          disabled={agent?.name === undefined}
          title={
            agent?.name === undefined
              ? "This agent is gone"
              : `Show ${agent.name} — its conversation`
          }
          onClick={() => {
            onFocusAgent(agentId);
          }}
        >
          {agent?.name ?? agentId.slice(0, 8)}
        </button>
      )}
      {words.after}
    </div>
  );
}

/** 対応中にする: to 対応中 without an answer, with an optional note. */
export function TakeEscalation({ id }: { readonly id: number }) {
  const { reportFailure } = useAgents();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const take = () => {
    if (sending) return;
    setSending(true);
    void devhub()
      .takeEscalation(id, note.trim())
      .then(() => {
        setOpen(false);
        setNote("");
      }, reportFailure)
      .finally(() => {
        setSending(false);
      });
  };
  if (!open)
    return (
      <button
        type="button"
        className="orchestrator-take"
        data-escalation-take={id}
        onClick={() => {
          setOpen(true);
        }}
      >
        対応中にする
      </button>
    );
  return (
    <form
      className="orchestrator-take-form"
      onSubmit={(event) => {
        event.preventDefault();
        take();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <input
        type="text"
        autoFocus
        aria-label="メモ (任意)"
        placeholder="メモ (任意)"
        maxLength={2000}
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
        }}
      />
      <button type="submit" className="orchestrator-take" disabled={sending}>
        対応中にする
      </button>
      <button
        type="button"
        className="orchestrator-take is-quiet"
        onClick={() => {
          setOpen(false);
        }}
      >
        やめる
      </button>
    </form>
  );
}
