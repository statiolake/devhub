/**
 * DevHub's App Shell: the thing outside VS Code.
 *
 * A Sidebar of Workspaces and their Agents, an Activity control in the title
 * bar, and one Surface viewport. The viewport is deliberately a hole for the
 * Editor activity: main lays a workbench `WebContentsView` over it. Everything
 * else on this page is DOM.
 */

import { useCallback } from "react";
import { AppShellProvider } from "./AppShellContext";
import { devhub, type AppShellClient } from "./client";
import { useAppShell } from "./useAppShell";
import { Sidebar } from "./components/sidebar/Sidebar";
import { TitlebarActivities } from "./components/shell/TitlebarActivities";
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
      <div className="app-shell-content">
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
    </main>
  );
}
