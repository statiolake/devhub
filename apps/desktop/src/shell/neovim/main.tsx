/**
 * The Neovim page's entry point — one view per Neovim DevHub draws over a
 * terminal pane (`general.editor = "neovim"`).
 *
 * Its own entry, because it is its own page in its own view, installing what
 * every DevHub page installs: the palette it was served wearing, the
 * monospace family, the selection guard, the side buttons' history, and the
 * root failure handler. Which Neovim it draws is the page's fragment
 * (`neovim.html#tnv:<n>`), which main writes when it makes the view; see
 * `NeovimApp`.
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
import { NeovimApp } from "./NeovimApp";
import "../styles/tokens.css";
import "../styles/shell.css";
import "../styles/macos.css";
import "./neovim.css";
import "./layers.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("the Neovim page has no #root element");
}

installRootFailureHandler();
installSelectionGuard(document);
installHistoryButtons(document, (direction) => {
  void devhub().dispatch({ type: "navigate_history", direction });
});
installPalette(document);
installMonoFont(document);

document.title = WINDOW_TITLES.neovim;

createRoot(container).render(
  <StrictMode>
    <PageBoundary>
      <NeovimApp workspaceId={decodeURIComponent(location.hash.slice(1))} />
    </PageBoundary>
  </StrictMode>,
);
