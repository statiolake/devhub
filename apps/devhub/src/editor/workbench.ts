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
import getAccessibilityServiceOverride from "@codingame/monaco-vscode-accessibility-service-override";
import getAiServiceOverride from "@codingame/monaco-vscode-ai-service-override";
import getAssignmentServiceOverride from "@codingame/monaco-vscode-assignment-service-override";
import getAuthenticationServiceOverride from "@codingame/monaco-vscode-authentication-service-override";
import getChatServiceOverride from "@codingame/monaco-vscode-chat-service-override";
import getCommentsServiceOverride from "@codingame/monaco-vscode-comments-service-override";
import getDebugServiceOverride from "@codingame/monaco-vscode-debug-service-override";
import getEditSessionsServiceOverride from "@codingame/monaco-vscode-edit-sessions-service-override";
import getEmmetServiceOverride from "@codingame/monaco-vscode-emmet-service-override";
import getExtensionGalleryServiceOverride from "@codingame/monaco-vscode-extension-gallery-service-override";
import getImageResizeServiceOverride from "@codingame/monaco-vscode-image-resize-service-override";
import getInteractiveServiceOverride from "@codingame/monaco-vscode-interactive-service-override";
import getIssueServiceOverride from "@codingame/monaco-vscode-issue-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getLanguageDetectionWorkerServiceOverride from "@codingame/monaco-vscode-language-detection-worker-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getMcpServiceOverride from "@codingame/monaco-vscode-mcp-service-override";
import getMultiDiffEditorServiceOverride from "@codingame/monaco-vscode-multi-diff-editor-service-override";
import getNotebookServiceOverride from "@codingame/monaco-vscode-notebook-service-override";
import getNotificationsServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getOutlineServiceOverride from "@codingame/monaco-vscode-outline-service-override";
import getOutputServiceOverride from "@codingame/monaco-vscode-output-service-override";
import getPerformanceServiceOverride from "@codingame/monaco-vscode-performance-service-override";
import getPreferencesServiceOverride from "@codingame/monaco-vscode-preferences-service-override";
import getProcessExplorerServiceOverride from "@codingame/monaco-vscode-process-explorer-service-override";
import getRelauncherServiceOverride from "@codingame/monaco-vscode-relauncher-service-override";
import getScmServiceOverride from "@codingame/monaco-vscode-scm-service-override";
import getSecretStorageServiceOverride from "@codingame/monaco-vscode-secret-storage-service-override";
import getShareServiceOverride from "@codingame/monaco-vscode-share-service-override";
import getSnippetsServiceOverride from "@codingame/monaco-vscode-snippets-service-override";
import getSpeechServiceOverride from "@codingame/monaco-vscode-speech-service-override";
import getSurveyServiceOverride from "@codingame/monaco-vscode-survey-service-override";
import getTaskServiceOverride from "@codingame/monaco-vscode-task-service-override";
import getTelemetryServiceOverride from "@codingame/monaco-vscode-telemetry-service-override";
import getTestingServiceOverride from "@codingame/monaco-vscode-testing-service-override";
import getTimelineServiceOverride from "@codingame/monaco-vscode-timeline-service-override";
import getTreesitterServiceOverride from "@codingame/monaco-vscode-treesitter-service-override";
import getUpdateServiceOverride from "@codingame/monaco-vscode-update-service-override";
import getUserDataProfileServiceOverride from "@codingame/monaco-vscode-user-data-profile-service-override";
import getUserDataSyncServiceOverride from "@codingame/monaco-vscode-user-data-sync-service-override";
import getViewBannerServiceOverride from "@codingame/monaco-vscode-view-banner-service-override";
import getViewStatusBarServiceOverride from "@codingame/monaco-vscode-view-status-bar-service-override";
import getViewTitleBarServiceOverride from "@codingame/monaco-vscode-view-title-bar-service-override";
import getWalkthroughServiceOverride from "@codingame/monaco-vscode-walkthrough-service-override";
import getWelcomeServiceOverride from "@codingame/monaco-vscode-welcome-service-override";
import getWorkingCopyServiceOverride from "@codingame/monaco-vscode-working-copy-service-override";
import getBulkEditServiceOverride from "@codingame/monaco-vscode-bulk-edit-service-override";
import getMonarchServiceOverride from "@codingame/monaco-vscode-monarch-service-override";
import getPolicyServiceOverride from "@codingame/monaco-vscode-policy-service-override";
import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getEnvironmentServiceOverride from "@codingame/monaco-vscode-environment-service-override";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getFilesServiceOverride from "@codingame/monaco-vscode-files-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getLifecycleServiceOverride from "@codingame/monaco-vscode-lifecycle-service-override";
import getLocalizationServiceOverride from "@codingame/monaco-vscode-localization-service-override";
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
import { setDisplayLanguage } from "./frameProtocol";
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

/**
 * Apply a display language to the frame the user is looking at.
 *
 * A language pack is chosen while the Workbench comes up, so changing it is a
 * reload — which is what VS Code does for the same reason.
 */
function reloadWithLocale(locale: string | null): void {
  const url = new URL(window.location.href);
  if (locale == null) url.searchParams.delete("locale");
  else url.searchParams.set("locale", locale);
  window.location.replace(url.toString());
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
      // The display language decides which language pack loads, so it is
      // settled before the Workbench boots — chosen here, remembered by the
      // shell, and carried in the next frame's address.
      ...getLocalizationServiceOverride({
        // What the display-language picker offers, which is exactly the set
        // of language packs bundled with the app. Offering one that is not
        // bundled would leave the reader with a Workbench that changed
        // nothing and said nothing about why.
        availableLanguages: [
          { locale: "en", languageName: "English" },
          { locale: "cs", languageName: "Čeština" },
          { locale: "de", languageName: "Deutsch" },
          { locale: "es", languageName: "Español" },
          { locale: "fr", languageName: "Français" },
          { locale: "it", languageName: "Italiano" },
          { locale: "ja", languageName: "日本語" },
          { locale: "ko", languageName: "한국어" },
          { locale: "pl", languageName: "Polski" },
          { locale: "pt-br", languageName: "Português (Brasil)" },
          { locale: "ru", languageName: "Русский" },
          { locale: "tr", languageName: "Türkçe" },
          { locale: "zh-hans", languageName: "简体中文" },
          { locale: "zh-hant", languageName: "繁體中文" },
          { locale: "qps-ploc", languageName: "Pseudo Language" },
        ],
        async setLocale(id: string) {
          setDisplayLanguage(id);
          reloadWithLocale(id);
        },
        async clearLocale() {
          setDisplayLanguage(null);
          reloadWithLocale(null);
        },
      }),
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
      // Off by default, and with it off the scan returns an empty list. The
      // server this connects to is bundled with the app, and its built-in
      // extensions — the grammars, the language configurations, the file
      // icon theme — are the reason it is bundled at all.
      ...getRemoteAgentServiceOverride({ scanRemoteExtensions: true }),
      ...getExtensionServiceOverride(),
      ...getExplorerServiceOverride(),
      ...getSearchServiceOverride(),
      ...getModelServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getThemeServiceOverride(),
      ...getTerminalServiceOverride(),
      // Two defaults written for a Workbench embedded beside standalone
      // Monaco editors. There are none here: every editor in this frame is a
      // Workbench editor, so the picker is always the Workbench's own, and
      // the command palette keeps the buttons that lead to a keybinding.
      ...getQuickAccessServiceOverride({
        shouldUseGlobalPicker: () => true,
        isKeybindingConfigurationVisible: () => true,
      }),
      ...getWorkspaceTrustOverride(),
      ...getBulkEditServiceOverride(),
      ...getMonarchServiceOverride(),
      // Policies are how an administrator locks settings down. DevHub sets
      // none, and an empty map is the honest way to say so — the service is
      // present, and it reports that nothing is enforced.
      ...getPolicyServiceOverride(new Map()),
      ...getAccessibilityServiceOverride(),
      ...getAiServiceOverride(),
      ...getAssignmentServiceOverride(),
      ...getAuthenticationServiceOverride(),
      ...getChatServiceOverride(),
      ...getCommentsServiceOverride(),
      ...getDebugServiceOverride(),
      ...getEditSessionsServiceOverride(),
      ...getEmmetServiceOverride(),
      ...getExtensionGalleryServiceOverride(),
      ...getImageResizeServiceOverride(),
      ...getInteractiveServiceOverride(),
      ...getIssueServiceOverride(),
      // Without this, a shortcut only fires while focus sits inside the
      // Workbench container: the service checks `container.contains(target)`
      // and returns before it resolves anything. That guard is for a
      // Workbench embedded in a larger page. A frame holds nothing else, so
      // the document is the Workbench, and focus resting on its body — an
      // empty editor group, a click that landed on no widget — is still
      // focus inside the Editor.
      ...getKeybindingsServiceOverride({
        shouldUseGlobalKeybindings: () => true,
      }),
      ...getLanguageDetectionWorkerServiceOverride(),
      ...getMarkersServiceOverride(),
      ...getMcpServiceOverride(),
      ...getMultiDiffEditorServiceOverride(),
      ...getNotebookServiceOverride(),
      ...getNotificationsServiceOverride(),
      ...getOutlineServiceOverride(),
      ...getOutputServiceOverride(),
      ...getPerformanceServiceOverride(),
      ...getPreferencesServiceOverride(),
      ...getProcessExplorerServiceOverride(),
      ...getRelauncherServiceOverride(),
      ...getScmServiceOverride(),
      ...getSecretStorageServiceOverride(),
      ...getShareServiceOverride(),
      ...getSnippetsServiceOverride(),
      ...getSpeechServiceOverride(),
      ...getSurveyServiceOverride(),
      ...getTaskServiceOverride(),
      ...getTelemetryServiceOverride(),
      ...getTestingServiceOverride(),
      ...getTimelineServiceOverride(),
      ...getTreesitterServiceOverride(),
      ...getUpdateServiceOverride(),
      ...getUserDataProfileServiceOverride(),
      ...getUserDataSyncServiceOverride(),
      ...getViewBannerServiceOverride(),
      ...getViewStatusBarServiceOverride(),
      ...getViewTitleBarServiceOverride(),
      ...getWalkthroughServiceOverride(),
      ...getWelcomeServiceOverride(),
      ...getWorkingCopyServiceOverride(),
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
