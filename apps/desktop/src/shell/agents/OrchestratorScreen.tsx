/**
 * The Orchestrator screen's left half: two tabs, ボード (the board, and an
 * escalation opened on it) and ファイル (the orchestrator's folder,
 * `OrchestratorFiles.tsx`), each a navigation stack (`navStack.ts`).
 *
 * The right half is the orchestrator agent's own pane — an ordinary Agent
 * pane from the pool (`AgentPane`), so its conversation is exactly the one
 * every GUI Agent has. This is drawn beside it, in the same view: the
 * Orchestrator row lays the Agents view over the whole content area, and the
 * page divides it (`AgentsApp`).
 *
 * The board reads `OrchestratorBoardWire` and writes one thing: the person's
 * answer (`answerEscalation`), the only door an answer has. An escalation's
 * thread is drawn with the conversation's own Markdown renderer — code,
 * math, Mermaid, SVG — so what the orchestrator wrote looks the way it would
 * in a chat answer. See `docs/orchestrator.md`.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  EscalationWire,
  OrchestratorBoardWire,
  UnaccountedAgentWire,
} from "../../ipc/contract";
import type { AgentStatus, AppSnapshot } from "../../ipc/appShell";
import { useMessageKeys, SEND_KEY } from "../conversation/messageKeys";
import { SendIcon } from "../conversation/icons";
import { StatusMark } from "../components/sidebar/StatusMark";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";
import { historyDirectionOfButton } from "../historyButtons";
import { focusIsOurs, reducedMotion, useNavStack } from "./navStack";
import { RichText } from "./orchestratorRichText";
import { FilesPage } from "./OrchestratorFiles";
import { EscalationNote, TakeEscalation } from "./EscalationNote";

/** `45s`, `12m`, `3h`, `2d`. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`;
  if (seconds < 172800) return `${String(Math.floor(seconds / 3600))}h`;
  return `${String(Math.floor(seconds / 86400))}d`;
}

/** The clock the ages are drawn against, ticking every half minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

/** The first line of prose in a Markdown body, for a card's preview. */
export function preview(markdown: string): string {
  const prose = markdown
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/\$\$[\s\S]*?\$\$/gu, " ")
    .split("\n")
    // A heading names a section; the preview is what the section says.
    .filter((line) => !/^\s*#/u.test(line) && !/^\s*\|/u.test(line))
    .map((line) => line.replace(/^\s*(?:[-*>]|\d+\.)\s+/u, "").trim())
    .filter((line) => line.length > 0);
  return (prose[0] ?? "").replace(/[*_`]/gu, "");
}

// --- the board ----------------------------------------------------------------

export { NAV_MS } from "./navStack";

/** The left pane's two tabs; the board is the default. */
export type BoardTab = "board" | "files";

const TAB_KEY = "devhub.orchestrator.tab";

/** The tab chosen in this session, kept across a reload of the page. */
function rememberedTab(): BoardTab {
  try {
    return window.sessionStorage.getItem(TAB_KEY) === "files"
      ? "files"
      : "board";
  } catch {
    return "board";
  }
}

/** What a tab answers of the mouse's side buttons; false leaves it be. */
export type SideButtons = (direction: "back" | "forward") => boolean;

export function OrchestratorBoard({
  snapshot,
}: {
  readonly snapshot: AppSnapshot;
}) {
  const { board, reportFailure } = useAgents();
  const [tab, setTab] = useState<BoardTab>(rememberedTab);
  const [history, setHistory] = useState(false);
  // Something in the folder changed while the Files tab was not looked at.
  const [filesChanged, setFilesChanged] = useState(false);
  const section = useRef<HTMLElement>(null);
  const sideButtons = useRef<SideButtons>(() => false);
  const choose = useCallback((next: BoardTab) => {
    setTab(next);
    if (next === "files") setFilesChanged(false);
    try {
      window.sessionStorage.setItem(TAB_KEY, next);
    } catch {
      // Remembering is a convenience.
    }
  }, []);
  useEffect(() => {
    if (tab === "files") return;
    const files = devhub().onOrchestratorFilesChanged;
    if (typeof files !== "function") return;
    return files(() => {
      setFilesChanged(true);
    });
  }, [tab]);
  // The mouse's side buttons over the left pane: Back goes back as Esc
  // does, Forward opens again what Back left. Only what a tab answers is
  // kept from the page's own handler (`historyButtons.ts`, the app's
  // history); anything else — Back on the board itself — is left to it.
  // Over the orchestrator's pane on the right they are the app's.
  useEffect(() => {
    const element = section.current;
    if (!element) return;
    // The default is cancelled on every phase, as the page's handler does,
    // so Chromium never takes the buttons as the document's Back/Forward.
    const claim = (event: MouseEvent) => {
      if (historyDirectionOfButton(event.button) === undefined) return;
      event.preventDefault();
    };
    const onUp = (event: MouseEvent) => {
      const direction = historyDirectionOfButton(event.button);
      if (direction === undefined) return;
      event.preventDefault();
      if (sideButtons.current(direction)) event.stopPropagation();
    };
    element.addEventListener("mousedown", claim);
    element.addEventListener("auxclick", claim);
    element.addEventListener("mouseup", onUp);
    return () => {
      element.removeEventListener("mousedown", claim);
      element.removeEventListener("auxclick", claim);
      element.removeEventListener("mouseup", onUp);
    };
  }, []);
  const orchestrator = snapshot.workspaces
    .flatMap((workspace) => workspace.agents)
    .find((agent) => agent.id === board.orchestratorAgentId);
  return (
    <section
      ref={section}
      className="orchestrator-board"
      aria-label="Orchestrator board"
    >
      <header className="orchestrator-board-header">
        <div className="orchestrator-board-title">
          <div
            className="orchestrator-tabs"
            role="tablist"
            aria-label="Orchestrator"
          >
            <button
              type="button"
              role="tab"
              id="orchestrator-tab-board"
              className="orchestrator-tab"
              aria-selected={tab === "board"}
              aria-controls="orchestrator-panel-board"
              onClick={() => {
                choose("board");
              }}
            >
              ボード
            </button>
            <button
              type="button"
              role="tab"
              id="orchestrator-tab-files"
              className="orchestrator-tab"
              aria-selected={tab === "files"}
              aria-controls="orchestrator-panel-files"
              onClick={() => {
                choose("files");
              }}
            >
              ファイル
              {filesChanged ? (
                <span
                  className="orchestrator-tab-dot"
                  role="status"
                  aria-label="changed"
                />
              ) : null}
            </button>
          </div>
          {tab === "board" ? (
            <span className="orchestrator-board-counts">
              {board.needsAnswer.length} 要回答 · {board.inProgress.length}{" "}
              対応中
              {board.unaccounted.length > 0
                ? ` · ${String(board.unaccounted.length)} 不明`
                : ""}
            </span>
          ) : null}
        </div>
        <div className="orchestrator-board-tools">
          <button
            type="button"
            className="orchestrator-pause"
            role="switch"
            aria-checked={!board.paused}
            disabled={orchestrator === undefined}
            title={
              board.paused
                ? "Events are held for the orchestrator. Resume delivers them, in order."
                : "Each event (an answer, an unaccounted agent, GitHub, an agent's turn, a timer) is sent to the orchestrator. Pause holds them."
            }
            onClick={() => {
              void devhub()
                .setOrchestratorPaused(!board.paused)
                .catch(reportFailure);
            }}
          >
            <span className="orchestrator-pause-track" aria-hidden="true">
              <span className="orchestrator-pause-knob" />
            </span>
            {board.paused ? "Events paused" : "Events on"}
          </button>
          {board.held > 0 ? (
            <span
              className="orchestrator-pending"
              title={
                board.paused
                  ? "Events held by the pause. Resume delivers them as one message."
                  : "Events waiting for the orchestrator's turn to end. They go out together, as one message."
              }
            >
              {board.held} pending
            </span>
          ) : null}
          <span
            className="orchestrator-github"
            data-state={board.github.state}
            title={
              board.github.state === "active"
                ? `GitHub polling is active${board.github.problem === undefined ? "" : `: ${board.github.problem}`}`
                : board.github.state === "suspended"
                  ? "GitHub polling is suspended while events are paused: no requests are made. Resume polls once and reports what changed."
                  : board.orchestratorAgentId === undefined
                    ? "GitHub polling is idle: no orchestrator is running."
                    : "GitHub polling is idle: [orchestrator.github] projects names no board."
            }
          >
            GitHub{" "}
            {board.github.state === "active"
              ? "polling"
              : board.github.state === "suspended"
                ? "suspended"
                : "idle"}
          </span>
          {tab === "board" ? (
            <button
              type="button"
              className="orchestrator-history"
              aria-pressed={history}
              onClick={() => {
                setHistory((value) => !value);
              }}
            >
              Closed {board.closed.length > 0 ? board.closed.length : ""}
            </button>
          ) : null}
        </div>
      </header>
      {tab === "board" ? (
        <BoardPage pane={section} history={history} sideButtons={sideButtons} />
      ) : (
        <FilesPage
          pane={section}
          sideButtons={sideButtons}
          orchestratorAgentId={board.orchestratorAgentId}
        />
      )}
    </section>
  );
}

/**
 * 要回答 re-ranked: its cards glide from where they were to where they are
 * now (transform only, ~200 ms), instead of jumping. Nothing moves under
 * Reduce Motion, or where the Web Animations API is missing.
 */
function useReorderGlide(
  lanes: RefObject<HTMLDivElement | null>,
  needsAnswer: readonly EscalationWire[],
): void {
  const before = useRef(new Map<number, number>());
  const order = needsAnswer.map((one) => one.id).join(",");
  const last = useRef(order);
  useLayoutEffect(() => {
    const lane = lanes.current?.querySelector('[data-tone="ask"]');
    const cards = [
      ...(lane?.querySelectorAll<HTMLElement>("[data-escalation-id]") ?? []),
    ];
    const now = new Map(
      cards.map((card) => [
        Number(card.dataset["escalationId"]),
        card.getBoundingClientRect().top,
      ]),
    );
    const moved = last.current !== order;
    last.current = order;
    const was = before.current;
    before.current = now;
    if (!moved || reducedMotion()) return;
    for (const card of cards) {
      const id = Number(card.dataset["escalationId"]);
      const from = was.get(id);
      const to = now.get(id);
      if (from === undefined || to === undefined || from === to) continue;
      if (typeof card.animate !== "function") continue;
      card.animate(
        [
          { transform: `translateY(${String(from - to)}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
  }, [lanes, order]);
}

/** The board tab: the lanes, and an escalation pushed over them. */
function BoardPage({
  pane,
  history,
  sideButtons,
}: {
  readonly pane: RefObject<HTMLElement | null>;
  readonly history: boolean;
  readonly sideButtons: RefObject<SideButtons>;
}) {
  const { board, dispatch } = useAgents();
  const now = useNow();
  const lanes = useRef<HTMLDivElement>(null);
  const stack = useNavStack<EscalationWire>(pane, (escalation) =>
    lanes.current?.querySelector<HTMLElement>(
      `[data-escalation-id="${String(escalation.id)}"]`,
    ),
  );
  const { nav, shown, forward, open: openCard, close } = stack;
  const all = useMemo(
    () => [...board.needsAnswer, ...board.inProgress, ...board.closed],
    [board],
  );
  // The escalation on the page over, as it was when it was opened; the
  // board's own copy of it is read live. It stays through a pop, so the
  // view slides out with what it showed.
  const live =
    shown === undefined ? undefined : all.find((one) => one.id === shown.id);
  const open = live ?? shown;
  useEffect(() => {
    sideButtons.current = (direction) => {
      if (direction === "back" && nav === "push") {
        close();
        return true;
      }
      if (direction === "forward" && nav !== "push" && forward !== undefined) {
        const again = all.find((one) => one.id === forward.id);
        if (again === undefined) return false;
        openCard(again);
        return true;
      }
      return false;
    };
  }, [sideButtons, nav, forward, all, close, openCard]);
  // An escalation that leaves the board while it is read closes, as before.
  useEffect(() => {
    if (nav === "push" && shown !== undefined && live === undefined) close();
  }, [nav, shown, live, close]);
  // Jumping to an agent is a deliberate move: a place in Back and Forward
  // at once, so prefix+h comes back here (`NavigationReason`).
  const focusAgent = useCallback(
    (agentId: string) => {
      void dispatch({
        type: "select_context",
        context: { kind: "agent", agentId },
        reason: "explicit",
      });
    },
    [dispatch],
  );
  useReorderGlide(lanes, board.needsAnswer);
  // Answered: back to the board, as Esc goes, with focus on what is next
  // in 要回答 — the card after this one in its order, else the first left —
  // or, with none left, on this one, now in 対応中.
  const answered = useCallback(
    (id: number) => {
      const rest = board.needsAnswer.filter((one) => one.id !== id);
      const at = board.needsAnswer.findIndex((one) => one.id === id);
      const next =
        rest.length === 0
          ? all.find((one) => one.id === id)
          : (rest[Math.max(0, at)] ?? rest[0]);
      close(next);
    },
    [board.needsAnswer, all, close],
  );
  const reading = nav === "push";
  return (
    <div
      className="orchestrator-stage"
      data-nav={nav}
      role="tabpanel"
      id="orchestrator-panel-board"
      aria-labelledby="orchestrator-tab-board"
    >
      <div
        ref={lanes}
        className="orchestrator-lanes orchestrator-layer"
        data-layer="under"
        inert={reading}
        aria-hidden={reading ? true : undefined}
      >
        <Lane
          title="要回答"
          hint="Needs your answer: the orchestrator cannot go on without it. Oldest first."
          tone="ask"
          count={board.needsAnswer.length}
          empty="Nothing is waiting for you."
        >
          {board.needsAnswer.map((one) => (
            <EscalationCard
              key={one.id}
              escalation={one}
              now={now}
              onOpen={() => {
                openCard(one);
              }}
            />
          ))}
        </Lane>
        <Lane
          title="対応中"
          hint="In progress: you answered, and the orchestrator is carrying it out."
          tone="progress"
          count={board.inProgress.length}
          empty="Nothing in progress."
        >
          {board.inProgress.map((one) => (
            <EscalationCard
              key={one.id}
              escalation={one}
              now={now}
              onOpen={() => {
                openCard(one);
              }}
            />
          ))}
        </Lane>
        <Lane
          title="不明"
          hint={`Unaccounted: idle for over ${span(board.graceMs)} with no open escalation. Normally empty; the orchestrator is told about each.`}
          tone="unaccounted"
          count={board.unaccounted.length}
          empty="Every agent is accounted for."
        >
          {board.unaccounted.map((one) => (
            <UnaccountedRow
              key={one.agentId}
              agent={one}
              now={now}
              onFocus={() => {
                focusAgent(one.agentId);
              }}
            />
          ))}
        </Lane>
        {history ? (
          <Lane
            title="Closed"
            hint="Closed escalations, most recent first."
            tone="closed"
            count={board.closed.length}
            empty="Nothing closed yet."
          >
            {board.closed.map((one) => (
              <EscalationCard
                key={one.id}
                escalation={one}
                now={now}
                onOpen={() => {
                  openCard(one);
                }}
              />
            ))}
          </Lane>
        ) : null}
      </div>
      {open === undefined ? null : (
        <EscalationView
          key={open.id}
          escalation={open}
          now={now}
          leaving={!reading}
          orchestratorAgentId={board.orchestratorAgentId}
          onBack={() => {
            close();
          }}
          onAnswered={answered}
          onFocusAgent={focusAgent}
        />
      )}
    </div>
  );
}

function Lane({
  title,
  hint,
  tone,
  count,
  empty,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  readonly tone: "ask" | "progress" | "unaccounted" | "closed";
  readonly count: number;
  readonly empty: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="orchestrator-lane" data-tone={tone} aria-label={title}>
      <h2 className="orchestrator-lane-heading" title={hint}>
        <span className="orchestrator-lane-mark" aria-hidden="true" />
        <span className="orchestrator-lane-title">{title}</span>
        <span className="orchestrator-lane-count">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="orchestrator-lane-empty">{empty}</p>
      ) : (
        <ul className="orchestrator-cards">{children}</ul>
      )}
    </section>
  );
}

function EscalationCard({
  escalation,
  now,
  onOpen,
}: {
  readonly escalation: EscalationWire;
  readonly now: number;
  readonly onOpen: () => void;
}) {
  const last = escalation.entries.at(-1);
  const question = [...escalation.entries]
    .reverse()
    .find((entry) => entry.role === "orchestrator" && entry.kind === undefined);
  const age =
    escalation.state === "needs_answer"
      ? `${span(now - escalation.stateSince)}`
      : escalation.state === "in_progress"
        ? `answered ${span(now - escalation.stateSince)} ago`
        : `closed ${span(now - escalation.stateSince)} ago`;
  const open = escalation.state !== "closed";
  const followUp =
    escalation.state === "needs_answer" &&
    escalation.entries.some((entry) => entry.role === "human");
  return (
    <li>
      <button
        type="button"
        className="orchestrator-card"
        data-escalation-id={escalation.id}
        onClick={onOpen}
      >
        <span className="orchestrator-card-head">
          <span className="orchestrator-card-id">#{escalation.id}</span>
          <span className="orchestrator-card-title">{escalation.title}</span>
          <span className="orchestrator-card-age">{age}</span>
        </span>
        <span className="orchestrator-card-preview">
          {escalation.state === "in_progress" &&
          last?.role === "human" &&
          last.kind === undefined
            ? `↳ ${preview(last.markdown)}`
            : preview(question?.markdown ?? "")}
        </span>
        <span className="orchestrator-card-meta">
          {open && escalation.priority === "high" ? (
            <span className="orchestrator-chip is-priority" data-rank="high">
              優先
            </span>
          ) : null}
          {open && escalation.priority === "low" ? (
            <span className="orchestrator-chip is-priority" data-rank="low">
              低
            </span>
          ) : null}
          {open && escalation.effort === "quick" ? (
            <span className="orchestrator-chip is-quick">すぐ答えられる</span>
          ) : null}
          {followUp ? (
            <span className="orchestrator-chip is-followup">追加の質問</span>
          ) : null}
          {question?.options !== undefined &&
          escalation.state === "needs_answer" ? (
            <span className="orchestrator-chip">
              {question.options.length} options
            </span>
          ) : null}
          {escalation.agents.map((agent) => (
            <span key={agent.agentId} className="orchestrator-chip is-agent">
              {agent.name ?? agent.agentId.slice(0, 8)}
            </span>
          ))}
        </span>
        {open && escalation.rankNote !== undefined ? (
          <span className="orchestrator-card-why">{escalation.rankNote}</span>
        ) : null}
      </button>
      {escalation.state === "needs_answer" ? (
        <TakeEscalation id={escalation.id} />
      ) : null}
    </li>
  );
}

function UnaccountedRow({
  agent,
  now,
  onFocus,
}: {
  readonly agent: UnaccountedAgentWire;
  readonly now: number;
  readonly onFocus: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="orchestrator-card orchestrator-unaccounted-row"
        onClick={onFocus}
        title="Show this agent"
      >
        <span className="orchestrator-card-head">
          <span className="orchestrator-unaccounted-mark">
            <StatusMark status="idle" unread={undefined} />
          </span>
          <span className="orchestrator-card-title">{agent.name}</span>
          <span className="orchestrator-card-workspace">
            {agent.workspaceLabel}
          </span>
          <span className="orchestrator-card-age">
            idle {span(now - agent.idleSince)}
          </span>
        </span>
      </button>
    </li>
  );
}

// --- one escalation -------------------------------------------------------------

const STATE_LABEL: Record<EscalationWire["state"], string> = {
  needs_answer: "要回答",
  in_progress: "対応中",
  closed: "Closed",
};

function EscalationView({
  escalation,
  now,
  leaving,
  orchestratorAgentId,
  onBack,
  onAnswered,
  onFocusAgent,
}: {
  readonly escalation: EscalationWire;
  readonly now: number;
  /** Going back to the board: drawn while it slides out, and not used. */
  readonly leaving: boolean;
  readonly orchestratorAgentId: string | undefined;
  readonly onBack: () => void;
  /** The person's answer went out. */
  readonly onAnswered: (id: number) => void;
  readonly onFocusAgent: (agentId: string) => void;
}) {
  const pathsOn = escalation.agents[0]?.agentId ?? orchestratorAgentId;
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // A new entry is read from its start: the newest is at the bottom.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [escalation.entries.length]);
  // Opened: focus goes to the answer when one is asked for, else to the
  // thread — and only from inside the board, never from elsewhere.
  useEffect(() => {
    const element = root.current;
    if (
      !focusIsOurs(element?.closest<HTMLElement>(".orchestrator-board") ?? null)
    )
      return;
    const target =
      escalation.state === "needs_answer"
        ? (element?.querySelector("textarea") ?? scroller.current)
        : scroller.current;
    target?.focus({ preventScroll: true });
    // Once, when the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={root}
      className="orchestrator-reading orchestrator-layer"
      data-layer="over"
      inert={leaving}
      aria-hidden={leaving ? true : undefined}
      onKeyDown={(event) => {
        // Esc goes back; in the composer, only while nothing is written.
        if (
          event.key === "Escape" &&
          !(
            event.target instanceof HTMLTextAreaElement &&
            event.target.value !== ""
          )
        ) {
          event.preventDefault();
          onBack();
        }
      }}
    >
      <div className="orchestrator-reading-head">
        <button
          type="button"
          className="orchestrator-back"
          onClick={onBack}
          aria-label="Back to the board"
          title="Back to the board (Esc)"
        >
          <span aria-hidden="true">←</span> ボード
        </button>
        <div className="orchestrator-reading-title">
          <span className="orchestrator-card-id">#{escalation.id}</span>
          <h2>{escalation.title}</h2>
          <span className="orchestrator-state" data-state={escalation.state}>
            {STATE_LABEL[escalation.state]}
          </span>
          {escalation.state === "needs_answer" ? (
            <TakeEscalation id={escalation.id} />
          ) : null}
        </div>
        {escalation.agents.length > 0 || escalation.links.length > 0 ? (
          <div className="orchestrator-reading-refs">
            {escalation.agents.map((agent) => (
              <button
                key={agent.agentId}
                type="button"
                className="orchestrator-chip is-agent is-link"
                disabled={agent.name === undefined}
                title={
                  agent.name === undefined
                    ? "This agent is gone"
                    : `Show ${agent.name} — talk to it directly`
                }
                onClick={() => {
                  onFocusAgent(agent.agentId);
                }}
              >
                {agent.status === undefined ? null : (
                  <StatusMark
                    status={agent.status as AgentStatus}
                    unread={undefined}
                  />
                )}
                {agent.name ?? agent.agentId.slice(0, 8)}
                {agent.workspaceLabel === undefined ? null : (
                  <span className="orchestrator-chip-sub">
                    {agent.workspaceLabel}
                  </span>
                )}
              </button>
            ))}
            {escalation.links.map((link) => (
              <button
                key={link}
                type="button"
                className="orchestrator-chip is-link"
                title={link}
                onClick={() => {
                  void devhub().openExternalUrl(link);
                }}
              >
                {linkLabel(link)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div
        className="orchestrator-thread conversation-selectable"
        ref={scroller}
        tabIndex={-1}
        aria-label={`#${String(escalation.id)} ${escalation.title}`}
      >
        {escalation.entries.map((entry, index) =>
          entry.kind !== undefined ? (
            <EscalationNote
              key={`${String(entry.at)}-${String(index)}`}
              entry={{ ...entry, kind: entry.kind }}
              agents={escalation.agents}
              onFocusAgent={onFocusAgent}
            />
          ) : (
            <article
              key={`${String(entry.at)}-${String(index)}`}
              className="orchestrator-entry"
              data-role={entry.role}
            >
              <div className="orchestrator-entry-byline">
                {entry.role === "human"
                  ? "You"
                  : index === 0
                    ? "Orchestrator"
                    : "Orchestrator · follow-up"}
                <span className="orchestrator-entry-time">
                  {span(now - entry.at)} ago
                </span>
              </div>
              <div className="orchestrator-entry-body">
                <RichText source={entry.markdown} agentId={pathsOn} />
              </div>
            </article>
          ),
        )}
        {escalation.closed === undefined ? null : (
          <div className="orchestrator-closed-note">
            Closed {span(now - escalation.closed.at)} ago
            {escalation.closed.note === undefined
              ? ""
              : ` — ${escalation.closed.note}`}
          </div>
        )}
        {escalation.state === "in_progress" ? (
          <div className="orchestrator-closed-note">
            Answered. The orchestrator is carrying it out; a follow-up question
            would appear here.
          </div>
        ) : null}
      </div>
      {escalation.state === "closed" ? null : (
        <AnswerComposer escalation={escalation} onAnswered={onAnswered} />
      )}
    </div>
  );
}

function linkLabel(link: string): string {
  const github =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/u.exec(
      link,
    );
  if (github !== null)
    return `${github[3] === "pull" ? "PR" : "Issue"} ${github[2]}#${github[4]}`;
  try {
    return new URL(link).hostname;
  } catch {
    return link;
  }
}

/**
 * The person's answer: free Markdown, with the question's options as quick
 * replies. ⌘Return sends, as in the conversation's composer.
 */
function AnswerComposer({
  escalation,
  onAnswered,
}: {
  readonly escalation: EscalationWire;
  readonly onAnswered: (id: number) => void;
}) {
  const { reportFailure } = useAgents();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Why the last send did not go; the draft stays, and so does the view.
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  const last = escalation.entries.at(-1);
  const options =
    escalation.state === "needs_answer" && last?.role === "orchestrator"
      ? (last.options ?? [])
      : [];
  const send = useCallback(
    (words: string) => {
      if (words.trim() === "" || sending) return;
      setSending(true);
      setFailed(undefined);
      void devhub()
        .answerEscalation(escalation.id, words)
        .then(
          () => {
            setText("");
            onAnswered(escalation.id);
          },
          (error: unknown) => {
            setFailed(error instanceof Error ? error.message : String(error));
            reportFailure(error);
          },
        )
        .finally(() => {
          setSending(false);
        });
    },
    [escalation.id, reportFailure, sending, onAnswered],
  );
  const keys = useMessageKeys(() => {
    send(text);
  });
  // Grow with what is written, up to a third of the pane.
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${String(Math.min(field.scrollHeight, 220))}px`;
  }, [text]);
  return (
    <div className="orchestrator-composer conversation-composer">
      {options.length > 0 ? (
        <div className="orchestrator-options" aria-label="Quick replies">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="orchestrator-option"
              disabled={sending}
              onClick={() => {
                send(option);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {failed === undefined ? null : (
        <p className="orchestrator-composer-error" role="alert">
          The answer did not go out: {failed}
        </p>
      )}
      <div className="conversation-composer-box">
        <div className="conversation-composer-field">
          <textarea
            ref={input}
            className="conversation-composer-input"
            aria-label={`Your answer to #${String(escalation.id)}`}
            rows={2}
            value={text}
            placeholder={
              escalation.state === "in_progress"
                ? "Add to your answer…"
                : options.length > 0
                  ? "Choose above, or write your answer…"
                  : "Write your answer…"
            }
            onChange={(event) => {
              setText(event.target.value);
            }}
            {...keys}
          />
        </div>
        <div className="conversation-composer-toolbar">
          <span className="orchestrator-composer-hint">
            Markdown · {SEND_KEY} to send · the orchestrator relays it
          </span>
          <div className="conversation-composer-actions">
            <button
              type="button"
              className="conversation-send"
              aria-label="Send answer"
              title={`Send (${SEND_KEY})`}
              disabled={text.trim() === "" || sending}
              onClick={() => {
                send(text);
              }}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- no orchestrator yet --------------------------------------------------------

/** Where the orchestrator's pane goes while none is assigned. */
export function OrchestratorStart({
  board,
}: {
  readonly board: OrchestratorBoardWire;
}) {
  const { reportFailure } = useAgents();
  const [starting, setStarting] = useState(false);
  const { root, profile, presentation, problem } = board.start;
  return (
    <div className="orchestrator-start">
      <div className="orchestrator-start-card">
        <h2>No orchestrator is running</h2>
        <p>
          The orchestrator is an agent that coordinates the others with{" "}
          <code>devhub --tell</code> and raises escalations on the board for
          you. What it does is up to the skills in its folder.
        </p>
        <dl>
          <dt>Folder</dt>
          <dd>{root === undefined ? "not set" : <code>{root}</code>}</dd>
          <dt>Profile</dt>
          <dd>{profile ?? "the window's default"}</dd>
          <dt>Shown as</dt>
          <dd>
            {presentation === undefined
              ? "the profile's default"
              : presentation.toUpperCase()}
          </dd>
        </dl>
        {problem === undefined ? null : (
          <p className="orchestrator-start-problem">{problem}</p>
        )}
        <button
          type="button"
          className="mac-button default"
          disabled={problem !== undefined || starting}
          onClick={() => {
            setStarting(true);
            void devhub()
              .startOrchestrator()
              .catch(reportFailure)
              .finally(() => {
                setStarting(false);
              });
          }}
        >
          {starting ? "Starting…" : "Start Orchestrator"}
        </button>
      </div>
    </div>
  );
}
