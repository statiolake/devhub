/**
 * DevHub's App Shell: the thing outside VS Code.
 *
 * A Sidebar of Workspaces and their Agents, and the content area beside it.
 * There is no title bar and no activity switcher: a Workspace *is* its
 * workbench, full height and full width, and an Agent is that workbench with
 * the Agent's pane beside it. The content area is deliberately a hole — main
 * lays a workbench `WebContentsView` over it — and everything else on this page
 * is DOM, the window's drag handle included, which is now the Sidebar.
 */

import { useCallback } from "react";
import { AppShellProvider } from "./AppShellContext";
import { devhub, type AppShellClient } from "./client";
import { useAppShell } from "./useAppShell";
import { Sidebar } from "./components/sidebar/Sidebar";
import { SurfaceViewport } from "./components/shell/SurfaceViewport";
import type { AppError } from "../ipc/appShell";
import { Failure, Waiting } from "./components/shell/SurfaceState";

export interface AppShellProps {
  readonly client?: AppShellClient;
}

export function AppShell({ client }: AppShellProps) {
  return (
    <AppShellProvider
      client={client}
      // This page draws no modals. A confirmation goes to main, which shows it
      // on the overlay layer above every workbench — the one place in DevHub
      // where a modal can be both seen and answered.
      raiseConfirmation={(confirmation) => {
        void devhub().openModal({
          kind: "close-confirmation",
          ...confirmation,
        });
      }}
    >
      <Workbench />
    </AppShellProvider>
  );
}

/**
 * The whole app could not start.
 *
 * Not an alert: there is nothing to dismiss it back to. It fills the Surface
 * the way any other Surface-level failure does, with the actions the error
 * itself says are worth offering and the identifying line a bug report needs.
 */
function ErrorSurface({
  error,
  retry,
  openSettings,
}: {
  readonly error: AppError;
  readonly retry: () => void;
  readonly openSettings: () => Promise<void>;
}) {
  const actions = [
    ...(error.actions.includes("retry")
      ? [{ label: "Try Again", primary: true, run: retry }]
      : []),
    ...(error.actions.includes("open_settings")
      ? [
          {
            label: "Open Settings",
            run: () => {
              void openSettings();
            },
          },
        ]
      : []),
  ];

  return (
    <section className="surface" aria-label="Error surface" aria-live="polite">
      <Failure
        summary={error.summary}
        detail={error.detail ?? undefined}
        actions={actions}
      />
      <p className="mac-caption surface-meta">
        {error.module} · {error.code} · {error.runtimeVersion}
      </p>
    </section>
  );
}

function Workbench() {
  const { state, appearance, intentError, dispatch, retry, openSettings } =
    useAppShell();
  const onDispatch = useCallback(
    (intent: Parameters<typeof dispatch>[0]) => {
      void dispatch(intent);
    },
    [dispatch],
  );

  if (state.status === "loading") {
    return (
      <main className="app-shell app-shell-state">
        <section
          className="surface"
          aria-label="Surface"
          aria-busy="true"
          aria-live="polite"
        >
          <Waiting label="Starting DevHub…" />
        </section>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="app-shell app-shell-state">
        <ErrorSurface
          error={state.error}
          retry={retry}
          openSettings={openSettings}
        />
      </main>
    );
  }

  /**
   * Whether anything is waiting for the person, and is not the thing they are
   * looking at.
   *
   * One rule, computed in one place: glow while some Agent is unread and the
   * selection is not that Agent. Opening it reads it, which clears the flag,
   * which stops the glow — so there is no second condition to keep in step and
   * no way for the glow to outlive its reason.
   */
  const selectedAgentId =
    state.snapshot.selection.context.kind === "agent"
      ? state.snapshot.selection.context.agentId
      : undefined;
  const attention = state.snapshot.workspaces.some((workspace) =>
    workspace.agents.some(
      (agent) => agent.unread && agent.id !== selectedAgentId,
    ),
  );

  return (
    <main
      className="app-shell"
      data-readiness={state.snapshot.readiness}
      data-sidebar-density={appearance?.sidebarDensity ?? "compact"}
      data-attention={attention ? "true" : undefined}
    >
      {/* A thin edge that breathes, drawn over the window's own inset — the
          macOS way of saying "over here" without a banner. It is inert to the
          pointer, so nothing under it stops working while it is up. */}
      <div className="attention-glow" aria-hidden="true" />
      <div className="app-shell-content">
        <Sidebar snapshot={state.snapshot} onDispatch={onDispatch} />
        <SurfaceViewport
          snapshot={state.snapshot}
          intentError={intentError ?? undefined}
          appearance={appearance}
        />
      </div>
    </main>
  );
}
