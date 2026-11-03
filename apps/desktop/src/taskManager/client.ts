import type { TaskManagerPageBridge } from "../ipc/contract";
import type { TaskManagerApi } from "../ipc/taskManager";
import { pageBridge } from "../shell/bridge";

declare global {
  interface Window {
    readonly devhubTaskManager?: TaskManagerApi;
  }
}

/** The failure contract every DevHub page has; see `TaskManagerPageBridge`. */
export function devhub(): TaskManagerPageBridge {
  return pageBridge<TaskManagerPageBridge>("Task Manager");
}

/** Everything the window is for, as the preload built it. */
export function createTaskManagerClient(): TaskManagerApi {
  const api = window.devhubTaskManager;
  if (!api) {
    throw new Error(
      "the Task Manager page was loaded without its preload: window.devhubTaskManager is missing",
    );
  }
  return api;
}
