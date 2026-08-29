/**
 * The VS Code Workbench, raised in the document of one Editor frame.
 *
 * It used to be a page fetched from the Editor's server into a native child
 * WebView, which made its origin the server's — and a server's port is not
 * ours to keep, so everything the browser stored against that origin was lost
 * whenever it moved. Supplied as a bundle instead, the Workbench inherits the
 * app's own origin, which never moves, and the server is left with the work
 * only it can do: the extension host, the filesystem, and terminals, reached
 * over one socket.
 *
 * One document holds one Workbench and one workspace. VS Code's services are
 * global to a document and cannot be raised twice or torn down, and a
 * workspace is settled while it comes up. That is why each Editor gets a frame
 * of its own rather than a slot in this one — and why a modal it draws over
 * "the window" covers its own frame and nothing else.
 */
import { initialize as initializeVscodeServices } from "@codingame/monaco-vscode-api";
import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getEnvironmentServiceOverride from "@codingame/monaco-vscode-environment-service-override";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getFilesServiceOverride from "@codingame/monaco-vscode-files-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getLifecycleServiceOverride from "@codingame/monaco-vscode-lifecycle-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import getRemoteAgentServiceOverride from "@codingame/monaco-vscode-remote-agent-service-override";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import getTerminalServiceOverride from "@codingame/monaco-vscode-terminal-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getWorkbenchServiceOverride from "@codingame/monaco-vscode-workbench-service-override";
import getWorkspaceTrustOverride from "@codingame/monaco-vscode-workspace-trust-service-override";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import * as monaco from "monaco-editor";
import type { EditorRemote } from "../app/client";
import { UserFacingFailure } from "../app/failure";
import { trace } from "./trace";

/** The folder a surface opens, addressed on the server rather than locally. */
export interface WorkbenchTarget {
  readonly remote: EditorRemote;
  readonly folder?: string;
}

/**
 * How long the Workbench is given to come up.
 *
 * A start that never finishes is indistinguishable from one still going, and
 * the shell would show a spinner nothing will ever replace. The server is
 * already running by the time this begins, so ten seconds is the difference
 * between slow and stuck, not between working and not.
 */
const START_BUDGET_MS = 10_000;

function withBudget(work: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new UserFacingFailure(
          "The editor did not finish starting.",
          `It was given ${Math.round(START_BUDGET_MS / 1000)} seconds and did not report a result.`,
        ),
      );
    }, START_BUDGET_MS);
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

/** Raise the Workbench into this document. Once, and only once. */
export function raiseWorkbench(
  container: HTMLElement,
  target: WorkbenchTarget,
): Promise<void> {
  return withBudget(raise(container, target));
}

async function raise(
  container: HTMLElement,
  { remote, folder }: WorkbenchTarget,
): Promise<void> {
  const { authority, connectionToken } = remote;
  trace("workbench: initialising services");
  await initializeVscodeServices(
    {
      ...getWorkbenchServiceOverride(),
      ...getLogServiceOverride(),
      ...getEnvironmentServiceOverride(),
      ...getLifecycleServiceOverride(),
      ...getStorageServiceOverride(),
      ...getConfigurationServiceOverride(),
      // Without this the Workbench falls back to `window.confirm`, which
      // blocks the event loop of the whole App Shell — including the timers
      // that would otherwise notice something had stopped making progress.
      // A dialog the editor draws for itself blocks only the editor.
      ...getDialogsServiceOverride(),
      ...getFilesServiceOverride(),
      // The one that matters: everything below is drawn here, and everything
      // it operates on lives on the other side of this.
      ...getRemoteAgentServiceOverride(),
      ...getExtensionServiceOverride(),
      ...getExplorerServiceOverride(),
      ...getSearchServiceOverride(),
      ...getModelServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getThemeServiceOverride(),
      ...getTerminalServiceOverride(),
      ...getQuickAccessServiceOverride(),
      ...getWorkspaceTrustOverride(),
    },
    container,
    {
      remoteAuthority: authority,
      connectionToken,
      // Workspace trust stays on. Choosing to open a folder in the Sidebar is
      // not the same as agreeing to run what is inside it, which is the whole
      // question trust asks. What had to be fixed was the prompt blocking the
      // App Shell, not the prompt existing.
      enableWorkspaceTrust: true,
      workspaceProvider: {
        // Whether the workspace is trusted is the user's answer to give, not
        // an assertion this side gets to make on their behalf.
        trusted: false,
        // Opening a second window is the App Shell's decision, not the
        // Workbench's, and there is no second window to open into.
        async open() {
          return false;
        },
        workspace:
          folder == null
            ? undefined
            : {
                // Addressed on the server. A local path here would be read as
                // a path in the browser's own filesystem, which has none.
                folderUri: monaco.Uri.from({
                  scheme: "vscode-remote",
                  authority,
                  path: folder,
                }),
              },
      },
    },
  );
  trace("workbench: services initialised");
}
