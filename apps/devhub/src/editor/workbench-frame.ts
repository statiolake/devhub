/**
 * The entry point of one Editor frame.
 *
 * Everything the Workbench assumes about owning a document is true here, and
 * true only here. What leaves the frame is one message saying whether it came
 * up; the App Shell decides what to show for either answer.
 */
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
    () => report({ kind: "workbench-ready" }),
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
