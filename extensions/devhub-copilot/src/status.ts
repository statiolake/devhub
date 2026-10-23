import type { CopilotClientStatus } from "./copilotClient";

export interface CopilotState {
  signingIn: boolean;
  ready: boolean;
  server?: CopilotClientStatus;
}

export type CopilotStatusKind =
  | "signingIn"
  | "busy"
  | "signedOut"
  | "error"
  | "ready";

export interface CopilotStatus {
  kind: CopilotStatusKind;
  /** The status bar's second icon, beside `$(copilot)`. */
  icon: string;
  summary: string;
}

/**
 * What the status bar says, from what the server last reported.
 *
 * The server's `didChangeStatus` has no "signed out" kind of its own: it
 * reports an Error or Warning whose message talks about signing in, so that
 * is told apart by the words.
 */
export function statusOf(state: CopilotState): CopilotStatus {
  if (state.signingIn) {
    return { kind: "signingIn", icon: "$(sync~spin)", summary: "Signing in" };
  }
  const server = state.server;
  if (server?.busy === true) {
    return { kind: "busy", icon: "$(sync~spin)", summary: "Busy" };
  }
  if (server?.kind === "Error" || server?.kind === "Warning") {
    const message = server.message.length > 0 ? `: ${server.message}` : "";
    if (
      /auth|sign(?:ed)?.?in|unauthoriz|credential|account/iu.test(
        server.message,
      )
    ) {
      return {
        kind: "signedOut",
        icon: "$(warning)",
        summary: `Not signed in${message}`,
      };
    }
    return { kind: "error", icon: "$(warning)", summary: `Error${message}` };
  }
  if (!state.ready) {
    return {
      kind: "error",
      icon: "$(warning)",
      summary: "The language server is not running",
    };
  }
  return { kind: "ready", icon: "$(check)", summary: "Ready" };
}
