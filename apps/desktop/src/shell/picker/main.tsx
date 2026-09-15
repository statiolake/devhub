/**
 * The `picker` page's entry point.
 *
 * Its own entry, because it is its own page in its own view. What DevHub's
 * pages share is stated by what each of them installs here rather than by all
 * of them being the same file behind a `?window=` role: the palette they are
 * served wearing, the selection guard, and the root failure handler that hands
 * whatever nothing caught to main.
 *
 * `PickerApp` carries the whole IPC contract in its own header.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installPalette } from "../appearance";
import { installRootFailureHandler } from "../failure";
import { PageBoundary } from "../PageBoundary";
import { installSelectionGuard } from "../selection";
import { WINDOW_TITLES } from "../../ipc/windowTitles";
import { PickerApp } from "./PickerApp";
import "../styles/tokens.css";
import "../styles/shell.css";
import "../styles/macos.css";
import "./picker.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("the picker page has no #root element");
}

// Installed outside React so no remount can drop any of them. The palette is
// one of these: the page was served wearing it, and this is only what keeps it
// current when a workbench changes theme.
installRootFailureHandler();
installSelectionGuard(document);
installPalette(document);

document.title = WINDOW_TITLES.picker;

createRoot(container).render(
  <StrictMode>
    <PageBoundary>
      <PickerApp />
    </PageBoundary>
  </StrictMode>,
);
