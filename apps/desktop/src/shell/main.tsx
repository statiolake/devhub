/**
 * The App Shell page's entry point.
 *
 * Two surfaces still share it: the window's own page and the Settings window
 * (`?window=settings`). The `toasts`, `picker`, `sidebar` and `agents`
 * children used to be here too, behind roles of their own or as DOM in this
 * one; each is its own entry now, which is what a page in a view of its own
 * means. What is left is the last of the role switching, and it goes when
 * Settings gets an entry too.
 *
 * `installFocusHome` used to be here, for the `shell` role only. It is gone
 * with the file: it existed because the Sidebar's DOM and an Agent's DOM were
 * in one document, so a click on a row left the keyboard on that row while the
 * Agent was what was on screen. Two views cannot have that problem, and where
 * the keyboard goes is the window's one answer (`keyboardChild`).
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./AppShell";
import { installPalette } from "./appearance";
import { installRootFailureHandler } from "./failure";
import { PageBoundary } from "./PageBoundary";
import { installSelectionGuard } from "./selection";
import { SettingsApp } from "../settings/SettingsApp";
import { WINDOW_TITLES, windowKindOf } from "../ipc/windowTitles";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/macos.css";
import "./styles/reorder.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("the App Shell page has no #root element");
}

// Installed outside React so no remount can drop any of them, and so every
// window gets them from the one entry point they share. The palette is one of
// these: the page was served wearing it, and this is only what keeps it
// current when a workbench changes theme.
installRootFailureHandler();
installSelectionGuard(document);
installPalette(document);

const which = windowKindOf(window.location.search);

// Electron gives a window its page's title, so the title main chose when it
// created the window lasts only until the page loads. Both surfaces are served
// from one `index.html`, so the page has to say which of them it is — otherwise
// the Settings window takes the shell's `<title>` and calls itself "DevHub".
document.title = WINDOW_TITLES[which];

const app = which === "settings" ? <SettingsApp /> : <AppShell />;

// One boundary per page, and this is where this one begins. It is the
// only catch React can reach — a component that throws while rendering takes
// the tree with it, and the window handler that would report it has nothing
// left to report into. See `PageBoundary.tsx`.
createRoot(container).render(
  <StrictMode>
    <PageBoundary>{app}</PageBoundary>
  </StrictMode>,
);
