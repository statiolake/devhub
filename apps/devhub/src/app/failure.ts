/**
 * The one place an unknown failure becomes something the shell can show.
 *
 * Everything that can fail — a rejected command, a native push, a provider
 * that would not start — arrives here and leaves as an `AppError`, so no
 * caller has to decide what a failure looks like. A caller that formats its
 * own is how a shell ends up with two ways of saying the same thing and no
 * way to say the useful one.
 */
import type { AppError } from "../generated/app-shell";
import { parseAppError } from "../generated/app-shell";
import { parseTransportError } from "./client";

/**
 * A failure whose message is meant for the person using the app.
 *
 * Most failures are transport or provider failures, and the shell answers
 * those with a stable sentence and the actions that go with it — an internal
 * message would tell the reader nothing they can act on. A few are conditions
 * this app raises deliberately and has words for. This is how those say so,
 * without every raising site inventing its own presentation.
 */
export class UserFacingFailure extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "UserFacingFailure";
  }
}

export const FALLBACK_ERROR: AppError = {
  code: "native_unavailable",
  summary: "The native app shell is unavailable.",
  module: "app",
  timestampMs: 0,
  runtimeVersion: "unknown",
  actions: ["retry", "open_settings"],
};

export const PERSISTENCE_DEGRADED_ERROR: AppError = {
  code: "persistence_degraded",
  summary: "Changes could not be saved.",
  module: "state",
  timestampMs: 0,
  runtimeVersion: "unknown",
  actions: ["retry", "open_settings"],
};

export function toAppError(error: unknown): AppError {
  // A condition this app raised on purpose already has the words for it.
  if (error instanceof UserFacingFailure) {
    return { ...FALLBACK_ERROR, summary: error.message, detail: error.detail };
  }
  try {
    return parseAppError(error);
  } catch {
    // Tauri may reject with the structured DTO itself or wrap it in Error.
  }
  if (error instanceof Error && error.message.length > 0) {
    try {
      const decoded = JSON.parse(error.message) as unknown;
      return parseTransportError(decoded);
    } catch {
      // Tauri may wrap a structured command error in a plain message. An
      // internal message is not something the reader can act on, so an
      // unrecognised one becomes the stable sentence and its actions.
    }
    return FALLBACK_ERROR;
  }
  return FALLBACK_ERROR;
}
