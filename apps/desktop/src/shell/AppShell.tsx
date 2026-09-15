/**
 * The window's own page: what is left of the window when every other part of
 * it is a view of its own.
 *
 * # What this page is
 *
 * The title bar over both columns when `appearance.title_bar` says `shown`,
 * the three states in which there is no child view to draw — starting, stopped
 * before it started, and nothing selected — and the seam between the two
 * halves of a split. The Sidebar, the Agents, the notices and the questions
 * are children of the window in their own right and are drawn over this page,
 * not in it.
 *
 * # Its contract with main
 *
 * - **reads**: the snapshot, the appearance, the window's name, and the
 *   palette it was served wearing.
 * - **is pushed**: `snapshotChanged`, `appearanceChanged`, `themeChanged`,
 *   `windowTitleChanged`, `workbenchAreaChanged` (where main laid the
 *   workbench, so this page leaves that hole), `editorRestarting`.
 * - **asks**: `dispatch`, `openModal` (a confirmation, which is drawn on the
 *   `picker` view), `closeWorkspace`, `chooseWorkspaceFolder`, `openSettings`,
 *   `previewLayout` (the split ratio under the pointer, while a drag lasts).
 * - **draws no failure it raised.** What goes wrong here is handed to main and
 *   drawn on the `toasts` view. The one exception is the failure that stopped
 *   this page from starting at all, which fills the content area, because
 *   there is nothing behind it to draw instead.
 *
 * # `window.innerWidth` is not the window
 *
 * This document is a `BrowserWindow`'s own page and the others are views, but
 * the same rule holds for all of them: what a page measures is stale for a
 * frame after main moves it, and nothing here reads it. Where anything is, is
 * `main/shell/windowLayout.ts`.
 */

import { useCallback } from "react";
import { ShellPageProvider, useShellPage } from "./ShellPageContext";
import { TitleBar } from "./components/shell/TitleBar";
import { SurfaceViewport } from "./components/shell/SurfaceViewport";
import type { AppError } from "../ipc/appShell";
import { Failure, Waiting } from "./components/shell/SurfaceState";

export function AppShell() {
  return (
    <ShellPageProvider>
      <Workbench />
    </ShellPageProvider>
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
  const { state, appearance, dispatch, retry, openSettings } = useShellPage();
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

  return (
    <main
      className="app-shell"
      data-readiness={state.snapshot.readiness}
      data-sidebar-density={appearance?.sidebarDensity ?? "compact"}
      data-title-bar={appearance?.titleBar ?? "shown"}
    >
      {/* Nothing here says "over here". An unread Agent is announced by the
          window itself — a Dock badge, and a critical bounce while DevHub is
          not in front — because a ring drawn in this document is behind every
          workbench view, which is to say hidden whenever there is an editor on
          screen. See `main/shell/windowAttention.ts`. */}
      {/* Written once, for both chromes, the way `SidebarHeader` is: which of
          the two windows this page is in is answered in the stylesheet and
          nowhere else, so nothing here has to ask. With `hidden` the bar is
          not drawn and the Sidebar keeps the lights' band itself. */}
      <TitleBar
        sidebarCollapsed={state.snapshot.sidebar.collapsed}
        onDispatch={onDispatch}
      />
      {/* No Sidebar here either, and no Agent's pane. Both are children of
          the window in their own right — `shell/sidebar` and `shell/agents` —
          which is what lets the owner put an Agent beside an editor, or an
          editor over a rail, without either page knowing the other exists.
          What is left of the content area is the three states in which there
          is no child view to show, and the seam of a split. */}
      <div className="app-shell-content">
        <SurfaceViewport snapshot={state.snapshot} />
        {/* No notices here. What the application has to say is drawn on the
            `toasts` view, above every workbench — which is the one placement
            with neither of the limits this page could offer it. See
            `toasts/ToastStack.tsx`. */}
      </div>
    </main>
  );
}
