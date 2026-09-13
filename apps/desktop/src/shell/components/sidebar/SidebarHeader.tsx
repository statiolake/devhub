/**
 * The strip at the top of the Sidebar: the window's handle, when the window
 * needs one.
 *
 * With `appearance.title_bar = "hidden"` there is no title bar. The workbench
 * spans the whole height of the content area, so the window has no band of its
 * own to be dragged by — and the Sidebar, which is the one piece of DevHub
 * chrome left, becomes the handle. The strip is then exactly the height of the
 * traffic-light band and inset past the lights, which is what Finder and Slack
 * do with the same corner: the lights own the leading end and the strip
 * carries the drag region across the rest of it.
 *
 * With `"system"` the window has a real bar and this collapses to nothing —
 * `--titlebar-reserve` is zero. The element is still rendered rather than
 * rendered conditionally: there is one arrangement of the Sidebar, and the two
 * chromes differ only in the value of a token. It holds no control in either
 * — the Sidebar is always the pane, so there is no state to switch between.
 */

export function SidebarHeader() {
  return <div className="sidebar-header" />;
}
