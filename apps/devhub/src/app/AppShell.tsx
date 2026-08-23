import { useCallback, useEffect, useRef } from "react";
import { AppShellProvider } from "./AppShellContext";
import { type AppShellClient } from "./client";
import { useAppShell } from "./useAppShell";
import { Sidebar } from "../components/sidebar/Sidebar";
import { TitlebarActivities } from "../components/shell/TitlebarActivities";
import { SurfaceViewport } from "../components/shell/SurfaceViewport";
import type { CloseResourceWire } from "../generated/app-shell";

function closeResourceStatus(resource: CloseResourceWire): string {
  switch (resource.kind) {
    case "clean":
      return "Ready";
    case "busy":
      return `${resource.count} busy`;
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
        case "cleanup_failed":
          return "Could not verify cleanup state";
        case "runtime_unavailable":
          return "Could not verify: runtime unavailable";
      }
  }
  return "Could not verify resource state";
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

function Workbench() {
  const {
    state,
    appearance,
    intentError,
    dispatch,
    retry,
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
  const confirmationRef = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closePurpose = pendingConfirmation?.purpose;
  const pendingAgent =
    pendingConfirmation?.purpose.kind === "agent_stop"
      ? state.status === "ready"
        ? state.snapshot.workspaces
            .flatMap((workspace) => workspace.agents)
            .find((agent) => agent.id === pendingConfirmation.agentId)
        : undefined
      : undefined;
  const pendingConfirmationId = pendingConfirmation?.confirmationId;
  const pendingWorkspaceId = pendingAgent?.workspaceId;

  const restoreFocus = useCallback((target: HTMLElement | null | undefined) => {
    if (
      !target?.isConnected ||
      target.hasAttribute("disabled") ||
      target.getAttribute("aria-hidden") === "true" ||
      target.tabIndex < 0
    ) {
      return false;
    }
    target.focus();
    return document.activeElement === target;
  }, []);

  useEffect(() => {
    if (pendingConfirmationId === undefined) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const dialog = confirmationRef.current;
    const first = dialog?.querySelector<HTMLElement>("button:not([disabled])");
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        dismissCloseConfirmation();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const buttons = [
        ...dialog.querySelectorAll<HTMLElement>("button:not([disabled])"),
      ];
      if (buttons.length === 0) return;
      const index = buttons.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? index <= 0
          ? buttons.length - 1
          : index - 1
        : (index + 1) % buttons.length;
      event.preventDefault();
      buttons[next]?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const restored = restoreFocus(previousFocus.current);
      if (!restored && pendingWorkspaceId) {
        const workspaceButton = [
          ...document.querySelectorAll<HTMLElement>("[data-workspace-id]"),
        ].find((element) => element.dataset.workspaceId === pendingWorkspaceId);
        if (!restoreFocus(workspaceButton)) {
          restoreFocus(
            document.querySelector<HTMLElement>(
              '[aria-label="Workspace navigation"] button:not([disabled])',
            ),
          );
        }
      } else if (!restored) {
        restoreFocus(
          document.querySelector<HTMLElement>(
            '[aria-label="Workspace navigation"] button:not([disabled])',
          ),
        );
      }
      previousFocus.current = null;
    };
  }, [
    dismissCloseConfirmation,
    pendingConfirmationId,
    pendingWorkspaceId,
    restoreFocus,
  ]);
  useEffect(() => {
    if (pendingConfirmation?.purpose.kind === "agent_stop" && !pendingAgent) {
      // Natural-exit reconciliation removes the Agent and its confirmation
      // atomically in Rust. Clear the local dialog as soon as that snapshot
      // arrives instead of leaving a generic stale confirmation behind.
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
        <div className="titlebar titlebar-state" data-tauri-drag-region />
        <section
          className="surface"
          aria-label="Surface"
          aria-busy="true"
          aria-live="polite"
        >
          <div className="surface-state surface-loading-state" role="status">
            <span className="surface-mark" aria-hidden="true">
              ⌁
            </span>
            <p className="surface-kicker">Connecting</p>
            <h1>Waking the local workbench</h1>
            <p className="surface-copy">
              Restoring the immutable application snapshot from the native host.
            </p>
          </div>
        </section>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="app-shell app-shell-state">
        <div className="titlebar titlebar-state" data-tauri-drag-region />
        <section className="surface" aria-label="Surface" aria-live="polite">
          <div className="surface-state surface-error-state" role="alert">
            <span className="surface-mark" aria-hidden="true">
              !
            </span>
            <p className="surface-kicker">Connection error</p>
            <h1>The workbench is unavailable</h1>
            <p className="surface-copy">{state.error.summary}</p>
            <button className="primary-button" type="button" onClick={retry}>
              Try again
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main
      className="app-shell"
      data-readiness={state.snapshot.readiness}
      data-sidebar-density={appearance?.sidebarDensity ?? "compact"}
    >
      <TitlebarActivities snapshot={state.snapshot} onDispatch={onDispatch} />
      <div className="workbench">
        <Sidebar snapshot={state.snapshot} />
        <SurfaceViewport
          snapshot={state.snapshot}
          intentError={intentError?.summary}
          appearance={appearance}
        />
      </div>
      {pendingConfirmation &&
        (pendingConfirmation.purpose.kind !== "agent_stop" || pendingAgent) && (
          <div className="confirmation-backdrop" role="presentation">
            <section
              ref={confirmationRef}
              className="confirmation-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirmation-title"
              aria-describedby="confirmation-description"
            >
              <h2 id="confirmation-title">
                {closeInspection
                  ? `Close ${closeInspection.workspaceLabel}?`
                  : pendingAgent
                    ? `Stop ${pendingAgent.displayName}?`
                    : "Confirm action?"}
              </h2>
              <p id="confirmation-description">
                {closeInspection
                  ? "The following workspace resources need confirmation before they are closed."
                  : pendingAgent
                    ? "This stops the Agent runtime. It can be retried if cleanup fails."
                    : "Confirm this operation to continue."}
              </p>
              {resources.length > 0 && (
                <ul className="confirmation-resources">
                  {resources.map(([label, resource]) => (
                    <li key={label}>
                      <span>{label}</span>
                      <span>{closeResourceStatus(resource)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="confirmation-actions">
                <button
                  type="button"
                  onClick={dismissCloseConfirmation}
                  disabled={confirmationBusy}
                >
                  Cancel
                </button>
                {(closeInspection || pendingAgent) && (
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void confirmPending()}
                    disabled={confirmationBusy}
                  >
                    {confirmationBusy
                      ? pendingAgent
                        ? "Stopping…"
                        : "Closing…"
                      : pendingAgent
                        ? "Stop Agent"
                        : "Close workspace"}
                  </button>
                )}
              </div>
            </section>
          </div>
        )}
    </main>
  );
}

export const ShellApp = AppShell;
