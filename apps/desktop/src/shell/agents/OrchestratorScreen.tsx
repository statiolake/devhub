/**
 * The Orchestrator screen's left half: the board, and an escalation opened
 * on it.
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
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  EscalationWire,
  OrchestratorBoardWire,
  UnaccountedAgentWire,
} from "../../ipc/contract";
import type { AgentStatus, AppSnapshot } from "../../ipc/appShell";
import { Markdown } from "../conversation/Markdown";
import {
  AgentCwdProvider,
  ConversationActionsProvider,
  type ConversationActions,
} from "../conversation/ConversationContext";
import { PathLinks, PathLinksProvider } from "../conversation/pathLinks";
import { useMessageKeys, SEND_KEY } from "../conversation/messageKeys";
import { SendIcon } from "../conversation/icons";
import { StatusMark } from "../components/sidebar/StatusMark";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";

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

/**
 * What the conversation's renderer asks of the page, for an escalation's
 * thread: links, copies and diagrams through the bridge; a file path is
 * looked up on the agent the escalation is about (or the orchestrator's).
 * Nothing here sends anything to an agent — the composer below is the
 * board's own.
 */
function useThreadActions(
  agentId: string | undefined,
  reportFailure: (error: unknown) => void,
): ConversationActions {
  return useMemo(() => {
    const bridge = devhub();
    const none = () =>
      Promise.reject(new Error("an escalation's thread sends nothing"));
    return {
      writeClipboard: (text) => bridge.writeClipboard(text),
      writeClipboardImage: (png) => bridge.writeClipboardImage(png),
      writeClipboardRich: (content) => bridge.writeClipboardRich(content),
      saveSlidesPdf: (request) => bridge.saveSlidesPdf(request),
      saveSlideImages: (request) => bridge.saveSlideImages(request),
      showContextMenu: (request) => bridge.showContextMenu(request),
      openExternalUrl: (url) => bridge.openExternalUrl(url),
      send: none,
      startEditingPending: none,
      editPending: none,
      stopEditingPending: none,
      removePending: none,
      sendPendingNow: none,
      instruct: none,
      rewind: none,
      cancelLimitResume: none,
      interrupt: none,
      stopTask: none,
      answer: none,
      setSetting: none,
      cliDefaults: () => Promise.resolve(undefined),
      setCliDefault: none,
      openResume: () => undefined,
      openMcp: () => undefined,
      restart: none,
      saveDraft: () => Promise.resolve(),
      resolvePaths: (cwd, paths) =>
        agentId === undefined
          ? Promise.resolve(paths.map(() => null))
          : bridge.conversation.resolvePaths(agentId, cwd, paths),
      readEmbedFile: (path) =>
        agentId === undefined
          ? Promise.resolve(null)
          : bridge.conversation.readEmbedFile(agentId, path),
      embedSignature: (path) =>
        agentId === undefined
          ? Promise.resolve(null)
          : bridge.conversation.embedSignature(agentId, path),
      openFile: (path, range) =>
        agentId === undefined
          ? none()
          : bridge.conversation.openFile(agentId, path, range),
      reportFailure,
    } satisfies ConversationActions;
  }, [agentId, reportFailure]);
}

/** The conversation's renderer, set up for a thread outside a conversation. */
function RichText({
  source,
  agentId,
}: {
  readonly source: string;
  readonly agentId: string | undefined;
}) {
  const { reportFailure } = useAgents();
  const actions = useThreadActions(agentId, reportFailure);
  const links = useMemo(
    () => new PathLinks(actions.resolvePaths, actions.reportFailure),
    [actions],
  );
  return (
    <ConversationActionsProvider value={actions}>
      <PathLinksProvider value={links}>
        <AgentCwdProvider value={undefined}>
          <Markdown source={source} streaming={false} />
        </AgentCwdProvider>
      </PathLinksProvider>
    </ConversationActionsProvider>
  );
}

// --- the board ----------------------------------------------------------------

type Opened = { readonly kind: "escalation"; readonly id: number } | undefined;

export function OrchestratorBoard({
  snapshot,
}: {
  readonly snapshot: AppSnapshot;
}) {
  const { board, reportFailure, dispatch } = useAgents();
  const now = useNow();
  const [opened, setOpened] = useState<Opened>(undefined);
  const [history, setHistory] = useState(false);
  const all = useMemo(
    () => [...board.needsAnswer, ...board.inProgress, ...board.closed],
    [board],
  );
  const open =
    opened === undefined ? undefined : all.find((one) => one.id === opened.id);
  const focusAgent = useCallback(
    (agentId: string) => {
      void dispatch({
        type: "select_context",
        context: { kind: "agent", agentId },
      });
    },
    [dispatch],
  );
  const orchestrator = snapshot.workspaces
    .flatMap((workspace) => workspace.agents)
    .find((agent) => agent.id === board.orchestratorAgentId);
  return (
    <section
      className="orchestrator-board"
      aria-label="Orchestrator board"
      data-reading={open === undefined ? undefined : "true"}
    >
      <header className="orchestrator-board-header">
        <div className="orchestrator-board-title">
          <h1>Board</h1>
          <span className="orchestrator-board-counts">
            {board.needsAnswer.length} 要回答 · {board.inProgress.length} 対応中
            {board.unaccounted.length > 0
              ? ` · ${String(board.unaccounted.length)} 不明`
              : ""}
          </span>
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
        </div>
      </header>
      {open === undefined ? (
        <div className="orchestrator-lanes">
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
                  setOpened({ kind: "escalation", id: one.id });
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
                  setOpened({ kind: "escalation", id: one.id });
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
                    setOpened({ kind: "escalation", id: one.id });
                  }}
                />
              ))}
            </Lane>
          ) : null}
        </div>
      ) : (
        <EscalationView
          key={open.id}
          escalation={open}
          now={now}
          orchestratorAgentId={board.orchestratorAgentId}
          onBack={() => {
            setOpened(undefined);
          }}
          onFocusAgent={focusAgent}
        />
      )}
    </section>
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
    .find((entry) => entry.role === "orchestrator");
  const age =
    escalation.state === "needs_answer"
      ? `${span(now - escalation.stateSince)}`
      : escalation.state === "in_progress"
        ? `answered ${span(now - escalation.stateSince)} ago`
        : `closed ${span(now - escalation.stateSince)} ago`;
  const followUp =
    escalation.state === "needs_answer" &&
    escalation.entries.some((entry) => entry.role === "human");
  return (
    <li>
      <button type="button" className="orchestrator-card" onClick={onOpen}>
        <span className="orchestrator-card-head">
          <span className="orchestrator-card-id">#{escalation.id}</span>
          <span className="orchestrator-card-title">{escalation.title}</span>
          <span className="orchestrator-card-age">{age}</span>
        </span>
        <span className="orchestrator-card-preview">
          {escalation.state === "in_progress" && last?.role === "human"
            ? `↳ ${preview(last.markdown)}`
            : preview(question?.markdown ?? "")}
        </span>
        <span className="orchestrator-card-meta">
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
      </button>
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
  orchestratorAgentId,
  onBack,
  onFocusAgent,
}: {
  readonly escalation: EscalationWire;
  readonly now: number;
  readonly orchestratorAgentId: string | undefined;
  readonly onBack: () => void;
  readonly onFocusAgent: (agentId: string) => void;
}) {
  const pathsOn = escalation.agents[0]?.agentId ?? orchestratorAgentId;
  const scroller = useRef<HTMLDivElement>(null);
  // A new entry is read from its start: the newest is at the bottom.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [escalation.entries.length]);
  return (
    <div
      className="orchestrator-reading"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !(event.target instanceof HTMLTextAreaElement)
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
          ‹ Board
        </button>
        <div className="orchestrator-reading-title">
          <span className="orchestrator-card-id">#{escalation.id}</span>
          <h2>{escalation.title}</h2>
          <span className="orchestrator-state" data-state={escalation.state}>
            {STATE_LABEL[escalation.state]}
          </span>
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
      >
        {escalation.entries.map((entry, index) => (
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
        ))}
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
        <AnswerComposer escalation={escalation} />
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
}: {
  readonly escalation: EscalationWire;
}) {
  const { reportFailure } = useAgents();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
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
      void devhub()
        .answerEscalation(escalation.id, words)
        .then(() => {
          setText("");
        }, reportFailure)
        .finally(() => {
          setSending(false);
        });
    },
    [escalation.id, reportFailure, sending],
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
