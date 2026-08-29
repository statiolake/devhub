/**
 * Raising the Workbench in one Editor frame.
 *
 * Reached only through `workbench-frame`, which loads the display language
 * first. Importing this module imports the Workbench, and the Workbench reads
 * its strings as it is imported — so anything that must be in place before
 * then has to happen before this file is reached.
 *
 * Everything the Workbench assumes about owning a document is true here, and
 * true only here. What leaves the frame is one message saying whether it came
 * up; the App Shell decides what to show for either answer.
 */
import {
  getService,
  IContextKeyService,
  IFileService,
  IKeybindingService,
} from "@codingame/monaco-vscode-api";
import * as monaco from "monaco-editor";
// Side effect, and it has to happen before the services start: the first
// worker is asked for while they come up.
import "./workers";
import { UserFacingFailure } from "../app/failure";
import type { WorkbenchFrameMessage } from "./frameProtocol";
import { raiseWorkbench } from "./workbench";

const report = (message: WorkbenchFrameMessage) => {
  window.parent.postMessage(message, window.location.origin);
};

const container = document.getElementById("workbench");
const parameters = new URLSearchParams(window.location.search);
const authority = parameters.get("authority");
const connectionToken = parameters.get("connectionToken");
const folder = parameters.get("folder") ?? undefined;

if (!container || !authority || !connectionToken) {
  // The frame is addressed by the shell, so this is a broken build rather
  // than anything a user did.
  report({
    kind: "workbench-failed",
    summary: "The editor could not start.",
    detail: "The editor frame was opened without a server to connect to.",
  });
} else {
  raiseWorkbench(container, {
    remote: { authority, connectionToken, commit: "" },
    folder,
  }).then(
    () => {
      // A source build gets one way to ask the Workbench what it can see.
      // "The tree is empty" and "the filesystem is unreachable" look identical
      // from outside, and only one of them is a bug in the shell.
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__devhubWorkbench = {
          // A shortcut that does nothing and a shortcut that was never
          // delivered look identical from outside the frame, and only one of
          // them is the shell's doing. These hand the two services that decide
          // it, so the question can be asked of the Workbench instead of
          // inferred from a beep.
          keybindings: () => getService(IKeybindingService),
          contextKeys: () => getService(IContextKeyService),
          async read(path: string) {
            const files = await getService(IFileService);
            const uri = monaco.Uri.from({
              scheme: "vscode-remote",
              authority,
              path,
            });
            const stat = await files.resolve(uri);
            return (stat.children ?? []).map((child) => child.name);
          },
        };
      }
      report({ kind: "workbench-ready" });
    },
    (error: unknown) => {
      report({
        kind: "workbench-failed",
        summary:
          error instanceof UserFacingFailure
            ? error.message
            : "The editor could not start.",
        detail:
          error instanceof UserFacingFailure
            ? error.detail
            : error instanceof Error
              ? error.message
              : undefined,
      });
    },
  );
}
