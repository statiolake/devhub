/**
 * The strip at the top of the Sidebar: the window's handle, and the toggle.
 *
 * There is no title bar any more. The workbench spans the whole height of the
 * content area, so the window has no band of its own to be dragged by — and the
 * Sidebar, which is the one piece of DevHub chrome left, becomes the handle.
 *
 * This strip is exactly the height of the traffic-light band and inset past the
 * lights, which is what Finder and Slack do with the same corner: the lights
 * own the leading end, the strip carries the drag region across the rest of it,
 * and the toggle sits at the trailing edge where a Mac keeps a sidebar button.
 * Collapsed, the rail gets the same strip with the same button in it, so the
 * control does not move when the pane narrows.
 *
 * The button opts out of the drag region explicitly. It has to: a drag region
 * swallows the clicks that land on it, so a control inside one that does not
 * say `no-drag` is a control that cannot be pressed.
 */

import type { AppIntent } from "../../../ipc/appShell";

export interface SidebarHeaderProps {
  readonly expanded: boolean;
  readonly onDispatch: (intent: AppIntent) => void;
}

export function SidebarHeader({ expanded, onDispatch }: SidebarHeaderProps) {
  const label = expanded ? "Collapse Sidebar" : "Expand Sidebar";
  return (
    <div className="sidebar-header">
      <button
        className="sidebar-toggle"
        type="button"
        aria-label={label}
        aria-pressed={expanded}
        title={label}
        onClick={() => {
          onDispatch({ type: "set_sidebar_expanded", expanded: !expanded });
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2" />
          <path d="M6.25 3.25v9.5" />
          {/* The pane, filled while it is open: the icon says which of the two
              states you are in, not only that a Sidebar exists. */}
          {expanded && (
            <path
              className="sidebar-toggle-pane"
              d="M3.75 3.25h2.5v9.5h-2.5z"
            />
          )}
        </svg>
      </button>
    </div>
  );
}
