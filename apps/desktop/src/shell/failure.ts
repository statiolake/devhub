/**
 * The one place an unknown failure becomes something the shell can show.
 *
 * Everything that can fail — a rejected request to main, a push that arrived
 * malformed, a surface that would not start — arrives here and leaves as an
 * `AppError`, so no caller has to decide what a failure looks like. A caller
 * that formats its own is how a shell ends up with two ways of saying the same
 * thing and no way to say the useful one.
 */

import type { AppError } from "../ipc/appShell";

/**
 * A failure whose message is meant for the person using the app.
 *
 * Most failures are transport failures, and the shell answers those with a
 * stable sentence and the actions that go with it — an internal message tells
 * the reader nothing they can act on. A few are conditions this app raises
 * deliberately and has words for. This is how those say so, without every
 * raising site inventing its own presentation.
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

function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<AppError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.module === "string" &&
    Array.isArray(candidate.actions)
  );
}

/**
 * Electron carries a rejection across the IPC boundary as an `Error` whose
 * message is the serialised original, so the structured error can arrive
 * either as itself or wrapped in a message. Both are unwrapped here, once.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof UserFacingFailure) {
    return { ...FALLBACK_ERROR, summary: error.message, detail: error.detail };
  }
  if (isAppError(error)) {
    return error;
  }
  if (error instanceof Error && error.message.length > 0) {
    const start = error.message.indexOf("{");
    if (start >= 0) {
      try {
        const decoded: unknown = JSON.parse(error.message.slice(start));
        if (isAppError(decoded)) {
          return decoded;
        }
      } catch {
        // Not a structured payload. An internal message is not something the
        // reader can act on, so it becomes the detail under a stable summary
        // rather than the summary itself.
      }
    }
    return { ...FALLBACK_ERROR, detail: error.message };
  }
  return FALLBACK_ERROR;
}

/**
 * The root handler.
 *
 * Nothing in the App Shell catches its own errors to explain them. A render
 * that threw, a rejected promise nobody awaited, an event handler that blew up
 * — all of it arrives here, and the shell draws it in the one place it draws
 * every other failure. Installed once, from the page's entry point.
 */
type UnhandledListener = (error: AppError) => void;

const unhandledListeners = new Set<UnhandledListener>();

export function reportUnhandled(reason: unknown): void {
  const error = toAppError(reason);
  for (const listener of unhandledListeners) {
    listener(error);
  }
}

export function subscribeToUnhandled(listener: UnhandledListener): () => void {
  unhandledListeners.add(listener);
  return () => {
    unhandledListeners.delete(listener);
  };
}

export function installRootFailureHandler(): void {
  window.addEventListener("error", (event) => {
    reportUnhandled(event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportUnhandled(event.reason);
  });
}
