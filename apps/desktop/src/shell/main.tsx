/**
 * The App Shell page's entry point.
 *
 * One page serves both windows: the shell, and the Settings window that opens
 * with `?window=settings`. They share the tokens, the selection guard and the
 * root failure handler, which is the only reason they share an entry point.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./AppShell";
import { installRootFailureHandler } from "./failure";
import { installSelectionGuard } from "./selection";
import { installSurfaceRenderers } from "./components/shell/surfaceRenderers";
import { SettingsApp } from "../settings/SettingsApp";
import "./styles/tokens.css";
import "./styles/shell.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("the App Shell page has no #root element");
}

// Installed outside React so no remount can drop either of them, and so both
// windows get them from the one entry point they share.
installRootFailureHandler();
installSelectionGuard(document);
installSurfaceRenderers();

const isSettings =
  new URLSearchParams(window.location.search).get("window") === "settings";

createRoot(container).render(
  <StrictMode>{isSettings ? <SettingsApp /> : <AppShell />}</StrictMode>,
);
