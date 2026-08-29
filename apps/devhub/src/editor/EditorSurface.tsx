/**
 * The Editor Activity's Surface.
 *
 * The Workbench is a single global thing — VS Code's services cannot be raised
 * twice in one document — so this component owns none of it. It starts the
 * Workbench on the first visit and afterwards only moves the element that
 * holds it into whatever Surface is on screen, which is also what keeps the
 * editor state, terminals, and extension host alive across an Activity switch.
 *
 * Nothing here explains a failure. A start that does not succeed is handed to
 * the shell, which shows it where it shows every other failure.
 */
import { useEffect, useRef, useState } from "react";
import type { EditorRemote } from "../app/client";
import { useAppShell } from "../app/useAppShell";
import { trace } from "./trace";

/**
 * Two different waits were sharing one sentence.
 *
 * Waiting for a server and waiting for the Workbench to come up on it fail for
 * unrelated reasons and are fixed in unrelated places, so a Surface that says
 * only "starting" tells nobody which of them has stopped.
 */
type Phase =
  | { readonly kind: "awaiting-server" }
  | { readonly kind: "opening" }
  | { readonly kind: "ready"; readonly host: HTMLElement }
  | { readonly kind: "stopped" };

const WAITING_LINE: Record<"awaiting-server" | "opening", string> = {
  "awaiting-server": "Starting the editor server…",
  opening: "Opening the workbench…",
};

/**
 * The Workbench is most of a copy of VS Code, and the shell is useful without
 * it. Loading it when the Editor is first opened keeps that weight off every
 * launch that never opens one — and off the test environment, which renders
 * the shell and has no business parsing an editor's stylesheets.
 */
const loadWorkbench = () => import("./workbench");

export interface EditorSurfaceProps {
  /** Resolved once the native side has a server running. */
  readonly remote?: EditorRemote;
  /** The Workspace root this Surface is for; absent for the global Editor. */
  readonly folder?: string;
}

export function EditorSurface({ remote, folder }: EditorSurfaceProps) {
  const { reportFailure } = useAppShell();
  const slot = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "awaiting-server" });

  useEffect(() => {
    if (!remote) {
      trace("surface: no server yet, waiting", { folder });
      setPhase({ kind: "awaiting-server" });
      return undefined;
    }
    let cancelled = false;
    trace("surface: opening", { folder, authority: remote.authority });
    setPhase({ kind: "opening" });
    loadWorkbench()
      .then(async (workbench) => {
        trace("surface: bundle loaded");
        await workbench.startWorkbench({ remote, folder });
        trace("surface: startWorkbench returned");
        return workbench.workbenchHost();
      })
      .then(
        (host) => {
          if (cancelled) {
            trace("surface: resolved after cancel, ignoring");
            return;
          }
          trace("surface: ready", { adopted: host != null });
          setPhase(host ? { kind: "ready", host } : { kind: "stopped" });
        },
        (error: unknown) => {
          if (cancelled) {
            trace("surface: rejected after cancel, ignoring", error);
            return;
          }
          trace("surface: failed", error);
          setPhase({ kind: "stopped" });
          reportFailure(error);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [remote, folder, reportFailure]);

  // Adopting the element rather than rendering it: React must not own a tree
  // VS Code writes into, and the Workbench survives being moved between
  // parents in a way it would not survive being unmounted.
  useEffect(() => {
    if (phase.kind !== "ready") return undefined;
    const container = slot.current;
    const workbench = phase.host;
    if (!container) return undefined;
    trace("surface: adopting the workbench element");
    container.appendChild(workbench);
    return () => {
      if (workbench.parentElement === container) {
        workbench.remove();
      }
    };
  }, [phase]);

  return (
    <div className="editor-surface" ref={slot}>
      {phase.kind === "awaiting-server" || phase.kind === "opening" ? (
        <div className="surface-state" role="status">
          <span className="surface-spinner" aria-hidden="true" />
          <p className="surface-line">{WAITING_LINE[phase.kind]}</p>
        </div>
      ) : null}
    </div>
  );
}
