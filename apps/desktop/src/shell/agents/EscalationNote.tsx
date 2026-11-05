/**
 * An escalation's notes.
 *
 * A note (`kind`, see `model/escalations.ts`) is a quiet system line in the
 * thread, not anybody's answer: an agent went working (`direct`, `resumed`,
 * with a chip to the agent — what was said is in its conversation), the
 * orchestrator parked it in 対応中 (`held`), with its optional note — or,
 * on one already there, noted where the work stands — or —
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

/** `11/10 09:00`: a wait's time, as a card and a note give it. */
export function dueText(at: number): string {
  const date = new Date(at);
  return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${noteTime(at)}`;
}

/**
 * Whether the thread was in 対応中 just before `index`: anything but the
 * orchestrator's question or a wait leaves it there (`escalationState`).
 */
export function inProgressBefore(
  entries: readonly EscalationEntryWire[],
  index: number,
): boolean {
  const previous = entries[index - 1];
  if (previous === undefined) return false;
  if (previous.kind === "wait") return false;
  return !(previous.kind === undefined && previous.role === "orchestrator");
}

/**
 * The note's words: before the agent's chip and after it (`direct`,
 * `resumed`), or the whole line (`taken`, `held`: `before`, with the note).
 * A `held` one on a thread already in 対応中 (`alreadyInProgress`) moved
 * nothing: it is the orchestrator's note of where the work stands.
 */
export function noteWords(
  kind: NoteKind,
  at: number,
  note = "",
  dueAt?: number,
  alreadyInProgress = false,
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
        before: alreadyInProgress
          ? `オーケストレーターのメモ（${time}）${with_}`
          : `オーケストレーターが対応中にしました（${time}）${with_}`,
        after: "",
      };
    case "wait":
      return {
        before: `オーケストレーターが待機中にしました（${time}）${with_}${dueAt === undefined ? "" : `（${dueText(dueAt)} まで）`}`,
        after: "",
      };
  }
}

export function EscalationNote({
  entry,
  agents,
  onFocusAgent,
  alreadyInProgress = false,
}: {
  readonly entry: EscalationEntryWire & { readonly kind: NoteKind };
  /** See `noteWords`. */
  readonly alreadyInProgress?: boolean;
  readonly agents: readonly BoardAgentRefWire[];
  readonly onFocusAgent: (agentId: string) => void;
}) {
  const words = noteWords(
    entry.kind,
    entry.at,
    entry.markdown,
    entry.dueAt,
    alreadyInProgress,
  );
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
