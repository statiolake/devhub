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

export type WorkbenchFrameMessage = WorkbenchReady | WorkbenchFailed;

/** The frame's own address, carrying what it needs to raise a Workbench. */
export function workbenchFrameSource(
  authority: string,
  connectionToken: string,
  folder: string | undefined,
): string {
  const query = new URLSearchParams({ authority, connectionToken });
  if (folder != null) query.set("folder", folder);
  return `${WORKBENCH_FRAME_PATH}?${query.toString()}`;
}

/** Narrow an arriving message, which is untrusted until it is one of ours. */
export function asFrameMessage(value: unknown): WorkbenchFrameMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "workbench-ready") return { kind: "workbench-ready" };
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
