/**
 * The App Shell page's entry point.
 *
 * One page serves all three surfaces: the App Shell itself, the Settings
 * window (`?window=settings`), and the modal overlay laid over the shell
 * window (`?window=overlay`). They share the tokens, the selection guard and
 * the root failure handler, which is the only reason they share an entry
 * point.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./AppShell";
import { installPalette } from "./appearance";
import { installRootFailureHandler } from "./failure";
import { installSelectionGuard } from "./selection";
import { installSurfaceRenderers } from "./components/shell/surfaceRenderers";
import { SettingsApp } from "../settings/SettingsApp";
import { OverlayApp } from "./overlay/OverlayApp";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/macos.css";
import "./overlay/overlay.css";

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
installSurfaceRenderers();
installPalette(document);

const which = new URLSearchParams(window.location.search).get("window");
if (which === "overlay") {
  // The layer is a sheet of glass over the whole window: whatever it does not
  // draw has to show the live workbench through it, not a page background.
  document.documentElement.dataset.window = "overlay";
}

const app =
  which === "settings" ? (
    <SettingsApp />
  ) : which === "overlay" ? (
    <OverlayApp />
  ) : (
    <AppShell />
  );

createRoot(container).render(<StrictMode>{app}</StrictMode>);
