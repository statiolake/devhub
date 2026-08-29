/**
 * The VS Code Workbench, running in the App Shell's own document.
 *
 * It used to be a page fetched from the Editor's server into a native child
 * WebView, which is what made its origin the server's — and the server's port
 * is not ours to keep, so everything the browser stored against that origin
 * was lost whenever it moved. Supplied as a bundle instead, the Workbench
 * inherits this document's origin, which never moves, and the server is left
 * with the work only it can do: the extension host, the filesystem, and
 * terminals, reached over one socket.
 *
 * Initialisation happens once per process. VS Code's services are global and
 * cannot be torn down and raised again, so the Workbench is started on the
 * first Editor visit and afterwards only moved between containers.
 */
import { initialize as initializeVscodeServices } from "@codingame/monaco-vscode-api";
import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
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

/** The folder a surface opens, addressed on the server rather than locally. */
export interface WorkbenchTarget {
  readonly remote: EditorRemote;
  readonly folder?: string;
}

/**
 * How long the Workbench is given to come up.
 *
 * Generous, because it is starting an editor: extensions are scanned, a remote
 * connection is made, a theme is resolved. Bounded, because a start that never
 * finishes is indistinguishable from one still going, and the shell would show
 * a spinner nothing will ever replace. Whatever went wrong is worth saying
 * even when the only honest thing to say is that it did not finish.
 */
const START_BUDGET_MS = 60_000;

let started: Promise<void> | undefined;
let host: HTMLElement | undefined;
let openedFolder: string | undefined;

/** The element the Workbench was raised into, once it has been. */
export function workbenchHost(): HTMLElement | undefined {
  return host;
}

/**
 * Raise the Workbench, or return the promise of the raising already underway.
 *
 * The folder is settled here and not afterwards: VS Code opens a workspace as
 * part of coming up, and changing it later is a reload, not a call.
 */
export function startWorkbench(target: WorkbenchTarget): Promise<void> {
  if (started) {
    // A Workbench holds one workspace, and which one is settled while it comes
    // up. Asking a raised Workbench for a different folder is not a call it
    // has; saying so is better than quietly showing the folder it does have.
    if (openedFolder !== target.folder) {
      return Promise.reject(
        new UserFacingFailure(
          "The editor is already open on another Workspace.",
          "One Workbench holds one workspace, and which one is settled while it starts. Opening a second Workspace in the same editor is not supported yet.",
        ),
      );
    }
    return started;
  }
  openedFolder = target.folder;
  const container = document.createElement("div");
  container.className = "workbench-host";
  host = container;
  started = withBudget(raise(container, target)).catch((error: unknown) => {
    // A failed start is permanent for this process — the services are global
    // and half-raised. Forget the container so the shell can say so rather
    // than hand out a blank one.
    host = undefined;
    openedFolder = undefined;
    throw error;
  });
  return started;
}

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

async function raise(
  container: HTMLElement,
  { remote, folder }: WorkbenchTarget,
): Promise<void> {
  const { authority, connectionToken } = remote;
  await initializeVscodeServices(
    {
      ...getWorkbenchServiceOverride(),
      ...getLogServiceOverride(),
      ...getEnvironmentServiceOverride(),
      ...getLifecycleServiceOverride(),
      ...getStorageServiceOverride(),
      ...getConfigurationServiceOverride(),
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
      // DevHub decides what to open; the Workbench is never asked to trust a
      // folder the user did not choose in the Sidebar.
      enableWorkspaceTrust: false,
      workspaceProvider: {
        trusted: true,
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
}
