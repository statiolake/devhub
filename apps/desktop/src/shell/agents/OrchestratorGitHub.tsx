/**
 * The board header's GitHub pill: `github` and a dot for how polling stands
 * — green active, grey suspended by the pause, hollow idle, amber backing
 * off (a failed poll, or a low rate limit) — and, on hover or focus, a small
 * card with what `orchestrator status` says of it: the boards (links to
 * them), the state and why, the last and next poll, the rate limit left.
 *
 * The card is in this page, under the pill, and the pointer may move into
 * it to click a board: it closes a moment after the pointer leaves both.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OrchestratorBoardWire } from "../../ipc/contract";
import { githubHealth, projectUrl } from "../../model/orchestratorSettings";
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

const HEALTH_LABEL = {
  active: "Active",
  suspended: "Suspended",
  idle: "Idle",
  backing_off: "Backing off",
} as const;

export function GitHubPill({
  github,
  orchestratorAgentId,
}: {
  readonly github: OrchestratorBoardWire["github"];
  readonly orchestratorAgentId: string | undefined;
}) {
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
  const { health, why } = githubHealth(github);
  const idleWhy =
    orchestratorAgentId === undefined
      ? "no orchestrator is running"
      : "[orchestrator.github] projects names no board";
  const boards = github.boards ?? [];
  return (
    <span
      className="orchestrator-github-wrap"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          hide();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && shown) {
          event.stopPropagation();
          setShown(false);
        }
      }}
    >
      <button
        type="button"
        className="orchestrator-github"
        data-health={health}
        aria-expanded={shown}
        aria-controls="orchestrator-github-card"
        aria-label={`github: ${HEALTH_LABEL[health].toLowerCase()}`}
      >
        <span className="orchestrator-github-dot" aria-hidden="true" />
        github
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
              <span>: {why}</span>
            ) : health === "suspended" ? (
              <span>: events are paused, GitHub is not asked</span>
            ) : health === "idle" ? (
              <span>: {idleWhy}</span>
            ) : null}
          </div>
          {boards.length === 0 ? null : (
            <ul className="orchestrator-github-boards" aria-label="Boards">
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
            {github.lastAt === undefined ? null : (
              <>
                <dt>Last poll</dt>
                <dd>{clockTime(github.lastAt)}</dd>
              </>
            )}
            {github.nextAt === undefined || github.state !== "active" ? null : (
              <>
                <dt>Next poll</dt>
                <dd>{clockTime(github.nextAt)}</dd>
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
