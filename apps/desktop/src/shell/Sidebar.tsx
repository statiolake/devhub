/**
 * The workspace source list.
 *
 * A row is a workspace: a folder DevHub remembers, and — once it has been
 * selected at least once — a workbench view kept alive behind the scenes.
 */

import type { ShellState } from "../ipc/contract";

export interface SidebarProps {
  readonly state: ShellState;
  readonly onSelect: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onAdd: () => void;
}

export function Sidebar({ state, onSelect, onRemove, onAdd }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="Workspace navigation">
      <div className="sidebar-titlebar" />
      <div className="sidebar-scroll-region">
        <div className="sidebar-section-heading">
          <h2>Workspaces</h2>
          <button
            className="section-action-button"
            type="button"
            aria-label="Add workspace"
            title="Add workspace"
            onClick={onAdd}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          </button>
        </div>

        {state.workspaces.length === 0 ? (
          <p className="sidebar-empty">No workspaces yet.</p>
        ) : (
          <ul className="workspace-tree">
            {state.workspaces.map((workspace) => (
              <li key={workspace.id}>
                <div
                  className={`sidebar-row workspace-row${
                    workspace.id === state.selectedId ? " is-selected" : ""
                  }`}
                  data-workspace-id={workspace.id}
                >
                  <span className="disclosure-spacer" />
                  <button
                    className="sidebar-context-button"
                    type="button"
                    title={workspace.path}
                    onClick={() => onSelect(workspace.id)}
                  >
                    <span className="row-glyph">
                      <svg
                        viewBox="0 0 16 16"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M1.8 4.2a1 1 0 0 1 1-1h3l1.4 1.6h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9.4a1 1 0 0 1-1-1z" />
                      </svg>
                    </span>
                    <span className="row-label">{workspace.name}</span>
                    {workspace.opened ? null : (
                      <span className="row-note">not opened</span>
                    )}
                  </button>
                  <button
                    className="row-action-button"
                    type="button"
                    aria-label={`Remove ${workspace.name}`}
                    title={`Remove ${workspace.name}`}
                    onClick={() => onRemove(workspace.id)}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
