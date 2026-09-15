/**
 * The Sidebar, in a view of its own.
 *
 * # What this page is
 *
 * The leading column of the window and everything in it: the list of
 * Workspaces and their Agents, the Scratch row, the header strip, the row
 * menu, the drag-reorder, the rail, and the handle the column is resized by.
 * Nothing else. It is not "the App Shell minus the surface" — it is the
 * Sidebar, and the window's owner puts it where it goes.
 *
 * # Its contract with main
 *
 * - **reads**: the snapshot (`workspaces` and their agents, `selection`,
 *   `sidebar.{collapsed,width}`, `readiness`), the appearance
 *   (`sidebarDensity`, `titleBar`), the repository status, the agent profiles,
 *   and the palette.
 * - **is pushed**: `snapshotChanged`, `appearanceChanged`,
 *   `repositoryStatusChanged`, `agentProfilesChanged`, `themeChanged`, and
 *   `menuCommand` — of which it answers `open_workspace_picker`,
 *   `focus_sidebar` and `retry_app`. The other two commands that used to
 *   arrive here belong to other pages now and are delivered to them.
 * - **asks**: `dispatch`, `openModal`, `closeWorkspace`, `openExternalUrl`,
 *   `previewLayout` (the width under the pointer, while a drag lasts),
 *   `focusSurface` (Escape, which is a request to main because what should get
 *   the keys is usually a native view this document cannot focus).
 * - **draws no failure it raised.** What goes wrong here is handed to main and
 *   drawn on the `toasts` view, over whatever is on screen. See
 *   `main/shell/publishAudience.ts`.
 *
 *
 * # `window.innerWidth` is not the window
 *
 * This page is a `WebContentsView`, and what it measures is its own box — one
 * frame stale after main calls `setBounds` on it. Nothing here reads it, and
 * nothing here should: where anything is, is `main/shell/windowLayout.ts`, and
 * a page that needs a number from it is told the number.
 * # Why the title bar is not here
 *
 * With `title_bar = shown` the bar spans the whole window above both columns,
 * so it is not this column's to draw; with `hidden` there is no bar at all and
 * this column carries the traffic lights itself, which is a rectangle the
 * *owner* reserves (`windowLayout.sidebarColumnWidth`) rather than anything
 * this page does. Either way the bar is the window's own page's, which is also
 * where the window's drag region can be declared without asking whether a
 * region declared inside a child view composes into one handle.
 */

import { SidebarProvider } from "./SidebarContext";
import { devhub } from "./client";
import { useSidebar } from "./SidebarContext";
import { Sidebar } from "../components/sidebar/Sidebar";
import type { AppIntent } from "../../ipc/appShell";

export function SidebarApp() {
  return (
    <SidebarProvider>
      <Column />
    </SidebarProvider>
  );
}

/**
 * The column itself, once there is a projection to draw.
 *
 * Before there is one this page draws nothing at all — not a spinner, not an
 * empty list. A Sidebar with a placeholder in it is a Sidebar that appears to
 * have content and then replaces it; the window's own page is what is behind
 * this view, and it is already the window's colour, so drawing nothing is
 * drawing the chrome.
 */
function Column() {
  const { state, appearance } = useSidebar();
  if (state.status !== "ready") return null;
  const onDispatch = (intent: AppIntent) => {
    void devhub().dispatch(intent);
  };
  return (
    // `app-shell` because that is the selector `tokens.css` hangs the two
    // chromes' numbers off; `sidebar-page` because this column is the whole of
    // this document rather than one pane in a row of them.
    //
    // The two attributes are the same two the window's own page carries, and
    // they say the same things: which chrome is up decides the band this
    // column keeps clear at its top for the traffic lights, and the density
    // decides how wide the rail is. Both are also the owner's numbers — see
    // `windowLayout.ts` — which is what keeps the column the owner sized and
    // the column this page draws the same column.
    <div
      className="app-shell sidebar-page"
      data-readiness={state.snapshot.readiness}
      data-sidebar-density={appearance?.sidebarDensity ?? "compact"}
      data-title-bar={appearance?.titleBar ?? "shown"}
    >
      <Sidebar snapshot={state.snapshot} onDispatch={onDispatch} />
    </div>
  );
}
