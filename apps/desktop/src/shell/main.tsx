/**
 * The window's own page, and its entry point.
 *
 * `index.html` is this page and nothing else. It used to be three surfaces
 * behind a `?window=` role — the App Shell, the modal overlay and the Settings
 * window — which meant each of them loaded the other two's code and took the
 * other two's subscriptions. Every one of them is its own entry now, Settings
 * last, and there is no role left to switch on: which page this is, is which
 * file main loaded.
 *
 * What is drawn here is what is left when the Sidebar, the Agents, the notices
 * and the questions are all views of their own: the title bar, the states in
 * which there is no child view to show, and the seam of a split.
 *
 * `installFocusHome` used to be here. It is gone with the file: it existed
 * because the Sidebar's DOM and an Agent's DOM were in one document, so a
 * click on a row left the keyboard on that row while the Agent was what was on
 * screen. Two views cannot have that problem, and where the keyboard goes is
 * the window's one answer (`main/shell/windowLayout.ts`, `keyboardChild`).
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./AppShell";
import { installPalette } from "./appearance";
import { installRootFailureHandler } from "./failure";
import { PageBoundary } from "./PageBoundary";
import { installSelectionGuard } from "./selection";
import { WINDOW_TITLES } from "../ipc/windowTitles";
import "./styles/tokens.css";
import "./styles/windowBackground.css";
import "./styles/shell.css";
import "./styles/macos.css";
import "./styles/reorder.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("the App Shell page has no #root element");
}

// Installed outside React so no remount can drop any of them. The palette is
// one of these: the page was served wearing it, and this is only what keeps it
// current when a workbench changes theme.
installRootFailureHandler();
installSelectionGuard(document);
installPalette(document);

// Set, and then ignored: this window's name depends on what is on screen,
// which only main knows, so main refuses the page's title and names the window
// itself. See `ipc/windowTitles.ts`.
document.title = WINDOW_TITLES.shell;

// One boundary per page, and this is where this one begins. It is the
// only catch React can reach — a component that throws while rendering takes
// the tree with it, and the window handler that would report it has nothing
// left to report into. See `PageBoundary.tsx`.
createRoot(container).render(
  <StrictMode>
    <PageBoundary>
      <AppShell />
    </PageBoundary>
  </StrictMode>,
);
