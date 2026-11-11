/**
 * The orchestrator's memos and the work its agents did, on the board
 * (`docs/orchestrator.md`, "Memos" and "Resuming the agent that did the
 * work"): read-only, for the person.
 *
 * - **作業** — a lane after 待機中: each subject with a memo, or whose agent
 *   is stopped and can be brought back (`agent resume <subject>`). Its card
 *   says the subject, its agent (open, or stopped and when, resumable or
 *   not) and the memo's latest line; clicking it opens the memo in place,
 *   drawn by the conversation's Markdown renderer.
 * - **An escalation's memos** — under its thread: the memo of the
 *   escalation itself, of the items it links, and of its agents' work.
 */

import { useState } from "react";
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

/** The memos an escalation is about: its own, its items', its agents' work's. */
export function escalationMemos(
  escalation: EscalationWire,
  board: OrchestratorBoardWire,
): readonly OrchestratorMemoWire[] {
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
  const seen = new Set<string>();
  return keys.flatMap((key) => {
    if (seen.has(key)) return [];
    seen.add(key);
    const memo = memos.find((one) => one.subject === key);
    return memo === undefined ? [] : [memo];
  });
}

/** One memo, whole: each entry under its time and author. */
export function MemoView({
  memo,
  agentId,
  cwd,
  now,
  span,
}: {
  readonly memo: OrchestratorMemoWire;
  readonly agentId: string | undefined;
  readonly cwd: string | undefined;
  readonly now: number;
  readonly span: (ms: number) => string;
}) {
  return (
    <div className="orchestrator-memo" data-memo-subject={memo.subject}>
      {memo.entries.map((entry, index) => (
        <article
          key={`${String(entry.at)}-${String(index)}`}
          className="orchestrator-memo-entry"
        >
          <div className="orchestrator-entry-byline">
            {entry.by ?? "Orchestrator"}
            <span className="orchestrator-entry-time">
              {clock(entry.at)} · {span(now - entry.at)} ago
            </span>
          </div>
          <div className="orchestrator-entry-body">
            <RichText source={entry.text} agentId={agentId} cwd={cwd} />
          </div>
        </article>
      ))}
    </div>
  );
}

/** Under an escalation's thread: the memos it is about. */
export function EscalationMemos({
  memos,
  agentId,
  cwd,
  now,
  span,
}: {
  readonly memos: readonly OrchestratorMemoWire[];
  readonly agentId: string | undefined;
  readonly cwd: string | undefined;
  readonly now: number;
  readonly span: (ms: number) => string;
}) {
  if (memos.length === 0) return null;
  return (
    <section className="orchestrator-memos" aria-label="メモ">
      {memos.map((memo) => (
        <div key={memo.subject} className="orchestrator-memos-one">
          <h3 className="orchestrator-memos-heading">
            メモ{" "}
            <span className="orchestrator-memos-subject">{memo.token}</span>
          </h3>
          <MemoView
            memo={memo}
            agentId={agentId}
            cwd={cwd}
            now={now}
            span={span}
          />
        </div>
      ))}
    </section>
  );
}

/** A subject the 作業 lane lists: its work, its memo, or both. */
export interface WorkItem {
  readonly subject: string;
  readonly token: string;
  readonly work?: OrchestratorWorkWire;
  readonly memo?: OrchestratorMemoWire;
}

/**
 * The 作業 lane's cards: every subject with a memo, and every subject whose
 * last agent is stopped and resumable, most recently touched first.
 */
export function workItems(board: OrchestratorBoardWire): readonly WorkItem[] {
  const items = new Map<string, WorkItem & { at: number }>();
  for (const memo of board.memos ?? [])
    items.set(memo.subject, {
      subject: memo.subject,
      token: memo.token,
      memo,
      at: memo.updatedAt,
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
  const [open, setOpen] = useState(false);
  const last = item.work?.agents.at(-1);
  const latest = item.memo?.entries.at(-1);
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
      <button
        type="button"
        className="orchestrator-card orchestrator-work-card"
        data-work-subject={item.subject}
        aria-expanded={item.memo === undefined ? undefined : open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span className="orchestrator-card-head">
          <span className="orchestrator-card-title">{item.token}</span>
          {latest === undefined ? null : (
            <span className="orchestrator-card-age">
              メモ {span(now - latest.at)}前
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
        {latest === undefined || open ? null : (
          <span className="orchestrator-card-preview">
            {latest.text.replace(/^#+\s*/gmu, "").replace(/\s+/gu, " ")}
          </span>
        )}
      </button>
      {open && item.memo !== undefined ? (
        <div className="orchestrator-work-memo">
          <MemoView
            memo={item.memo}
            agentId={agentId}
            cwd={cwd}
            now={now}
            span={span}
          />
        </div>
      ) : null}
    </li>
  );
}

function clock(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
