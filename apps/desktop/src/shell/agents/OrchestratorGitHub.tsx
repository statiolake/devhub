/**
 * The board header's GitHub pill: `GitHub` and a dot for how polling stands
 * — green active, grey suspended by the pause, hollow idle, amber backing
 * off (a failed poll, or a low rate limit) — and, on hover or focus, a small
 * card with what `orchestrator status` says of it: how many open items
 * (Issues, pull requests) of the registered Projects are assigned to me
 * — or why that is not known — what is being read until it is, the last
 * error and where it came from, the Projects (links to them), the state and
 * why, the last poll (when it was sent, and how it went) and the next (when
 * it is to be sent, never before the last: `pollTimes`), the rate limit left.
 *
 * The card is in this page, under the pill, and the pointer may move into
 * it to click a board: it closes a moment after the pointer leaves both.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import type { OrchestratorBoardWire } from "../../ipc/contract";
import {
  githubHealth,
  pollTimes,
  projectUrl,
} from "../../model/orchestratorSettings";
import { devhub } from "./client";

/** How long the card stays once the pointer has left the pill and it. */
export const GITHUB_CARD_LINGER_MS = 200;

/** `14:05:09`, in the person's locale. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The population's size, or why it is not known: never a bare "not read
 * yet" — paused, not polled, failing (the Last error says what) or still
 * being read (Reading says what).
 */
export function assignedWords(github: OrchestratorBoardWire["github"]): string {
  if (github.assigned !== undefined)
    return `${String(github.assigned)} open items`;
  if (github.state === "idle") return "not polled";
  if (github.state === "suspended") return "not known: events are paused";
  if (github.problem !== undefined) return "not known: see Last error";
  return "not known yet: reading";
}

const HEALTH_LABEL = {
  active: "Active",
  suspended: "Suspended",
  idle: "Idle",
  backing_off: "Backing off",
} as const;

/**
 * A header card's hover and focus: shown on enter or focus, gone a moment
 * (`GITHUB_CARD_LINGER_MS`) after the pointer or focus has left the wrap and
 * the card, at once on Escape. Spread `wrap` on the element holding both.
 */
export function useHoverCard() {
  const [shown, setShown] = useState(false);
  const linger = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback(() => {
    clearTimeout(linger.current);
    setShown(true);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(linger.current);
    linger.current = setTimeout(() => {
      setShown(false);
    }, GITHUB_CARD_LINGER_MS);
  }, []);
  useEffect(() => () => clearTimeout(linger.current), []);
  return {
    shown,
    wrap: {
      onMouseEnter: show,
      onMouseLeave: hide,
      onFocus: show,
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          hide();
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === "Escape" && shown) {
          event.stopPropagation();
          setShown(false);
        }
      },
    },
  };
}

export function GitHubPill({
  github,
  orchestratorAgentId,
}: {
  readonly github: OrchestratorBoardWire["github"];
  readonly orchestratorAgentId: string | undefined;
}) {
  const { shown, wrap } = useHoverCard();
  const { health, why } = githubHealth(github);
  const idleWhy =
    orchestratorAgentId === undefined
      ? "no orchestrator is running"
      : "[orchestrator.github] projects names no Project: the population is empty";
  const boards = github.boards ?? [];
  const polls = pollTimes(github);
  return (
    <span className="orchestrator-github-wrap" {...wrap}>
      <button
        type="button"
        className="orchestrator-github"
        data-health={health}
        aria-expanded={shown}
        aria-controls="orchestrator-github-card"
        aria-label={`GitHub: ${HEALTH_LABEL[health].toLowerCase()}`}
      >
        <span className="orchestrator-github-dot" aria-hidden="true" />
        GitHub
      </button>
      {shown ? (
        <div
          id="orchestrator-github-card"
          className="orchestrator-github-card"
          role="dialog"
          aria-label="GitHub polling"
        >
          <div className="orchestrator-github-line">
            <span className="orchestrator-github-dot" data-health={health} />
            <strong>{HEALTH_LABEL[health]}</strong>
            {health === "backing_off" && why !== undefined ? (
              <span>: {why === github.problem ? "see Last error" : why}</span>
            ) : health === "suspended" ? (
              <span>: events are paused, GitHub is not asked</span>
            ) : health === "idle" ? (
              <span>: {idleWhy}</span>
            ) : null}
          </div>
          {boards.length === 0 ? null : (
            <ul className="orchestrator-github-boards" aria-label="Projects">
              {boards.map((board) => {
                const url = projectUrl(board.ref);
                return (
                  <li key={board.ref}>
                    {url === undefined ? (
                      board.ref
                    ) : (
                      <a
                        href={url}
                        onClick={(event) => {
                          event.preventDefault();
                          void devhub().openExternalUrl(url);
                        }}
                      >
                        {board.ref}
                      </a>
                    )}
                    {board.title === undefined ? null : (
                      <span className="orchestrator-github-title">
                        {" "}
                        {board.title}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <dl className="orchestrator-github-facts">
            <dt>Assigned to me</dt>
            <dd>{assignedWords(github)}</dd>
            {github.reading === undefined ? null : (
              <>
                <dt>Reading</dt>
                <dd>{github.reading}</dd>
              </>
            )}
            {github.problem === undefined ? null : (
              <>
                <dt>Last error</dt>
                <dd className="orchestrator-github-problem">
                  {github.problemAt === undefined
                    ? null
                    : `since ${clockTime(github.problemAt)}: `}
                  {github.problem}
                </dd>
              </>
            )}
            {polls.last === undefined ? null : (
              <>
                <dt>Last poll</dt>
                <dd>
                  {clockTime(polls.last.at)}
                  {polls.last.outcome === "failed"
                    ? ": failed, see Last error"
                    : `: ${polls.last.outcome}`}
                </dd>
              </>
            )}
            {polls.next === undefined ? null : (
              <>
                <dt>Next poll</dt>
                <dd>
                  {typeof polls.next === "number"
                    ? clockTime(polls.next)
                    : polls.next}
                </dd>
              </>
            )}
            {github.rateLimit === undefined ? null : (
              <>
                <dt>Rate limit</dt>
                <dd>
                  {github.rateLimit.remaining.toLocaleString()} /{" "}
                  {github.rateLimit.limit.toLocaleString()} left
                </dd>
              </>
            )}
          </dl>
        </div>
      ) : null}
    </span>
  );
}
