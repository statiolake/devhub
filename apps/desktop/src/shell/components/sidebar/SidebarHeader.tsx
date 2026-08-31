/**
 * The strip at the top of the Sidebar: the window's handle.
 *
 * There is no title bar any more. The workbench spans the whole height of the
 * content area, so the window has no band of its own to be dragged by — and the
 * Sidebar, which is the one piece of DevHub chrome left, becomes the handle.
 *
 * This strip is exactly the height of the traffic-light band and inset past the
 * lights, which is what Finder and Slack do with the same corner: the lights
 * own the leading end and the strip carries the drag region across the rest of
 * it. It holds no control — the Sidebar is always the pane, so there is no
 * state for a control to switch between.
 */

export function SidebarHeader() {
  return <div className="sidebar-header" />;
}
