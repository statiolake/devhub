import { useCallback } from "react";
import { AppShellProvider } from "./AppShellContext";
import { type AppShellClient } from "./client";
import { useAppShell } from "./useAppShell";
import { Sidebar } from "../components/sidebar/Sidebar";
import { TitlebarActivities } from "../components/shell/TitlebarActivities";
import { SurfaceViewport } from "../components/shell/SurfaceViewport";

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
  const { state, intentError, dispatch, retry } = useAppShell();
  const onDispatch = useCallback(
    (intent: Parameters<typeof dispatch>[0]) => {
      void dispatch(intent);
    },
    [dispatch],
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
    <main className="app-shell" data-readiness={state.snapshot.readiness}>
      <TitlebarActivities snapshot={state.snapshot} onDispatch={onDispatch} />
      <div className="workbench">
        <Sidebar snapshot={state.snapshot} />
        <SurfaceViewport
          snapshot={state.snapshot}
          intentError={intentError?.summary}
        />
      </div>
    </main>
  );
}

export const ShellApp = AppShell;
