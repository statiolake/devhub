/**
 * The page's last catch, and the only one React can reach.
 *
 * `window.error` and `unhandledrejection` catch everything that happens *in*
 * the page, but not a component that threw while rendering: React unmounts the
 * whole tree for that and rethrows, so the failure does arrive at the window
 * handler — with nothing left on screen to draw the answer it produces. A
 * blank window is the one failure DevHub cannot report, because the thing that
 * would report it has just been removed.
 *
 * So there is exactly one of these per page role, immediately inside the root,
 * and it does the two things the rest of the failure rule does everywhere
 * else: it says the failure began here, to main, which journals it and logs
 * it; and it draws it, because on this one path the page it would otherwise be
 * published to is the page that has stopped.
 *
 * It is not a recovery. The tree below it is gone and nothing here puts it
 * back — what is drawn says so, with the words of the failure and the line a
 * report needs. Everything a person can do from here is something they do to
 * the window.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import type { AppError } from "../ipc/appShell";
import { devhub } from "./client";
import { toAppError } from "./failure";

interface PageBoundaryProps {
  readonly children: ReactNode;
}

interface PageBoundaryState {
  readonly error: AppError | undefined;
}

export class PageBoundary extends Component<
  PageBoundaryProps,
  PageBoundaryState
> {
  override state: PageBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): PageBoundaryState {
    return { error: toAppError(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The component stack is the whole diagnosis and React hands it over
    // exactly once, here. It goes to main's log with the failure, because a
    // page that has stopped is not a place to keep a record.
    devhub().raiseFailure({
      ...toAppError(error),
      detail: [toAppError(error).detail, info.componentStack]
        .filter((part) => part !== undefined && part !== null && part !== "")
        .join("\n"),
    });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) return this.props.children;
    return (
      <section
        className="surface"
        aria-label="Error surface"
        aria-live="assertive"
      >
        <div className="surface-state">
          <p className="mac-title">{error.summary}</p>
          {error.detail === undefined ? null : (
            <p className="mac-body">{error.detail}</p>
          )}
          <p className="mac-caption surface-meta">
            {error.module} · {error.code} · {error.runtimeVersion}
          </p>
        </div>
      </section>
    );
  }
}
