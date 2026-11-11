/**
 * The orchestrator's memos and the work its agents did, on the board
 * (`docs/orchestrator.md`, "Memos" and "Resuming the agent that did the
 * work"): read-only, for the person.
 *
 * - **作業** — a lane after 待機中: each subject with a note, or whose agent
 *   is stopped and can be brought back (`agent resume <subject>`). Its card
 *   says the subject, its agent (open, or stopped and when, resumable or
 *   not) and the note — what the orchestrator means to do next — whole.
 * - **An escalation's note** — under its thread: the note of the
 *   escalation itself, else of the first item it links, else of its agents'
 *   work.
 */

import type {
  EscalationWire,
  OrchestratorBoardWire,
  OrchestratorMemoWire,
  OrchestratorWorkWire,
} from "../../ipc/contract";
import { RichText } from "./orchestratorRichText";

/** The key of the item a URL names (`item owner/repo#n`), as main keys it. */
export function itemKeyOfUrl(url: string): string | undefined {
  const match =
    /^https?:\/\/[^/]+\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/iu.exec(
      url.trim(),
    );
  return match === null
    ? undefined
    : `item ${match[1]!}/${match[2]!}#${match[3]!}`.toLowerCase();
}

/** The note an escalation shows: its own, its items', its agents' work's. */
export function escalationMemo(
  escalation: EscalationWire,
  board: OrchestratorBoardWire,
): OrchestratorMemoWire | undefined {
  const memos = board.memos ?? [];
  const keys: string[] = [`esc ${String(escalation.id)}`];
  for (const link of escalation.links) {
    const key = itemKeyOfUrl(link);
    if (key !== undefined) keys.push(key);
  }
  for (const agent of escalation.agents) {
    const work = (board.work ?? []).find((one) =>
      one.agents.some((each) => each.agentId === agent.agentId),
    );
    keys.push(work?.subject ?? `agent ${agent.agentId}`);
  }
  for (const key of keys) {
    const memo = memos.find((one) => one.subject === key);
    if (memo !== undefined) return memo;
  }
  return undefined;
}

/** A note: light Markdown, read-only. */
export function MemoView({
  memo,
  agentId,
  cwd,
}: {
  readonly memo: OrchestratorMemoWire;
  readonly agentId: string | undefined;
  readonly cwd: string | undefined;
}) {
  return (
    <div className="orchestrator-memo" data-memo-subject={memo.subject}>
      <RichText source={memo.text} agentId={agentId} cwd={cwd} />
    </div>
  );
}

/** Under an escalation's thread: the note that goes with it. */
export function EscalationMemo({
  memo,
  agentId,
  cwd,
  now,
  span,
}: {
  readonly memo: OrchestratorMemoWire | undefined;
  readonly agentId: string | undefined;
  readonly cwd: string | undefined;
  readonly now: number;
  readonly span: (ms: number) => string;
}) {
  if (memo === undefined) return null;
  return (
    <section className="orchestrator-memos" aria-label="メモ">
      <h3 className="orchestrator-memos-heading">
        メモ <span className="orchestrator-memos-subject">{memo.token}</span>
        <span className="orchestrator-entry-time">
          {clock(memo.at)} · {span(now - memo.at)}前
        </span>
      </h3>
      <MemoView memo={memo} agentId={agentId} cwd={cwd} />
    </section>
  );
}

/** A subject the 作業 lane lists: its work, its note, or both. */
export interface WorkItem {
  readonly subject: string;
  readonly token: string;
  readonly work?: OrchestratorWorkWire;
  readonly memo?: OrchestratorMemoWire;
}

/**
 * The 作業 lane's cards: every subject with a note, and every subject whose
 * last agent is stopped and resumable, most recently touched first.
 */
export function workItems(board: OrchestratorBoardWire): readonly WorkItem[] {
  const items = new Map<string, WorkItem & { at: number }>();
  for (const memo of board.memos ?? [])
    items.set(memo.subject, {
      subject: memo.subject,
      token: memo.token,
      memo,
      at: memo.at,
    });
  for (const work of board.work ?? []) {
    const last = work.agents.at(-1);
    const memo = items.get(work.subject);
    if (last === undefined || (!last.resumable && memo === undefined)) continue;
    items.set(work.subject, {
      subject: work.subject,
      token: work.token,
      work,
      ...(memo?.memo === undefined ? {} : { memo: memo.memo }),
      at: Math.max(memo?.at ?? 0, last.stoppedAt ?? 0),
    });
  }
  return [...items.values()].sort((a, b) => b.at - a.at);
}

export function WorkCard({
  item,
  now,
  span,
  agentId,
  cwd,
}: {
  readonly item: WorkItem;
  readonly now: number;
  readonly span: (ms: number) => string;
  readonly agentId: string | undefined;
  readonly cwd: string | undefined;
}) {
  const last = item.work?.agents.at(-1);
  const memo = item.memo;
  const state =
    last === undefined
      ? undefined
      : last.live
        ? "実行中"
        : last.resumable
          ? `停止 ${last.stoppedAt === undefined ? "" : `${span(now - last.stoppedAt)}前`} · 再開できる`
          : "停止 · 再開できない";
  return (
    <li>
      <div
        className="orchestrator-card orchestrator-work-card"
        data-work-subject={item.subject}
      >
        <span className="orchestrator-card-head">
          <span className="orchestrator-card-title">{item.token}</span>
          {memo === undefined ? null : (
            <span
              className="orchestrator-card-age"
              title={`メモ ${clock(memo.at)}`}
            >
              メモ {span(now - memo.at)}前
            </span>
          )}
        </span>
        {last === undefined ? null : (
          <span className="orchestrator-card-meta">
            <span className="orchestrator-chip is-agent">{last.name}</span>
            <span
              className="orchestrator-chip"
              data-resumable={last.resumable ? "true" : undefined}
            >
              {state}
            </span>
            {last.machine === "local" ? null : (
              <span className="orchestrator-chip">{last.machine.slice(4)}</span>
            )}
          </span>
        )}
        {memo === undefined ? null : (
          <div className="orchestrator-work-memo">
            <MemoView memo={memo} agentId={agentId} cwd={cwd} />
          </div>
        )}
      </div>
    </li>
  );
}

function clock(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
