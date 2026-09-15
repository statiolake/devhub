/**
 * The `sidebar` page's entry point.
 *
 * Its own entry, because it is its own page in its own view. What DevHub's
 * pages share is stated by what each of them installs here rather than by all
 * of them being the same file behind a `?window=` role: the palette they are
 * served wearing, the selection guard, and the root failure handler that hands
 * whatever nothing caught to main.
 *
 * `SidebarApp` carries the whole IPC contract in its own header.
 *
 * There is no `installFocusHome` here, and there is nowhere left to put one.
 * It existed because the Sidebar's DOM and an Agent's DOM were in one
 * document, so a click on a row left the keyboard on that row while the Agent
 * was what was on screen. They are two views now, and where the keyboard goes
 * is the window's one answer (`main/shell/windowLayout.ts`, `keyboardChild`).
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installPalette } from "../appearance";
import { installRootFailureHandler } from "../failure";
import { PageBoundary } from "../PageBoundary";
import { installSelectionGuard } from "../selection";
import { WINDOW_TITLES } from "../../ipc/windowTitles";
import { SidebarApp } from "./SidebarApp";
import "../styles/tokens.css";
import "../styles/shell.css";
import "../styles/macos.css";
import "../styles/reorder.css";
import "./sidebarPage.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("the sidebar page has no #root element");
}

// Installed outside React so no remount can drop any of them. The palette is
// one of these: the page was served wearing it, and this is only what keeps it
// current when a workbench changes theme.
installRootFailureHandler();
installSelectionGuard(document);
installPalette(document);

document.title = WINDOW_TITLES.sidebar;

// One boundary per page, and this is where this page begins. It is the only
// catch React can reach — a component that throws while rendering takes the
// tree with it, and the window handler that would report it has nothing left
// to report into. See `PageBoundary.tsx`.
createRoot(container).render(
  <StrictMode>
    <PageBoundary>
      <SidebarApp />
    </PageBoundary>
  </StrictMode>,
);
