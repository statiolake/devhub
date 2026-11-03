/**
 * The Task Manager window's page, and its entry point.
 *
 * Its own entry, like Settings (`settings/main.tsx`): the palette it was
 * served wearing, the selection guard, the root failure handler, one page
 * boundary. See `TaskManagerApp` for what it draws.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TaskManagerApp } from "./TaskManagerApp";
import { createTaskManagerClient } from "./client";
import { installPalette } from "../shell/appearance";
import { installRootFailureHandler } from "../shell/failure";
import { PageBoundary } from "../shell/PageBoundary";
import { installSelectionGuard } from "../shell/selection";
import { WINDOW_TITLES } from "../ipc/windowTitles";

const container = document.getElementById("root");
if (!container) {
  throw new Error("the Task Manager page has no #root element");
}

installRootFailureHandler();
installSelectionGuard(document);
installPalette(document);
document.title = WINDOW_TITLES.taskManager;

createRoot(container).render(
  <StrictMode>
    <PageBoundary>
      <TaskManagerApp client={createTaskManagerClient()} />
    </PageBoundary>
  </StrictMode>,
);
