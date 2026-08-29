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

type Phase =
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly host: HTMLElement }
  | { readonly kind: "stopped" };

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
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });

  useEffect(() => {
    if (!remote) return undefined;
    let cancelled = false;
    setPhase({ kind: "starting" });
    loadWorkbench()
      .then(async (workbench) => {
        await workbench.startWorkbench({ remote, folder });
        return workbench.workbenchHost();
      })
      .then(
        (host) => {
          if (cancelled) return;
          setPhase(host ? { kind: "ready", host } : { kind: "stopped" });
        },
        (error: unknown) => {
          if (cancelled) return;
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
    container.appendChild(workbench);
    return () => {
      if (workbench.parentElement === container) {
        workbench.remove();
      }
    };
  }, [phase]);

  return (
    <div className="editor-surface" ref={slot}>
      {phase.kind === "starting" ? (
        <div className="surface-state" role="status">
          <span className="surface-spinner" aria-hidden="true" />
          <p className="surface-line">Starting the editor…</p>
        </div>
      ) : null}
    </div>
  );
}
