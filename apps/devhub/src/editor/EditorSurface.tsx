/**
 * The Editor Activity's Surface.
 *
 * The Workbench is a single global thing — VS Code's services cannot be raised
 * twice in one document — so this component owns none of it. It starts the
 * Workbench on the first visit and afterwards only moves the element that
 * holds it into whatever Surface is on screen, which is also what keeps the
 * editor state, terminals, and extension host alive across an Activity switch.
 */
import { useEffect, useRef, useState } from "react";
import type { AppError } from "../generated/app-shell";
import type { EditorRemote } from "../app/client";

type Phase =
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly host: HTMLElement }
  | { readonly kind: "failed"; readonly detail: string };

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
  readonly failure?: AppError;
}

export function EditorSurface({ remote, folder, failure }: EditorSurfaceProps) {
  const slot = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });

  useEffect(() => {
    if (!remote) return;
    let cancelled = false;
    loadWorkbench()
      .then(async (workbench) => {
        await workbench.startWorkbench({ remote, folder });
        return workbench.workbenchHost();
      })
      .then(
        (host) => {
          if (cancelled) return;
          setPhase(
            host
              ? { kind: "ready", host }
              : { kind: "failed", detail: "The editor did not start." },
          );
        },
        (error: unknown) => {
          if (!cancelled) {
            setPhase({
              kind: "failed",
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [remote, folder]);

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

  if (failure) {
    return (
      <EditorNotice
        role="alert"
        line={failure.summary}
        detail={failure.detail ?? undefined}
      />
    );
  }
  if (phase.kind === "failed") {
    return <EditorNotice role="alert" line={phase.detail} />;
  }
  return (
    <div className="editor-surface" ref={slot}>
      {phase.kind === "starting" ? (
        <EditorNotice role="status" line="Starting the editor…" busy />
      ) : null}
    </div>
  );
}

function EditorNotice({
  line,
  detail,
  role,
  busy,
}: {
  readonly line: string;
  readonly detail?: string;
  readonly role: "status" | "alert";
  readonly busy?: boolean;
}) {
  return (
    <div className="surface-state" role={role}>
      {busy ? <span className="surface-spinner" aria-hidden="true" /> : null}
      <p className="surface-line">{line}</p>
      {/* The summary says what to do; the detail says what happened. */}
      {detail ? <p className="failure-detail">{detail}</p> : null}
    </div>
  );
}
