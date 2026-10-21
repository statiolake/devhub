/**
 * An Agent terminal pane's entry point — one view per Agent terminal
 * (`Cmd+Q V`, `devhub --tell terminal open`).
 *
 * Its own entry, because it is its own page in its own view, installing what
 * every DevHub page installs: the palette it was served wearing, the
 * monospace family, the selection guard, the side buttons' history, and the
 * root failure handler. Which terminal it shows is the page's fragment
 * (`pane.html#<id>`), which main writes when it makes the view; see
 * `PaneApp`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installMonoFont, installPalette } from "../appearance";
import { installRootFailureHandler } from "../failure";
import { PageBoundary } from "../PageBoundary";
import { installSelectionGuard } from "../selection";
import { installHistoryButtons } from "../historyButtons";
import { devhub } from "./client";
import { WINDOW_TITLES } from "../../ipc/windowTitles";
import { PaneApp } from "./PaneApp";
import "../styles/tokens.css";
import "../styles/shell.css";
import "../styles/macos.css";
import "./panePage.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("the terminal pane page has no #root element");
}

installRootFailureHandler();
installSelectionGuard(document);
installHistoryButtons(document, (direction) => {
  void devhub().dispatch({ type: "navigate_history", direction });
});
installPalette(document);
installMonoFont(document);

document.title = WINDOW_TITLES.pane;

createRoot(container).render(
  <StrictMode>
    <PageBoundary>
      <PaneApp terminalId={decodeURIComponent(location.hash.slice(1))} />
    </PageBoundary>
  </StrictMode>,
);
