/**
 * An escalation's notes.
 *
 * A note (`kind`, see `model/escalations.ts`) is a quiet system line in the
 * thread, not anybody's answer: an agent went working (`direct`, `resumed`,
 * with a chip to the agent — what was said is in its conversation), the
 * orchestrator parked it in 対応中 (`held`), with its optional note, or —
 * in an old thread — it was moved there by a 対応中にする the window no
 * longer has (`taken`).
 */

import type {
  BoardAgentRefWire,
  EscalationEntryWire,
} from "../../ipc/contract";

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
      return { before: `対応中になりました（${time}）${with_}`, after: "" };
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
