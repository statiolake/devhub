/**
 * The Sidebar, collapsed: an icon rail.
 *
 * Collapsing a navigation pane on a Mac narrows it to its icons; it does not
 * delete it. So the rail carries exactly what the pane carries and in the same
 * order — Scratch at the top, one tile per Workspace under it, Add at the
 * bottom — and each tile keeps the two things a source-list row has that a
 * label cannot replace: what it is (the glyph) and how its Agents are doing
 * (the status mark, the same one the row draws). The name comes back on hover
 * and is always in the accessibility tree.
 *
 * Selection and dispatch are the pane's, not a second set: a tile sends the
 * same `select_context` intent the row sends, so the two forms cannot disagree
 * about what is selected.
 */

import type {
  AppIntent,
  AppSnapshot,
  WorkspaceSnapshot,
} from "../../../ipc/appShell";
import { StatusMark } from "./StatusMark";
import { statusLabel } from "./status";

/** What the tile says on hover and to a screen reader. */
function workspaceDescription(workspace: WorkspaceSnapshot): string {
  const agents = workspace.agents.length;
  if (agents === 0) return workspace.label;
  return `${workspace.label} — ${String(agents)} ${agents === 1 ? "Agent" : "Agents"}, ${statusLabel(workspace.aggregateStatus)}`;
}

function RailTile({
  label,
  selected,
  onClick,
  children,
}: {
  readonly label: string;
  readonly selected?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      className={`rail-tile${selected ? " is-selected" : ""}`}
      type="button"
      title={label}
      aria-label={label}
      aria-current={selected ? "page" : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export interface SidebarRailProps {
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
  readonly onAddWorkspace: () => void;
}

export function SidebarRail({
  snapshot,
  onDispatch,
  onAddWorkspace,
}: SidebarRailProps) {
  const context = snapshot.selection.context;
  const selectedWorkspaceId =
    context.kind === "workspace" ? context.workspaceId : undefined;
  const agentWorkspaceId =
    context.kind === "agent"
      ? snapshot.workspaces.find((workspace) =>
          workspace.agents.some((agent) => agent.id === context.agentId),
        )?.id
      : undefined;

  return (
    <aside
      className="sidebar sidebar-collapsed"
      aria-label="Workspace navigation"
    >
      {/* The window buttons live on the Sidebar in both of its forms, so the
          rail reserves the same top strip the pane does. */}
      <div className="sidebar-titlebar" />
      <div className="rail-region">
        <RailTile
          label="Scratch"
          selected={context.kind === "global"}
          onClick={() => {
            onDispatch({ type: "select_context", context: { kind: "global" } });
          }}
        >
          <span className="rail-glyph" aria-hidden="true">
            <svg viewBox="0 0 14 14" focusable="false">
              <path d="M1.5 3.6 L5.7 7 L1.5 10.4 M7.6 10.4 H12.5" />
            </svg>
          </span>
        </RailTile>
        <ul className="rail-list">
          {snapshot.workspaces.map((workspace) => {
            // An Agent is selected *inside* a Workspace, and the rail has no
            // row of its own for it, so its Workspace's tile is what carries
            // the selection — otherwise selecting an Agent empties the rail.
            const selected =
              workspace.id === selectedWorkspaceId ||
              workspace.id === agentWorkspaceId;
            return (
              <li key={workspace.id}>
                <RailTile
                  label={workspaceDescription(workspace)}
                  selected={selected}
                  onClick={() => {
                    onDispatch({
                      type: "select_context",
                      context: { kind: "workspace", workspaceId: workspace.id },
                    });
                  }}
                >
                  <span className="rail-glyph" aria-hidden="true">
                    <svg viewBox="0 0 14 14" focusable="false">
                      <path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.4 1.6h4.6a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
                    </svg>
                  </span>
                  {workspace.agents.length > 0 && (
                    <span className="rail-badge">
                      <StatusMark status={workspace.aggregateStatus} compact />
                    </span>
                  )}
                </RailTile>
              </li>
            );
          })}
        </ul>
      </div>
      {/* Add sits at the foot of the rail, where a source list keeps its +. */}
      <div className="rail-footer">
        <RailTile label="Open workspace picker" onClick={onAddWorkspace}>
          <span className="rail-glyph" aria-hidden="true">
            <svg viewBox="0 0 14 14" focusable="false">
              <path d="M7 3.25v7.5M3.25 7h7.5" />
            </svg>
          </span>
        </RailTile>
      </div>
    </aside>
  );
}
