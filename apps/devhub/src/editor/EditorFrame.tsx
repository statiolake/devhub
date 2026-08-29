/**
 * One Workspace's Editor, in a document of its own.
 *
 * The Workbench is drawn by a frame rather than by this component, because VS
 * Code is written as though it owns a window: fixed-position modals,
 * document-level key handlers, focus that belongs to the page. Inside a frame
 * every one of those is true again and none of them reaches the App Shell — a
 * trust dialog covers the Editor, not the Sidebar and the tabs.
 *
 * It also settles what one Workbench could not: a workspace is chosen while
 * the Workbench comes up and cannot be changed afterwards, so each Workspace
 * gets its own.
 */
import { useEffect, useRef, useState } from "react";
import type { EditorRemote } from "../app/client";
import type { AppError } from "../generated/app-shell";
import { Failure, Waiting } from "../components/shell/SurfaceState";
import { useAppShell } from "../app/useAppShell";
import { asFrameMessage, workbenchFrameSource } from "./frameProtocol";
import { trace } from "./trace";

type Phase =
  | { readonly kind: "opening" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly error: AppError };

export interface EditorFrameProps {
  readonly remote: EditorRemote;
  /** The Workspace root this frame opens; absent for the global Editor. */
  readonly folder?: string;
}

export function EditorFrame({ remote, folder }: EditorFrameProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "opening" });
  const { openExternalUrl } = useAppShell();

  useEffect(() => {
    const listen = (event: MessageEvent<unknown>) => {
      // Same origin, and from this frame: a message from anywhere else is
      // about somebody else's Workbench.
      if (event.origin !== window.location.origin) return;
      if (event.source !== frame.current?.contentWindow) return;
      const message = asFrameMessage(event.data);
      if (!message) return;
      trace("frame: message", message.kind);
      if (message.kind === "open-external") {
        openExternalUrl(message.url);
        return;
      }
      setPhase(
        message.kind === "workbench-ready"
          ? { kind: "ready" }
          : {
              kind: "failed",
              error: {
                code: "editor_unavailable",
                summary: message.summary,
                detail: message.detail,
                module: "editor",
                timestampMs: 0,
                runtimeVersion: "unknown",
                actions: ["retry"],
              },
            },
      );
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [openExternalUrl]);

  const source = workbenchFrameSource(
    remote.authority,
    remote.connectionToken,
    folder,
  );

  return (
    <div className="editor-frame">
      {phase.kind === "failed" ? (
        <Failure
          summary={phase.error.summary}
          detail={phase.error.detail ?? undefined}
        />
      ) : null}
      {phase.kind === "opening" ? (
        <Waiting label="Opening the workbench…" />
      ) : null}
      <iframe
        ref={frame}
        className="editor-frame-document"
        // The title is what assistive technology announces before entering a
        // document that is, from here, opaque.
        title={folder ? `Editor for ${folder}` : "Editor"}
        src={source}
        hidden={phase.kind !== "ready"}
      />
    </div>
  );
}
