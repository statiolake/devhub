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
import type { EscalationWire, OrchestratorBoardWire } from "../../ipc/contract";
import type { AgentStatus, AppSnapshot } from "../../ipc/appShell";
import { pressFocusesField } from "../conversation/fieldClick";
import { useMessageKeys, SEND_KEY } from "../conversation/messageKeys";
import { SendIcon } from "../conversation/icons";
import { DictationWaveform } from "../conversation/DictationWaveform";
import {
  DictationControls,
  DictationTentative,
  useFieldDictation,
} from "../conversation/FieldDictation";
import type { VoiceApi } from "../../ipc/voice";
import { StatusMark } from "../components/sidebar/StatusMark";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";
import { historyDirectionOfButton } from "../historyButtons";
import { focusIsOurs, reducedMotion, useNavStack } from "./navStack";
import { RichText } from "./orchestratorRichText";
import { FilesPage } from "./OrchestratorFiles";
import { EventsSwitch } from "./OrchestratorDelivery";
import { GitHubPill } from "./OrchestratorGitHub";
import { dueText, EscalationNote, inProgressBefore } from "./EscalationNote";
import { dueWords } from "../../model/escalations";
import { useEscalationRequests } from "./escalationRequests";
import { DevhubLink } from "../conversation/DevhubLink";
import { isDevhubLink } from "../../model/devhubLink";
import {
  memory,
  rememberedTab,
  rememberTab,
  reportOrchestratorView,
  type BoardTab,
} from "./orchestratorMemory";

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
export type { BoardTab } from "./orchestratorMemory";

/** What a tab answers of the mouse's side buttons; false leaves it be. */
export type SideButtons = (direction: "back" | "forward") => boolean;

export function OrchestratorBoard({
  snapshot,
}: {
  readonly snapshot: AppSnapshot;
}) {
  const { board, reportFailure } = useAgents();
  const [tab, setTab] = useState<BoardTab>(rememberedTab);
  // Something in the folder changed while the Files tab was not looked at.
  const [filesChanged, setFilesChanged] = useState(false);
  const section = useRef<HTMLElement>(null);
  const sideButtons = useRef<SideButtons>(() => false);
  const choose = useCallback((next: BoardTab) => {
    setTab(next);
    if (next === "files") setFilesChanged(false);
    rememberTab(next);
    reportOrchestratorView();
  }, []);
  // Back on the screen: the title says what it came back to.
  useEffect(() => {
    reportOrchestratorView(true);
  }, []);
  // A `devhub:escalation` link, followed: it is read on the board.
  useEscalationRequests(() => {
    choose("board");
  }, false);
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
              対応中 · {board.waiting.length} 待機中
            </span>
          ) : null}
        </div>
        <div className="orchestrator-board-tools">
          <EventsSwitch
            board={board}
            disabled={orchestrator === undefined}
            onToggle={() => {
              void devhub()
                .setOrchestratorPaused(!board.paused)
                .catch(reportFailure);
            }}
          />
          <GitHubPill
            github={board.github}
            orchestratorAgentId={board.orchestratorAgentId}
          />
        </div>
      </header>
      {tab === "board" ? (
        <BoardPage
          pane={section}
          sideButtons={sideButtons}
          workspaces={snapshot.workspaces}
        />
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
/**
 * What an escalation's relative paths are relative to: its workspace, else
 * its first agent's, else the orchestrator's folder — as main takes its
 * pictures in (`main/orchestrator/escalationFiles.ts`).
 */
export function escalationBase(
  escalation: EscalationWire,
  workspaces: AppSnapshot["workspaces"],
  orchestratorRoot: string | undefined,
): string | undefined {
  const named = workspaces.find((one) => one.id === escalation.workspaceId);
  const first = escalation.agents[0]?.agentId;
  const ofAgent =
    first === undefined
      ? undefined
      : workspaces.find((one) =>
          one.agents.some((agent) => agent.id === first),
        );
  return named?.root ?? ofAgent?.root ?? orchestratorRoot;
}

/** The escalation the pane was left on, if it is still there to show. */
function restoredEscalation(
  all: readonly EscalationWire[],
): EscalationWire | undefined {
  const left = memory.escalation;
  if (left === undefined) return undefined;
  const now = all.find((one) => one.id === left.id);
  if (now === undefined || (now.state === "closed" && !left.closed)) {
    memory.escalation = undefined;
    return undefined;
  }
  return now;
}

/** A Workspace the reading view offers to go to. */
export interface WorkspaceJump {
  readonly id: string;
  readonly label: string;
  /** The agent chip it is drawn after; absent: the escalation's own, first. */
  readonly afterAgent?: string;
}

/**
 * The Workspaces an escalation's reading view offers to go to: its own, and
 * each related agent's, once each — found by the snapshot, which knows where
 * every agent is. One an agent is in goes after that agent's chip.
 */
export function escalationWorkspaces(
  escalation: EscalationWire,
  workspaces: AppSnapshot["workspaces"],
): readonly WorkspaceJump[] {
  const out: WorkspaceJump[] = [];
  const seen = new Set<string>();
  for (const agent of escalation.agents) {
    const workspace = workspaces.find((one) =>
      one.agents.some((it) => it.id === agent.agentId),
    );
    if (workspace === undefined || seen.has(workspace.id)) continue;
    seen.add(workspace.id);
    out.push({
      id: workspace.id,
      label: workspace.label,
      afterAgent: agent.agentId,
    });
  }
  const own = workspaces.find((one) => one.id === escalation.workspaceId);
  if (own !== undefined && !seen.has(own.id))
    out.unshift({ id: own.id, label: own.label });
  return out;
}

function BoardPage({
  pane,
  sideButtons,
  workspaces,
}: {
  readonly pane: RefObject<HTMLElement | null>;
  readonly sideButtons: RefObject<SideButtons>;
  readonly workspaces: AppSnapshot["workspaces"];
}) {
  const { board, dispatch } = useAgents();
  const now = useNow();
  const lanes = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(() => memory.folded);
  const fold = useCallback((lane: "waiting" | "closed") => {
    setFolded((value) => {
      const next = { ...value, [lane]: !value[lane] };
      memory.folded = next;
      return next;
    });
  }, []);
  const all = useMemo(
    () => [
      ...board.needsAnswer,
      ...board.inProgress,
      ...board.waiting,
      ...board.closed,
    ],
    [board],
  );
  // Where the pane was left: that escalation, again — unless it has gone
  // from the board, or was closed since, and then the board.
  const [initial] = useState(() => restoredEscalation(all));
  const stack = useNavStack<EscalationWire>(
    pane,
    (escalation) =>
      lanes.current?.querySelector<HTMLElement>(
        `[data-escalation-id="${String(escalation.id)}"]`,
      ),
    initial,
  );
  const { nav, shown, forward, restored, open: openCard, close } = stack;
  // A `devhub:escalation` link, followed (`escalationRequests.ts`).
  useEscalationRequests((id) => {
    const asked = all.find((one) => one.id === id);
    if (asked !== undefined) openCard(asked);
  }, true);
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
  // What is open is what the pane comes back to.
  const openId = nav === "push" ? open?.id : undefined;
  const openClosed = open?.state === "closed";
  useEffect(() => {
    memory.escalation =
      openId === undefined ? undefined : { id: openId, closed: openClosed };
    reportOrchestratorView();
  }, [openId, openClosed]);
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
  // So is going to a Workspace's editor: prefix+h comes back here, to the
  // escalation that was open.
  const focusWorkspace = useCallback(
    (workspaceId: string) => {
      void dispatch({
        type: "select_context",
        context: { kind: "workspace", workspaceId },
        reason: "explicit",
      });
    },
    [dispatch],
  );
  useReorderGlide(lanes, board.needsAnswer);
  // Enter on the board, with no card focused, opens the card on top: the
  // first of 要回答, else of the lanes after it. A focused card (a button)
  // opens itself, and a field or a link keeps its own Enter.
  const reading = nav === "push";
  useEffect(() => {
    if (reading) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "Enter" ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.defaultPrevented ||
        !focusIsOurs(pane.current) ||
        ownsEnter(document.activeElement)
      )
        return;
      const top = all.find((one) => one.state !== "closed");
      if (top === undefined) return;
      event.preventDefault();
      openCard(top);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [reading, all, pane, openCard]);
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
  return (
    <div
      className="orchestrator-stage"
      data-nav={nav}
      data-restored={restored ? "true" : undefined}
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
          title="待機中"
          hint="Waiting: parked on an outside condition (a date, someone's reply), its trigger in words. Soonest first. The orchestrator is reminded of them."
          tone="waiting"
          count={board.waiting.length}
          empty="Nothing is waiting on a condition."
          folded={folded.waiting}
          onFold={() => {
            fold("waiting");
          }}
        >
          {board.waiting.map((one) => (
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
          title="完了"
          hint="Closed escalations, most recent first."
          tone="closed"
          count={board.closed.length}
          empty="Nothing closed yet."
          folded={folded.closed}
          onFold={() => {
            fold("closed");
          }}
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
      </div>
      {open === undefined ? null : (
        <EscalationView
          key={open.id}
          escalation={open}
          now={now}
          leaving={!reading}
          orchestratorAgentId={board.orchestratorAgentId}
          base={escalationBase(open, workspaces, board.start.root)}
          workspaces={workspaces}
          onBack={() => {
            close();
          }}
          onAnswered={answered}
          onFocusAgent={focusAgent}
          onFocusWorkspace={focusWorkspace}
        />
      )}
    </div>
  );
}

/** An element whose Enter is its own: a control, a field, a link. */
function ownsEnter(element: Element | null): boolean {
  return (
    element instanceof HTMLElement &&
    element.closest(
      'button, a[href], input, textarea, select, [contenteditable="true"], [role="button"], [role="tab"], [role="link"]',
    ) !== null
  );
}

/**
 * One lane. A lane given `onFold` folds: its heading is a disclosure button,
 * the chevron on the left, and a folded lane shows only the heading and its
 * count.
 */
function Lane({
  title,
  hint,
  tone,
  count,
  empty,
  folded = false,
  onFold,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  readonly tone: "ask" | "progress" | "waiting" | "closed";
  readonly count: number;
  readonly empty: string;
  readonly folded?: boolean;
  readonly onFold?: () => void;
  readonly children: ReactNode;
}) {
  const heading = (
    <>
      <span className="orchestrator-lane-mark" aria-hidden="true" />
      <span className="orchestrator-lane-title">{title}</span>
      <span className="orchestrator-lane-count">{count}</span>
    </>
  );
  return (
    <section
      className="orchestrator-lane"
      data-tone={tone}
      data-folded={folded ? "true" : undefined}
      aria-label={title}
    >
      <h2 className="orchestrator-lane-heading" title={hint}>
        {onFold === undefined ? (
          heading
        ) : (
          <button
            type="button"
            className="orchestrator-lane-fold"
            aria-expanded={!folded}
            onClick={onFold}
          >
            <svg
              className="orchestrator-lane-chevron"
              viewBox="0 0 10 10"
              aria-hidden="true"
            >
              <path d="M3.5 2 L6.5 5 L3.5 8" />
            </svg>
            {heading}
          </button>
        )}
      </h2>
      {folded ? null : count === 0 ? (
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
        : escalation.state === "waiting"
          ? `waiting ${span(now - escalation.stateSince)}`
          : `closed ${span(now - escalation.stateSince)} ago`;
  const wait =
    escalation.state === "waiting" && last?.kind === "wait" ? last : undefined;
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
        {wait === undefined ? null : (
          <span className="orchestrator-card-trigger">
            <span className="orchestrator-card-trigger-text">
              {wait.markdown}
            </span>
            {wait.dueAt === undefined ? null : (
              <span className="orchestrator-card-due">
                {dueText(wait.dueAt)} · {dueWords(wait.dueAt, now)}
              </span>
            )}
          </span>
        )}
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
          {escalation.state === "in_progress" &&
          escalation.stalledSince !== undefined ? (
            <span className="orchestrator-chip is-stalled">停滞</span>
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
    </li>
  );
}

// --- one escalation -------------------------------------------------------------

const STATE_LABEL: Record<EscalationWire["state"], string> = {
  needs_answer: "要回答",
  in_progress: "対応中",
  waiting: "待機中",
  closed: "Closed",
};

function EscalationView({
  escalation,
  now,
  leaving,
  orchestratorAgentId,
  onBack,
  base,
  workspaces,
  onAnswered,
  onFocusAgent,
  onFocusWorkspace,
}: {
  readonly escalation: EscalationWire;
  readonly now: number;
  /** Going back to the board: drawn while it slides out, and not used. */
  readonly leaving: boolean;
  readonly orchestratorAgentId: string | undefined;
  readonly onBack: () => void;
  /** What its relative paths are relative to (`escalationBase`). */
  readonly base: string | undefined;
  readonly workspaces: AppSnapshot["workspaces"];
  /** The person's answer went out. */
  readonly onAnswered: (id: number) => void;
  readonly onFocusAgent: (agentId: string) => void;
  readonly onFocusWorkspace: (workspaceId: string) => void;
}) {
  const pathsOn = escalation.agents[0]?.agentId ?? orchestratorAgentId;
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const jumps = escalationWorkspaces(escalation, workspaces);
  const scrollKey = `esc:${String(escalation.id)}`;
  const entryCount = escalation.entries.length;
  // A new entry is read from its start: the newest is at the bottom. Coming
  // back to the same thread, it is where it was left.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const left = placed.current ? undefined : memory.scroll.get(scrollKey);
    placed.current = true;
    element.scrollTop =
      left !== undefined && left.entries === entryCount
        ? left.top
        : element.scrollHeight;
  }, [scrollKey, entryCount]);
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
        </div>
        {escalation.agents.length > 0 ||
        escalation.links.length > 0 ||
        jumps.length > 0 ? (
          <div className="orchestrator-reading-refs">
            {jumps
              .filter((jump) => jump.afterAgent === undefined)
              .map((jump) => (
                <WorkspaceButton
                  key={jump.id}
                  jump={jump}
                  onFocusWorkspace={onFocusWorkspace}
                />
              ))}
            {escalation.agents.flatMap((agent) => [
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
              </button>,
              ...jumps
                .filter((jump) => jump.afterAgent === agent.agentId)
                .map((jump) => (
                  <WorkspaceButton
                    key={`ws-${jump.id}`}
                    jump={jump}
                    onFocusWorkspace={onFocusWorkspace}
                  />
                )),
            ])}
            {escalation.links.map((link) =>
              isDevhubLink(link) ? (
                <DevhubLink key={link} href={link} />
              ) : (
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
              ),
            )}
          </div>
        ) : null}
      </div>
      <div
        className="orchestrator-thread conversation-selectable"
        ref={scroller}
        tabIndex={-1}
        onScroll={(event) => {
          memory.scroll.set(scrollKey, {
            top: event.currentTarget.scrollTop,
            entries: entryCount,
          });
        }}
        aria-label={`#${String(escalation.id)} ${escalation.title}`}
      >
        {escalation.entries.map((entry, index) =>
          entry.kind !== undefined ? (
            <EscalationNote
              key={`${String(entry.at)}-${String(index)}`}
              entry={{ ...entry, kind: entry.kind }}
              agents={escalation.agents}
              onFocusAgent={onFocusAgent}
              alreadyInProgress={inProgressBefore(escalation.entries, index)}
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
                <RichText
                  source={entry.markdown}
                  agentId={pathsOn}
                  cwd={base}
                />
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
        {escalation.state === "waiting" ? (
          <div className="orchestrator-closed-note">
            Waiting on a condition. The orchestrator resumes it when it is met;
            anything you write here moves it to 対応中.
          </div>
        ) : null}
      </div>
      {escalation.state === "closed" ? null : (
        <AnswerComposer escalation={escalation} onAnswered={onAnswered} />
      )}
    </div>
  );
}

/** A folder, as the Workspace picker draws one. */
function FolderGlyph() {
  return (
    <svg
      className="orchestrator-folder-glyph"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1.8 4.2a1 1 0 0 1 1-1h3l1.4 1.6h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9.4a1 1 0 0 1-1-1z" />
    </svg>
  );
}

/** Go to a Workspace's editor: the glyph and its name, nothing on hover. */
function WorkspaceButton({
  jump,
  onFocusWorkspace,
}: {
  readonly jump: WorkspaceJump;
  readonly onFocusWorkspace: (workspaceId: string) => void;
}) {
  return (
    <button
      type="button"
      className="orchestrator-chip is-link is-workspace"
      aria-label={`Workspace ${jump.label}`}
      onClick={() => {
        onFocusWorkspace(jump.id);
      }}
    >
      <FolderGlyph />
      {jump.label}
    </button>
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
 * replies. ⌘Return sends, as in the conversation's composer. The field is
 * the box: Send sits beside it, and a press anywhere else in the composer
 * lands in it. The conversation's microphone sits beside Send
 * (`FieldDictation.tsx`): what is said goes in at the caret, to be read and
 * sent like anything typed.
 */
function AnswerComposer({
  escalation,
  onAnswered,
}: {
  readonly escalation: EscalationWire;
  readonly onAnswered: (id: number) => void;
}) {
  const { reportFailure } = useAgents();
  // The unsent answer is kept for the pane's return (`orchestratorMemory`).
  const [text, setTextState] = useState(
    () => memory.drafts.get(escalation.id) ?? "",
  );
  const setText = useCallback(
    (value: string | ((current: string) => string)) => {
      setTextState((current) => {
        const next = typeof value === "string" ? value : value(current);
        if (next === "") memory.drafts.delete(escalation.id);
        else memory.drafts.set(escalation.id, next);
        return next;
      });
    },
    [escalation.id],
  );
  const [sending, setSending] = useState(false);
  // Why the last send did not go; the draft stays, and so does the view.
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  // The Agents page's dictation, as every conversation's composer has it.
  const voice = useMemo(() => devhub().voice as VoiceApi | undefined, []);
  const { dictation, language, cycleLanguage, onKey, onFieldFocus } =
    useFieldDictation({
      voice,
      reportFailure,
      field: input,
      text,
      setText,
    });
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
    [escalation.id, reportFailure, sending, onAnswered, setText],
  );
  const keys = useMessageKeys(
    () => {
      send(text);
    },
    (event) => {
      // Esc that throws a recording away does not leave the view as well.
      onKey(event);
    },
  );
  // Grow with what is written, up to a third of the pane.
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${String(Math.min(field.scrollHeight, 220))}px`;
  }, [text]);
  return (
    <div
      className="orchestrator-composer conversation-composer"
      // The frame's padding and the gaps around the quick replies are the
      // field's: a press there writes, one on a quick reply or Send does not.
      onMouseDown={(event) => {
        pressFocusesField(event, input.current);
      }}
    >
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
      <div
        className="conversation-composer-box"
        data-dictating={dictation.analyser !== undefined || undefined}
      >
        {dictation.analyser !== undefined ? (
          <DictationWaveform analyser={dictation.analyser} />
        ) : null}
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
            onFocus={onFieldFocus}
            {...keys}
          />
          <DictationTentative dictation={dictation} />
        </div>
        <div className="conversation-composer-actions">
          {voice !== undefined ? (
            <DictationControls
              dictation={dictation}
              language={language}
              disabled={false}
              cycleLanguage={cycleLanguage}
            />
          ) : null}
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
