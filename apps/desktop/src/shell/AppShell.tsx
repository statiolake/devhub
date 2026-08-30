/**
 * DevHub's App Shell: native chrome around the workbench views.
 *
 * The content area to the right of the sidebar is deliberately empty in the
 * DOM. It is a hole: main lays the selected workspace's `WebContentsView` over
 * exactly this rectangle, which is why the page measures it and reports it
 * rather than drawing anything into it.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ShellState } from "../ipc/contract";
import { devhub } from "./devhub";
import {
  currentFailure,
  dismissFailure,
  reportFailure,
  subscribeToFailures,
  type Failure,
} from "./failures";
import { Sidebar } from "./Sidebar";

const EMPTY_STATE: ShellState = { workspaces: [], selectedId: undefined };

export function AppShell() {
  const [state, setState] = useState<ShellState>(EMPTY_STATE);
  const [failure, setFailure] = useState<Failure | undefined>(currentFailure);
  const contentRef = useRef<HTMLElement | null>(null);

  useEffect(() => subscribeToFailures(setFailure), []);

  useEffect(() => {
    // A rejection here is not handled here: it goes to the root handler, which
    // is the only thing that decides what the person sees.
    void devhub().getState().then(setState).catch(reportFailure);
    return devhub().onStateChanged(setState);
  }, []);

  // The workbench views are native siblings of this document, so the only way
  // main can know where to put them is for the page to measure the hole.
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }
    const report = () => {
      const rect = element.getBoundingClientRect();
      void devhub()
        .setContentRect({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        })
        .catch(reportFailure);
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    report();
    return () => observer.disconnect();
  }, []);

  const onSelect = useCallback((id: string) => {
    void devhub().selectWorkspace(id).catch(reportFailure);
  }, []);
  const onRemove = useCallback((id: string) => {
    void devhub().removeWorkspace(id).catch(reportFailure);
  }, []);
  const onAdd = useCallback(() => {
    void devhub().addWorkspace().catch(reportFailure);
  }, []);

  const selected = state.workspaces.find(
    (workspace) => workspace.id === state.selectedId,
  );

  return (
    <main className="app-shell">
      <div className="app-shell-content">
        <Sidebar
          state={state}
          onSelect={onSelect}
          onRemove={onRemove}
          onAdd={onAdd}
        />
        <div className="workbench">
          <div className="titlebar">
            <div className="titlebar-leading" />
            <div className="titlebar-title">{selected?.name ?? "DevHub"}</div>
            <div className="titlebar-trailing" />
          </div>
          <section className="surface" aria-label="Workspace" ref={contentRef}>
            {failure ? (
              <FailureSurface failure={failure} />
            ) : state.selectedId === undefined ? (
              <div className="surface-state" role="status">
                <p className="surface-line">
                  {state.workspaces.length === 0
                    ? "No workspaces yet. Add a folder to open it here."
                    : "Select a workspace."}
                </p>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

function FailureSurface({ failure }: { readonly failure: Failure }) {
  return (
    <div className="surface-state surface-failure" role="alert">
      <p className="failure-title">
        <svg
          className="failure-icon"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="8" cy="8" r="7" />
          <path d="M8 4.6v4.2M8 11.1v.6" />
        </svg>
        {failure.summary}
      </p>
      <p className="failure-detail">{failure.detail}</p>
      <div className="surface-actions">
        <button className="secondary-button" type="button" onClick={dismissFailure}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
