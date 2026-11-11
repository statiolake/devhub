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
import { useGlide } from "../glide";
import { focusIsOurs, useNavStack } from "./navStack";
import { RichText } from "./orchestratorRichText";
import { listenForLightboxes } from "../conversation/lightboxLayer";
import { FilesPage } from "./OrchestratorFiles";
import {
  EscalationMemo,
  escalationMemo,
  WorkCard,
  workItems,
} from "./OrchestratorWork";
import { ModeControl } from "./OrchestratorDelivery";
import { RequestButton, RequestCard } from "./OrchestratorRequest";
import { GitHubPill } from "./OrchestratorGitHub";
import { dueText, EscalationNote, inProgressBefore } from "./EscalationNote";
import { dueWords } from "../../model/escalations";
import { decisionOf } from "../../model/escalationBrief";
import {
  initialTab,
  modelView,
  paneViewOn,
  tabOfView,
  useEntryState,
  useFollowModelView,
  useStackHistory,
} from "./orchestratorHistory";
import { DevhubLink } from "../conversation/DevhubLink";
import { base64Of } from "../conversation/FileEmbed";
import { isDevhubLink } from "../../model/devhubLink";
import {
  memory,
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

export function OrchestratorBoard({
  snapshot,
}: {
  readonly snapshot: AppSnapshot;
}) {
  const { board, reportFailure, dispatch } = useAgents();
  const [tab, setTab] = useState<BoardTab>(() => initialTab(snapshot));
  // Something in the folder changed while the Files tab was not looked at.
  const [filesChanged, setFilesChanged] = useState(false);
  const section = useRef<HTMLElement>(null);
  const show = useCallback((next: BoardTab) => {
    setTab(next);
    if (next === "files") setFilesChanged(false);
    rememberTab(next);
    reportOrchestratorView();
  }, []);
  // A tab chosen is the same place, showing another page: the entry on
  // screen is written over (`orchestratorHistory.ts`).
  const choose = useCallback(
    (next: BoardTab) => {
      show(next);
      void dispatch({
        type: "show_orchestrator_view",
        view: paneViewOn(next),
        drawn: true,
      }).catch(() => undefined);
    },
    [show, dispatch],
  );
  // Back, Forward or a link onto the other tab's page: that tab, which
  // mounts on the model's view.
  useFollowModelView(snapshot, ({ view }) => {
    if (tabOfView(view) !== tab) show(tabOfView(view));
  });
  // Back on the screen: the title says what it came back to.
  useEffect(() => {
    reportOrchestratorView(true);
  }, []);
  // A picture opened large from the board goes over the conversation beside
  // it, which is a view of its own above this page's (`lightboxLayer.ts`).
  const failed = useRef(reportFailure);
  failed.current = reportFailure;
  useEffect(
    () =>
      listenForLightboxes((open) => {
        void devhub()
          .previewLayout({ agentsOverlay: open })
          .catch((error: unknown) => failed.current(error));
      }),
    [],
  );
  useEffect(() => {
    if (tab === "files") return;
    const files = devhub().onOrchestratorFilesChanged;
    if (typeof files !== "function") return;
    return files(() => {
      setFilesChanged(true);
    });
  }, [tab]);
  // The mouse's side buttons over the pane are the window's Back and
  // Forward (`historyButtons.ts`), which walk the pane's views too.
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
          <RequestButton
            onSend={(text) => devhub().sendOrchestratorRequest(text)}
          />
          {/* Always choosable: the mode is DevHub's, not the agent's, and
              Start turns an off one on. */}
          <ModeControl
            board={board}
            onChoose={(mode) => {
              void devhub().setOrchestratorMode(mode).catch(reportFailure);
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
          snapshot={snapshot}
          workspaces={snapshot.workspaces}
        />
      ) : (
        <FilesPage
          pane={section}
          snapshot={snapshot}
          orchestratorAgentId={board.orchestratorAgentId}
        />
      )}
    </section>
  );
}

/** What on the board glides: the leaves, never what holds them. */
const BOARD_PARTS =
  ".orchestrator-lane-heading, .orchestrator-lane-empty, [data-escalation-id]";

function boardPartKey(element: HTMLElement): string | undefined {
  const card = element.dataset["escalationId"];
  if (card !== undefined) return `card:${card}`;
  const lane = element.closest<HTMLElement>("[data-tone]")?.dataset["tone"];
  if (lane === undefined) return undefined;
  return `${element.className}:${lane}`;
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

/** The board under an escalation, as a view. */
const BOARD_UNDER = { kind: "board" } as const;

/**
 * The escalation the pane was left on, if it is still there to show: the
 * model's view when the snapshot has one (Back may have put the pane back on
 * another), else the pane's own memory.
 */
function restoredEscalation(
  all: readonly EscalationWire[],
  snapshot: AppSnapshot,
): EscalationWire | undefined {
  const state = modelView(snapshot);
  if (state !== undefined) {
    if (state.view.kind !== "escalation") return undefined;
    const id = state.view.id;
    const found = all.find((one) => one.id === id);
    if (
      found?.state === "closed" &&
      memory.escalation?.id === id &&
      !memory.escalation.closed
    )
      return undefined;
    return found;
  }
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
  snapshot,
  workspaces,
}: {
  readonly pane: RefObject<HTMLElement | null>;
  readonly snapshot: AppSnapshot;
  readonly workspaces: AppSnapshot["workspaces"];
}) {
  const { board, dispatch } = useAgents();
  const now = useNow();
  const lanes = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(() => memory.folded);
  const fold = useCallback((lane: "waiting" | "work" | "closed") => {
    setFolded((value) => {
      const next = { ...value, [lane]: !value[lane] };
      memory.folded = next;
      return next;
    });
  }, []);
  const work = useMemo(() => workItems(board), [board]);
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
  const [initial] = useState(() => restoredEscalation(all, snapshot));
  const stack = useNavStack<EscalationWire>(
    pane,
    (escalation) =>
      lanes.current?.querySelector<HTMLElement>(
        `[data-escalation-id="${String(escalation.id)}"]`,
      ),
    initial,
  );
  const { nav, shown, restored, arrived } = stack;
  // Opened, closed and followed as places in Back and Forward.
  const {
    open: openCard,
    close,
    drop,
  } = useStackHistory<EscalationWire>({
    stack,
    snapshot,
    dispatch,
    viewOf: (escalation) => ({ kind: "escalation", id: escalation.id }),
    under: BOARD_UNDER,
    find: (view) =>
      view.kind === "escalation"
        ? all.find((one) => one.id === view.id)
        : undefined,
  });
  // The model put the pane on an escalation that is not there to show (it
  // was closed since, or deleted): the board, written over that entry.
  useEffect(() => {
    const said = modelView(snapshot)?.view;
    if (said?.kind === "escalation" && initial === undefined)
      void dispatch({
        type: "show_orchestrator_view",
        view: BOARD_UNDER,
        drawn: true,
      }).catch(() => undefined);
    // Once, on mount, against the view it mounted on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The board's scroll and folded lanes, as each entry left them.
  useEntryState(snapshot.historyEntry, lanes, folded, setFolded);
  // The escalation on the page over, as it was when it was opened; the
  // board's own copy of it is read live. It stays through a pop, so the
  // view slides out with what it showed.
  const live =
    shown === undefined ? undefined : all.find((one) => one.id === shown.id);
  const open = live ?? shown;
  // An escalation that leaves the board while it is read closes, as before;
  // the entry it was is written over with the board.
  useEffect(() => {
    if (nav === "push" && shown !== undefined && live === undefined) drop();
  }, [nav, shown, live, drop]);
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
  // Whatever changes place on the board glides there — a card re-ranked,
  // moved to another lane, the lanes under one that grew or folded — and
  // what is new rises in (`glide.ts`). One rule for all of it: a card used
  // to glide inside 要回答 while the lanes under it jumped.
  const boardDrawn = useMemo(() => ({ board, folded }), [board, folded]);
  useGlide(lanes, BOARD_PARTS, boardPartKey, boardDrawn);
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
      data-arrived={arrived}
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
        {/* The person's requests (the header's +): there from the moment one
            is sent, until the orchestrator has filed it; no heading when
            there are none. */}
        {(board.requests ?? []).length === 0 ? null : (
          <Lane
            title="依頼"
            hint="Your requests to the orchestrator: waiting to be sent while it is off, then waiting for it to file each as a task."
            tone="request"
            count={
              (board.requests ?? []).filter((one) => one.state !== "filed")
                .length
            }
            empty="依頼はありません。"
          >
            {(board.requests ?? []).map((one) => (
              <RequestCard
                key={one.id}
                request={one}
                age={
                  one.state === "filed" && one.filed !== undefined
                    ? `filed ${span(now - one.filed.at)} ago`
                    : span(now - one.at)
                }
              />
            ))}
          </Lane>
        )}
        <Lane
          title="要回答"
          hint="Needs your answer: the orchestrator cannot go on without it. Oldest first."
          tone="ask"
          count={board.needsAnswer.length}
          empty="回答を待っているものはありません。"
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
          empty="対応中のものはありません。"
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
          empty="条件を待っているものはありません。"
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
        {/* The work its agents did: each subject with a note, or whose agent
            is stopped and can be brought back; no heading when there is none. */}
        {work.length === 0 ? null : (
          <Lane
            title="作業"
            hint="What the orchestrator means to do next with each piece of work (its memo), and work whose agent is stopped and can be resumed (devhub --tell agent resume <subject>)."
            tone="work"
            count={work.length}
            empty="作業はありません。"
            folded={folded.work}
            onFold={() => {
              fold("work");
            }}
          >
            {work.map((item) => (
              <WorkCard
                key={item.subject}
                item={item}
                now={now}
                span={span}
                agentId={board.orchestratorAgentId}
                cwd={board.start.root}
              />
            ))}
          </Lane>
        )}
        <Lane
          title="完了"
          hint="Closed escalations, most recent first."
          tone="closed"
          count={board.closed.length}
          empty="完了したものはまだありません。"
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
  readonly tone: "request" | "ask" | "progress" | "waiting" | "work" | "closed";
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
  const picture = firstPicture(escalation);
  return (
    <li>
      <button
        type="button"
        className={`orchestrator-card${picture === undefined ? "" : " has-picture"}`}
        data-escalation-id={escalation.id}
        onClick={onOpen}
      >
        {picture === undefined ? null : <CardPicture path={picture} />}
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
            : decisionText(question?.markdown ?? "")}
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
          {open && escalation.mayBeStale !== undefined ? (
            <span
              className="orchestrator-chip is-stale"
              title={`May be stale: ${escalation.mayBeStale.reasons.join("; ")}`}
            >
              古いかも
            </span>
          ) : null}
          {question?.options !== undefined &&
          escalation.state === "needs_answer" ? (
            <span className="orchestrator-chip">
              選択肢 {question.options.length}
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
        {open && escalation.mayBeStale !== undefined ? (
          <span className="orchestrator-card-why is-stale">
            古いかも: {escalation.mayBeStale.reasons.join("; ")}
          </span>
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
  const { board } = useAgents();
  const memo = useMemo(
    () => escalationMemo(escalation, board),
    [escalation, board],
  );
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
          title="Back to the board (⎋)"
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
        {escalation.state !== "closed" &&
        escalation.mayBeStale !== undefined ? (
          <p className="orchestrator-reading-stale">
            <span className="orchestrator-chip is-stale">古いかも</span>
            {escalation.mayBeStale.reasons.join("; ")}
            <span className="orchestrator-reading-stale-note">
              {" "}
              — DevHub が見たところ。次の triage
              でオーケストレーターが確かめます
            </span>
          </p>
        ) : null}
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
                  {escalation.linkLabels?.[link] === undefined ? (
                    linkLabel(link)
                  ) : (
                    <>
                      {escalation.linkLabels[link]}
                      <span className="orchestrator-chip-sub">
                        {linkLabel(link)}
                      </span>
                    </>
                  )}
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
        <EscalationMemo
          memo={memo}
          agentId={pathsOn}
          cwd={base}
          now={now}
          span={span}
        />
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

/**
 * What the card says of the question: the decision it asks for
 * (`## 決めてほしいこと`, `model/escalationBrief.ts`), else its first line.
 */
function decisionText(markdown: string): string {
  return decisionOf(markdown) ?? preview(markdown);
}

/**
 * The first picture kept with the escalation — an `--attach`, or an image
 * its body named, both copied into its own folder when it was raised — in
 * its latest question first: the card's thumbnail.
 */
export function firstPicture(escalation: EscalationWire): string | undefined {
  const questions = escalation.entries
    .filter(
      (entry) => entry.role === "orchestrator" && entry.kind === undefined,
    )
    .reverse();
  for (const entry of questions) {
    for (const match of entry.markdown.matchAll(
      /!\[[^\]\n]*\]\(\s*<([^>\n]+)>/gu,
    )) {
      const path = match[1]!;
      if (/\/devhub\/escalations\/\d+\/[^/]+$/u.test(path)) return path;
    }
  }
  return undefined;
}

/** A picture's bytes, read on this Mac, as a URL an <img> takes. */
function CardPicture({ path }: { readonly path: string }) {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    let gone = false;
    void devhub()
      .readEscalationEmbed(path)
      .then((file) => {
        if (gone || file === null) return;
        const type = file.mediaType.startsWith("image/")
          ? file.mediaType
          : path.toLowerCase().endsWith(".svg")
            ? "image/svg+xml"
            : "image/png";
        setUrl(`data:${type};base64,${base64Of(file.bytes)}`);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [path]);
  return (
    <span className="orchestrator-card-picture" aria-hidden="true">
      {url === undefined ? null : <img src={url} alt="" />}
    </span>
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
      {/* The quick replies' row keeps its room while there are none, so a
          question with options arriving fills it instead of lifting the
          composer's top edge (docs/motion.md). */}
      <div
        className="orchestrator-options"
        aria-label={options.length > 0 ? "Quick replies" : undefined}
        data-empty={options.length === 0 || undefined}
      >
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
