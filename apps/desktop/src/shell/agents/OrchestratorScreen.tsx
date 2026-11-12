/**
 * The Orchestrator screen's left half: two tabs, ボード (the board of tasks,
 * and a task opened on it) and ファイル (the orchestrator's folder,
 * `OrchestratorFiles.tsx`), each a navigation stack (`navStack.ts`).
 *
 * The right half is the orchestrator agent's own pane — an ordinary Agent
 * pane from the pool (`AgentPane`), so its conversation is exactly the one
 * every GUI Agent has. This is drawn beside it, in the same view: the
 * Orchestrator row lays the Agents view over the whole content area, and the
 * page divides it (`AgentsApp`).
 *
 * The board reads `OrchestratorBoardWire` — the tasks by status — and
 * writes one thing: the person's answer to a task's open question
 * (`answerEscalation`), the only door an answer has. A question is drawn with
 * the conversation's own Markdown renderer — code, math, Mermaid, SVG — so
 * what the orchestrator wrote looks the way it would in a chat answer. See
 * `docs/orchestrator.md`.
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
  TaskWire,
} from "../../ipc/contract";
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
import { ModeControl } from "./OrchestratorDelivery";
import { RequestButton } from "./OrchestratorRequest";
import { GitHubPill } from "./OrchestratorGitHub";
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
              {board.answer.length} 回答待ち · {board.inProgress.length} 処理中
              · {board.waiting.length} 待機
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
  ".orchestrator-lane-heading, .orchestrator-lane-empty, [data-task-id], [data-untasked]";

function boardPartKey(element: HTMLElement): string | undefined {
  const card = element.dataset["taskId"];
  if (card !== undefined) return `card:${card}`;
  const untasked = element.dataset["untasked"];
  if (untasked !== undefined) return `untasked:${untasked}`;
  const lane = element.closest<HTMLElement>("[data-tone]")?.dataset["tone"];
  if (lane === undefined) return undefined;
  return `${element.className}:${lane}`;
}

/**
 * What a task's relative paths are relative to: its latest open agent's
 * workspace, else the orchestrator's folder — as main takes an escalation's
 * pictures in (`main/orchestrator/escalationFiles.ts`).
 */
export function taskBase(
  task: TaskWire,
  workspaces: AppSnapshot["workspaces"],
  orchestratorRoot: string | undefined,
): string | undefined {
  for (const agent of [...task.agents].reverse()) {
    const workspace = workspaces.find((one) =>
      one.agents.some((it) => it.id === agent.agentId),
    );
    if (workspace !== undefined) return workspace.root;
  }
  return orchestratorRoot;
}

/** The board under a task, as a view. */
const BOARD_UNDER = { kind: "board" } as const;

/**
 * The task the pane was left on, if it is still there to show: the model's
 * view when the snapshot has one (Back may have put the pane back on
 * another), else the pane's own memory. One done since it was left lands on
 * the board.
 */
function restoredTask(
  all: readonly TaskWire[],
  snapshot: AppSnapshot,
): TaskWire | undefined {
  const state = modelView(snapshot);
  if (state !== undefined) {
    if (state.view.kind !== "task") return undefined;
    const id = state.view.id;
    const found = all.find((one) => one.id === id);
    if (found?.status === "done" && memory.task?.id === id && !memory.task.done)
      return undefined;
    return found;
  }
  const left = memory.task;
  if (left === undefined) return undefined;
  const now = all.find((one) => one.id === left.id);
  if (now === undefined || (now.status === "done" && !left.done)) {
    memory.task = undefined;
    return undefined;
  }
  return now;
}

/** A Workspace the reading view offers to go to. */
export interface WorkspaceJump {
  readonly id: string;
  readonly label: string;
  /** The agent chip it is drawn after. */
  readonly afterAgent: string;
}

/**
 * The Workspaces a task's reading view offers to go to: each bound agent's,
 * open now or (for a stopped one) the open Workspace at its folder, once
 * each, after that agent's chip.
 */
export function taskWorkspaces(
  task: TaskWire,
  workspaces: AppSnapshot["workspaces"],
): readonly WorkspaceJump[] {
  const out: WorkspaceJump[] = [];
  const seen = new Set<string>();
  for (const agent of task.agents) {
    const workspace =
      workspaces.find((one) =>
        one.agents.some((it) => it.id === agent.agentId),
      ) ?? workspaces.find((one) => one.id === agent.workspaceId);
    if (workspace === undefined || seen.has(workspace.id)) continue;
    seen.add(workspace.id);
    out.push({
      id: workspace.id,
      label: workspace.label,
      afterAgent: agent.agentId,
    });
  }
  return out;
}

/** A task's open questions, oldest first. */
function openQuestions(task: TaskWire): readonly EscalationWire[] {
  return task.escalations.filter((one) => one.state === "open");
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
  const fold = useCallback((lane: "waiting" | "closed") => {
    setFolded((value) => {
      const next = { ...value, [lane]: !value[lane] };
      memory.folded = next;
      return next;
    });
  }, []);
  const all = useMemo(
    () => [
      ...board.answer,
      ...board.inProgress,
      ...board.waiting,
      ...board.done,
    ],
    [board],
  );
  // The subjects that need a task: agents and items with none.
  const untasked = useMemo(
    () => board.needsAction.filter((one) => one.kind !== "task"),
    [board.needsAction],
  );
  // Where the pane was left: that task, again — unless it has gone from the
  // board, or was done since, and then the board.
  const [initial] = useState(() => restoredTask(all, snapshot));
  const stack = useNavStack<TaskWire>(
    pane,
    (task) =>
      lanes.current?.querySelector<HTMLElement>(
        `[data-task-id="${String(task.id)}"]`,
      ),
    initial,
  );
  const { nav, shown, restored, arrived } = stack;
  // Opened, closed and followed as places in Back and Forward.
  const {
    open: openCard,
    close,
    drop,
  } = useStackHistory<TaskWire>({
    stack,
    snapshot,
    dispatch,
    viewOf: (task) => ({ kind: "task", id: task.id }),
    under: BOARD_UNDER,
    find: (view) =>
      view.kind === "task" ? all.find((one) => one.id === view.id) : undefined,
  });
  // The model put the pane on a task that is not there to show: the
  // board, written over that entry.
  useEffect(() => {
    const said = modelView(snapshot)?.view;
    if (said?.kind === "task" && initial === undefined)
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
  // The task on the page over, as it was when it was opened; the board's
  // own copy of it is read live. It stays through a pop, so the view
  // slides out with what it showed.
  const live =
    shown === undefined ? undefined : all.find((one) => one.id === shown.id);
  const open = live ?? shown;
  // A task that leaves the board while it is read closes; the entry it was
  // is written over with the board.
  useEffect(() => {
    if (nav === "push" && shown !== undefined && live === undefined) drop();
  }, [nav, shown, live, drop]);
  // What is open is what the pane comes back to.
  const openId = nav === "push" ? open?.id : undefined;
  const openDone = open?.status === "done";
  useEffect(() => {
    memory.task =
      openId === undefined ? undefined : { id: openId, done: openDone };
    reportOrchestratorView();
  }, [openId, openDone]);
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
  // task that was open.
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
  // moved to another status, the lanes under one that grew or folded — and
  // what is new rises in (`glide.ts`).
  const boardDrawn = useMemo(() => ({ board, folded }), [board, folded]);
  useGlide(lanes, BOARD_PARTS, boardPartKey, boardDrawn);
  // Enter on the board, with no card focused, opens the card on top: the
  // first of 回答待ち, else of the lanes after it. A focused card (a button)
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
      const top = all.find((one) => one.status !== "done");
      if (top === undefined) return;
      event.preventDefault();
      openCard(top);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [reading, all, pane, openCard]);
  // Answered, and the task asks nothing more: back to the board, as Esc
  // goes, with focus on what is next in 回答待ち — the card after this one,
  // else the first left — or, with none left, on this one, now 処理中. A
  // task with another open question stays, on that question.
  const answered = useCallback(
    (taskId: number) => {
      const task = all.find((one) => one.id === taskId);
      if (task !== undefined && openQuestions(task).length > 1) return;
      const rest = board.answer.filter((one) => one.id !== taskId);
      const at = board.answer.findIndex((one) => one.id === taskId);
      const next =
        rest.length === 0 ? task : (rest[Math.max(0, at)] ?? rest[0]);
      close(next);
    },
    [board.answer, all, close],
  );
  const card = (task: TaskWire) => (
    <TaskCard
      key={task.id}
      task={task}
      now={now}
      onOpen={() => {
        openCard(task);
      }}
    />
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
        <Lane
          title="回答待ち"
          hint="A question to you is open on these tasks: the orchestrator waits for your answer before it goes on. Priority first, then the oldest question."
          tone="ask"
          count={board.answer.length}
          empty="回答を待っているものはありません。"
        >
          {board.answer.map(card)}
        </Lane>
        <Lane
          title="処理中"
          hint="In progress: the orchestrator and its agents are working on these. △ marks one nobody is moving."
          tone="progress"
          count={board.inProgress.length}
          empty="処理中のものはありません。"
        >
          {board.inProgress.map(card)}
        </Lane>
        <Lane
          title="待機"
          hint="Parked by the orchestrator, with what each waits for. The soonest check-back first."
          tone="waiting"
          count={board.waiting.length}
          empty="待機しているものはありません。"
          folded={folded.waiting}
          onFold={() => {
            fold("waiting");
          }}
        >
          {board.waiting.map(card)}
        </Lane>
        {/* Work going on outside any task: agents and items the orchestrator
            is asked to give a task. No heading when there is none. */}
        {untasked.length === 0 ? null : (
          <Lane
            title="タスクなし"
            hint="Needs a task: a managed agent bound to none, or an Issue or PR of yours no task links. The orchestrator is asked to give each one."
            tone="action"
            count={untasked.length}
            empty=""
          >
            {untasked.map((one) => (
              <li key={one.key}>
                <div
                  className="orchestrator-card orchestrator-untasked"
                  data-untasked={one.key}
                >
                  <span className="orchestrator-card-head">
                    <span
                      className="orchestrator-needs-mark"
                      aria-hidden="true"
                    >
                      △
                    </span>
                    <span className="orchestrator-card-title">{one.line}</span>
                    <span className="orchestrator-card-age">
                      {span(now - one.since)}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </Lane>
        )}
        <Lane
          title="完了"
          hint="Done tasks, most recent first, with what each came to."
          tone="closed"
          count={board.done.length}
          empty="完了したものはまだありません。"
          folded={folded.closed}
          onFold={() => {
            fold("closed");
          }}
        >
          {board.done.map(card)}
        </Lane>
      </div>
      {open === undefined ? null : (
        <TaskView
          key={open.id}
          task={open}
          now={now}
          leaving={!reading}
          orchestratorAgentId={board.orchestratorAgentId}
          base={taskBase(open, workspaces, board.start.root)}
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
  readonly tone: "ask" | "progress" | "waiting" | "action" | "closed";
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

/** How long the task has stood as it is, as its card says it. */
function taskAge(task: TaskWire, now: number): string {
  switch (task.status) {
    case "answer": {
      const asked = Math.min(
        ...openQuestions(task).map((one) => one.question.at),
      );
      return span(now - asked);
    }
    case "done":
      return `done ${span(now - (task.done?.at ?? task.updatedAt))} ago`;
    default:
      return span(now - task.updatedAt);
  }
}

function TaskCard({
  task,
  now,
  onOpen,
}: {
  readonly task: TaskWire;
  readonly now: number;
  readonly onOpen: () => void;
}) {
  const open = task.status !== "done";
  const questions = openQuestions(task);
  const picture = questions.map(firstPicture).find((one) => one !== undefined);
  return (
    <li>
      <button
        type="button"
        className={`orchestrator-card${picture === undefined ? "" : " has-picture"}`}
        data-task-id={task.id}
        data-needs-action={task.needsAction === undefined ? undefined : "true"}
        onClick={onOpen}
      >
        {picture === undefined ? null : <CardPicture path={picture} />}
        <span className="orchestrator-card-head">
          <span className="orchestrator-card-id">#{task.id}</span>
          <span className="orchestrator-card-title">{task.title}</span>
          {task.needsAction === undefined ? null : (
            <span
              className="orchestrator-needs-mark"
              title={`要対応: ${task.needsAction}`}
              aria-label={`要対応: ${task.needsAction}`}
            >
              △
            </span>
          )}
          <span className="orchestrator-card-age">{taskAge(task, now)}</span>
        </span>
        {/* The question waiting on the person: the card's first say. */}
        {questions.map((one) => (
          <span key={one.id} className="orchestrator-card-question">
            <span
              className="orchestrator-card-question-mark"
              aria-hidden="true"
            >
              ?
            </span>
            <span className="orchestrator-card-question-text">
              {decisionText(one.question.markdown) || one.title}
            </span>
            {one.question.options === undefined ? null : (
              <span className="orchestrator-chip">
                選択肢 {one.question.options.length}
              </span>
            )}
          </span>
        ))}
        {task.status === "waiting" &&
        (task.waitNote !== undefined || task.checkAt !== undefined) ? (
          <span className="orchestrator-card-trigger">
            <span className="orchestrator-card-trigger-text">
              {task.waitNote ?? "待機"}
            </span>
            {task.checkAt === undefined ? null : (
              <span className="orchestrator-card-due">
                {clockText(task.checkAt)} · {dueWords(task.checkAt, now)}
              </span>
            )}
          </span>
        ) : null}
        {task.memo === undefined || !open ? null : (
          <span className="orchestrator-card-memo">{task.memo.text}</span>
        )}
        {task.done?.note === undefined ? null : (
          <span className="orchestrator-card-memo">{task.done.note}</span>
        )}
        <span className="orchestrator-card-meta">
          {open && task.priority === "high" ? (
            <span className="orchestrator-chip is-priority" data-rank="high">
              優先
            </span>
          ) : null}
          {open && task.priority === "low" ? (
            <span className="orchestrator-chip is-priority" data-rank="low">
              低
            </span>
          ) : null}
          {task.request === undefined ? null : (
            <span
              className="orchestrator-chip is-request"
              title={task.request.text}
            >
              {task.request.sentAt === undefined ? "依頼 · 送信待ち" : "依頼"}
            </span>
          )}
          {open && task.mayBeStale !== undefined ? (
            <span
              className="orchestrator-chip is-stale"
              title={`May be stale: ${task.mayBeStale.reasons.join("; ")}`}
            >
              古いかも
            </span>
          ) : null}
          {task.links.map((link) => (
            <span key={link} className="orchestrator-chip is-link-label">
              {task.linkLabels?.[link] ?? linkLabel(link)}
            </span>
          ))}
          {task.agents
            .filter((agent) => agent.live || open)
            .map((agent) => (
              <span key={agent.agentId} className="orchestrator-chip is-agent">
                {agent.status === undefined ? null : (
                  <StatusMark
                    status={agent.status as AgentStatus}
                    unread={undefined}
                  />
                )}
                {agent.name}
              </span>
            ))}
        </span>
        {open && task.mayBeStale !== undefined ? (
          <span className="orchestrator-card-why is-stale">
            古いかも: {task.mayBeStale.reasons.join("; ")}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** `11/12 15:00`, in this Mac's time zone. */
function clockText(at: number): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** How far off a time is: `あと 3日`, `あと 5h`, `あと 20m`, `時刻を過ぎました`. */
export function dueWords(dueAt: number, now: number): string {
  const ms = dueAt - now;
  if (ms <= 0) return "時刻を過ぎました";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `あと ${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `あと ${String(hours)}h`;
  return `あと ${String(Math.round(hours / 24))}日`;
}

// --- one task -------------------------------------------------------------------

const STATUS_LABEL: Record<TaskWire["status"], string> = {
  answer: "回答待ち",
  in_progress: "処理中",
  waiting: "待機",
  done: "完了",
};

function TaskView({
  task,
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
  readonly task: TaskWire;
  readonly now: number;
  /** Going back to the board: drawn while it slides out, and not used. */
  readonly leaving: boolean;
  readonly orchestratorAgentId: string | undefined;
  readonly onBack: () => void;
  /** What its relative paths are relative to (`taskBase`). */
  readonly base: string | undefined;
  readonly workspaces: AppSnapshot["workspaces"];
  /** The person's answer went out. */
  readonly onAnswered: (taskId: number) => void;
  readonly onFocusAgent: (agentId: string) => void;
  readonly onFocusWorkspace: (workspaceId: string) => void;
}) {
  const pathsOn = task.agents.at(-1)?.agentId ?? orchestratorAgentId;
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const jumps = taskWorkspaces(task, workspaces);
  const questions = openQuestions(task);
  const scrollKey = `task:${String(task.id)}`;
  const count = task.escalations.length;
  // Coming back to the same task, it is where it was left; a new question
  // since is read from the top, where the open questions are.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const left = placed.current ? undefined : memory.scroll.get(scrollKey);
    placed.current = true;
    element.scrollTop =
      left !== undefined && left.entries === count ? left.top : 0;
  }, [scrollKey, count]);
  // Opened: focus goes to the answer when one is asked for, else to the
  // view — and only from inside the board, never from elsewhere.
  useEffect(() => {
    const element = root.current;
    if (
      !focusIsOurs(element?.closest<HTMLElement>(".orchestrator-board") ?? null)
    )
      return;
    const target =
      questions.length > 0
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
        // Esc goes back; in a composer, only while nothing is written.
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
          <span className="orchestrator-card-id">#{task.id}</span>
          <h2>{task.title}</h2>
          {task.needsAction === undefined ? null : (
            <span
              className="orchestrator-needs-mark"
              title={`要対応: ${task.needsAction}`}
            >
              △ {task.needsAction}
            </span>
          )}
          <span className="orchestrator-state" data-state={task.status}>
            {STATUS_LABEL[task.status]}
          </span>
        </div>
        {task.status !== "done" && task.mayBeStale !== undefined ? (
          <p className="orchestrator-reading-stale">
            <span className="orchestrator-chip is-stale">古いかも</span>
            {task.mayBeStale.reasons.join("; ")}
            <span className="orchestrator-reading-stale-note">
              {" "}
              — DevHub が見たところ。次の triage
              でオーケストレーターが確かめます
            </span>
          </p>
        ) : null}
        {task.agents.length > 0 || task.links.length > 0 ? (
          <div className="orchestrator-reading-refs">
            {task.agents.flatMap((agent) => [
              <button
                key={agent.agentId}
                type="button"
                className="orchestrator-chip is-agent is-link"
                disabled={!agent.live}
                title={
                  agent.live
                    ? `Show ${agent.name} — talk to it directly`
                    : agent.resumable
                      ? `${agent.name} is stopped; the orchestrator can resume it (agent resume task=${String(task.id)})`
                      : `${agent.name} is stopped`
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
                {agent.name}
                {agent.live ? null : (
                  <span className="orchestrator-chip-sub">
                    {agent.resumable ? "停止 · 再開できる" : "停止"}
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
            {task.links.map((link) => (
              <LinkChip
                key={link}
                link={link}
                label={task.linkLabels?.[link]}
              />
            ))}
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
            entries: count,
          });
        }}
        aria-label={`#${String(task.id)} ${task.title}`}
      >
        {task.status === "waiting" &&
        (task.waitNote !== undefined || task.checkAt !== undefined) ? (
          <div className="orchestrator-task-wait">
            <span className="orchestrator-task-label">待機</span>
            {task.waitNote ?? ""}
            {task.checkAt === undefined
              ? ""
              : ` (${clockText(task.checkAt)} · ${dueWords(task.checkAt, now)} に見直す)`}
          </div>
        ) : null}
        {task.memo === undefined ? null : (
          <div className="orchestrator-memo" aria-label="Memo">
            <span className="orchestrator-task-label">メモ</span>
            <span className="orchestrator-entry-time">
              {span(now - task.memo.at)} ago
            </span>
            <div className="orchestrator-memo-text">
              <RichText source={task.memo.text} agentId={pathsOn} cwd={base} />
            </div>
          </div>
        )}
        {task.request === undefined ? null : (
          <article className="orchestrator-entry" data-role="human">
            <div className="orchestrator-entry-byline">
              You · 依頼
              <span className="orchestrator-entry-time">
                {span(now - task.request.at)} ago
                {task.request.sentAt === undefined ? " · 送信待ち" : ""}
              </span>
            </div>
            <div className="orchestrator-entry-body">
              <RichText
                source={task.request.text}
                agentId={pathsOn}
                cwd={base}
              />
            </div>
          </article>
        )}
        {questions.map((one) => (
          <article
            key={one.id}
            className="orchestrator-entry orchestrator-question"
            data-role="orchestrator"
            data-escalation-id={one.id}
          >
            <div className="orchestrator-entry-byline">
              <span className="orchestrator-card-id">質問 #{one.id}</span>{" "}
              {one.title}
              <span className="orchestrator-entry-time">
                {span(now - one.question.at)} ago
              </span>
            </div>
            {one.links.length === 0 ? null : (
              <div className="orchestrator-reading-refs">
                {one.links.map((link) => (
                  <LinkChip
                    key={link}
                    link={link}
                    label={one.linkLabels?.[link]}
                  />
                ))}
              </div>
            )}
            <div className="orchestrator-entry-body">
              <RichText
                source={one.question.markdown}
                agentId={pathsOn}
                cwd={base}
              />
            </div>
            <AnswerComposer escalation={one} onAnswered={onAnswered} />
          </article>
        ))}
        {task.done === undefined ? null : (
          <div className="orchestrator-closed-note">
            完了 {span(now - task.done.at)} ago
            {task.done.note === undefined ? "" : ` — ${task.done.note}`}
          </div>
        )}
        {questions.length === 0 && task.status !== "done" ? (
          <div className="orchestrator-closed-note">
            {task.status === "waiting"
              ? "待機しているタスクです。オーケストレーターが条件を確かめて再開します。"
              : "処理中のタスクです。あなたに決めてほしいことがあれば、ここに質問が出ます。"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A link of a task or a question: a `devhub:` chip, or a URL with its label. */
function LinkChip({
  link,
  label,
}: {
  readonly link: string;
  readonly label: string | undefined;
}) {
  if (isDevhubLink(link)) return <DevhubLink href={link} />;
  return (
    <button
      type="button"
      className="orchestrator-chip is-link"
      title={link}
      onClick={() => {
        void devhub().openExternalUrl(link);
      }}
    >
      {label === undefined ? (
        linkLabel(link)
      ) : (
        <>
          {label}
          <span className="orchestrator-chip-sub">{linkLabel(link)}</span>
        </>
      )}
    </button>
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
 * The first picture kept with the question — an `--attach`, or an image its
 * body named, both copied into its own folder when it was asked: the card's
 * thumbnail.
 */
export function firstPicture(escalation: EscalationWire): string | undefined {
  for (const match of escalation.question.markdown.matchAll(
    /!\[[^\]\n]*\]\(\s*<([^>\n]+)>/gu,
  )) {
    const path = match[1]!;
    if (/\/devhub\/escalations\/\d+\/[^/]+$/u.test(path)) return path;
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
  /** The answer went out: its task's id. */
  readonly onAnswered: (taskId: number) => void;
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
  const options =
    escalation.state === "open" ? (escalation.question.options ?? []) : [];
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
            onAnswered(escalation.taskId);
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
    [
      escalation.id,
      escalation.taskId,
      reportFailure,
      sending,
      onAnswered,
      setText,
    ],
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
              options.length > 0
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
