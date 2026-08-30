/**
 * DevHub's App Shell: the thing outside VS Code.
 *
 * A Sidebar of Workspaces and their Agents, an Activity control in the title
 * bar, and one Surface viewport. The viewport is deliberately a hole for the
 * Editor activity: main lays a workbench `WebContentsView` over it. Everything
 * else on this page is DOM.
 */

import { useCallback, useEffect } from "react";
import { AppShellProvider } from "./AppShellContext";
import type { AppShellClient } from "./client";
import { useAppShell } from "./useAppShell";
import { Sidebar } from "./components/sidebar/Sidebar";
import { TitlebarActivities } from "./components/shell/TitlebarActivities";
import { SurfaceViewport } from "./components/shell/SurfaceViewport";
import type { AppError, CloseResourceWire } from "../ipc/appShell";
import { Alert } from "./components/shell/Alert";
import { Failure, Waiting } from "./components/shell/SurfaceState";

function closeResourceStatus(resource: CloseResourceWire): string {
  switch (resource.kind) {
    case "clean":
      return "Ready";
    case "busy":
      return `${String(resource.count)} busy`;
    case "unknown":
      switch (resource.diagnostic) {
        case "root_missing":
          return "Could not verify: workspace root is missing";
        case "root_inaccessible":
          return "Could not verify: workspace root is inaccessible";
        case "close_agents_unknown":
          return "Could not verify agents";
        case "close_terminal_unknown":
          return "Could not verify terminal state";
        case "close_editor_unknown":
          return "Could not verify editor state";
        case "close_editor_vetoed":
          return "The editor has unsaved changes";
        case "cleanup_failed":
          return "Could not verify cleanup state";
        case "runtime_unavailable":
          return "Could not verify: runtime unavailable";
      }
  }
}

export interface AppShellProps {
  readonly client?: AppShellClient;
}

export function AppShell({ client }: AppShellProps) {
  return (
    <AppShellProvider client={client}>
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
  const {
    state,
    appearance,
    intentError,
    dispatch,
    retry,
    openSettings,
    pendingConfirmation,
    confirmationBusy,
    confirmPending,
    dismissCloseConfirmation,
  } = useAppShell();
  const onDispatch = useCallback(
    (intent: Parameters<typeof dispatch>[0]) => {
      void dispatch(intent);
    },
    [dispatch],
  );
  const closePurpose = pendingConfirmation?.purpose;

  const pendingAgent =
    pendingConfirmation?.purpose.kind === "agent_stop"
      ? state.status === "ready"
        ? state.snapshot.workspaces
            .flatMap((workspace) => workspace.agents)
            .find((agent) => agent.id === pendingConfirmation.agentId)
        : undefined
      : undefined;

  useEffect(() => {
    if (pendingConfirmation?.purpose.kind === "agent_stop" && !pendingAgent) {
      // A natural exit removes the Agent and its confirmation together in
      // main. Clear the local dialog as soon as that snapshot arrives rather
      // than leaving a stale confirmation behind.
      dismissCloseConfirmation();
    }
  }, [dismissCloseConfirmation, pendingAgent, pendingConfirmation]);

  const closeInspection =
    closePurpose?.kind === "workspace_close"
      ? closePurpose.inspection
      : undefined;
  const allResources: readonly [string, CloseResourceWire][] = closeInspection
    ? [
        ["Agents", closeInspection.agents],
        ["Terminal processes", closeInspection.terminalProcesses],
        ["Terminal panes", closeInspection.terminalPanes],
        ["Terminal windows", closeInspection.terminalWindows],
        ["Unsaved editors", closeInspection.unsavedEditors],
      ]
    : [];
  const resources = allResources.filter(
    ([, resource]) => resource.kind !== "clean",
  );

  if (state.status === "loading") {
    return (
      <main className="app-shell app-shell-state">
        <div className="titlebar titlebar-state" />
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
        <div className="titlebar titlebar-state" />
        <ErrorSurface
          error={state.error}
          retry={retry}
          openSettings={openSettings}
        />
      </main>
    );
  }

  return (
    <main
      className="app-shell"
      data-readiness={state.snapshot.readiness}
      data-sidebar-density={appearance?.sidebarDensity ?? "compact"}
    >
      <div
        className="app-shell-content"
        inert={pendingConfirmation ? true : undefined}
      >
        {state.snapshot.sidebar.visible ? (
          <Sidebar snapshot={state.snapshot} />
        ) : null}
        <div className="workbench">
          <TitlebarActivities
            snapshot={state.snapshot}
            onDispatch={onDispatch}
          />
          <SurfaceViewport
            snapshot={state.snapshot}
            intentError={intentError ?? undefined}
            appearance={appearance}
          />
        </div>
      </div>
      {pendingConfirmation &&
        (pendingConfirmation.purpose.kind !== "agent_stop" || pendingAgent) && (
          <Alert
            tone="danger"
            title={
              closeInspection
                ? `Close “${closeInspection.workspaceLabel}”?`
                : pendingAgent
                  ? `Stop “${pendingAgent.displayName}”?`
                  : "Confirm this action?"
            }
            message={
              closeInspection
                ? "The workspace has resources open. Closing it will close them."
                : pendingAgent
                  ? "This stops the Agent runtime. You can retry if cleanup fails."
                  : undefined
            }
            detail={resources.map(
              ([label, resource]) =>
                [label, closeResourceStatus(resource)] as const,
            )}
            onCancel={dismissCloseConfirmation}
            actions={[
              {
                label: "Cancel",
                disabled: confirmationBusy,
                run: dismissCloseConfirmation,
              },
              {
                label: confirmationBusy
                  ? pendingAgent
                    ? "Stopping…"
                    : "Closing…"
                  : pendingAgent
                    ? "Stop Agent"
                    : "Close Workspace",
                isDefault: true,
                destructive: true,
                disabled: confirmationBusy,
                run: () => void confirmPending(),
              },
            ]}
          />
        )}
    </main>
  );
}
