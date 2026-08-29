/**
 * What an Editor frame and the App Shell say to each other.
 *
 * They are two documents on one origin, so this is `postMessage` and nothing
 * more: the frame reports whether its Workbench came up, and the shell shows
 * that where it shows every other Surface's state. Everything else the
 * Workbench does stays inside the frame, which is the point of the frame.
 */
export const WORKBENCH_FRAME_PATH = "/workbench.html";

export interface WorkbenchReady {
  readonly kind: "workbench-ready";
}

export interface WorkbenchFailed {
  readonly kind: "workbench-failed";
  readonly summary: string;
  readonly detail?: string;
}

/**
 * A destination the Workbench decided belongs outside it.
 *
 * The frame cannot reach the operating system and should not: it says where
 * the reader asked to go, and the shell decides what that means.
 */
export interface OpenExternal {
  readonly kind: "open-external";
  readonly url: string;
}

export type WorkbenchFrameMessage =
  | WorkbenchReady
  | WorkbenchFailed
  | OpenExternal;

/** The frame's own address, carrying what it needs to raise a Workbench. */
export function workbenchFrameSource(
  authority: string,
  connectionToken: string,
  folder: string | undefined,
): string {
  const query = new URLSearchParams({ authority, connectionToken });
  if (folder != null) query.set("folder", folder);
  // The display language is chosen before the Workbench boots — it decides
  // which language pack to load — so it travels in the address rather than
  // being set afterwards.
  const locale = displayLanguage();
  if (locale != null) query.set("locale", locale);
  return `${WORKBENCH_FRAME_PATH}?${query.toString()}`;
}

const DISPLAY_LANGUAGE_KEY = "devhub.editor.displayLanguage";

/**
 * The display language the user chose, if they chose one.
 *
 * Kept in storage the shell and its frames share, because the choice is made
 * inside a frame and has to be honoured by every frame opened afterwards.
 * Reading it can throw where site data is blocked, and a reader who cannot
 * find a choice has the same answer as one who finds none: the default.
 */
export function displayLanguage(): string | null {
  try {
    return window.localStorage.getItem(DISPLAY_LANGUAGE_KEY);
  } catch {
    return null;
  }
}

export function setDisplayLanguage(locale: string | null): void {
  try {
    if (locale == null) window.localStorage.removeItem(DISPLAY_LANGUAGE_KEY);
    else window.localStorage.setItem(DISPLAY_LANGUAGE_KEY, locale);
  } catch {
    // Storage is unavailable, so the choice cannot outlive this frame. The
    // reload below still applies it to the frame the user is looking at.
  }
}

/** Narrow an arriving message, which is untrusted until it is one of ours. */
export function asFrameMessage(value: unknown): WorkbenchFrameMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "workbench-ready") return { kind: "workbench-ready" };
  if (candidate.kind === "open-external" && typeof candidate.url === "string") {
    return { kind: "open-external", url: candidate.url };
  }
  if (candidate.kind === "workbench-failed") {
    return {
      kind: "workbench-failed",
      summary:
        typeof candidate.summary === "string"
          ? candidate.summary
          : "The editor could not start.",
      detail:
        typeof candidate.detail === "string" ? candidate.detail : undefined,
    };
  }
  return null;
}
