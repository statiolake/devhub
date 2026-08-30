/**
 * The Agent Surface: an xterm.js view over the Herdr control stream.
 *
 * Ported from the Tauri app's `src/terminal/TerminalSurface.tsx` as it was used
 * for agent surfaces, minus the performance-marker callbacks that instrumented
 * the Tauri build (`onResizeInvokeEntered`, `onOutputAfterInputRendered`, and
 * the rest) — those existed to drive that app's timing harness and have no
 * equivalent here. What is kept is the whole lifecycle that makes an
 * attachment correct:
 *
 *  - attach once per mount, with the receipt validated against the Started
 *    frame before a single byte is rendered;
 *  - output written in order, then acknowledged cumulatively so main's
 *    back-pressure window reopens;
 *  - input serialized behind one queue with a strictly increasing sequence,
 *    chunked on character boundaries;
 *  - geometry reported on resize, never while the view is hidden (a
 *    `display: none` host measures as nothing);
 *  - detach on unmount, and every failure drawn in the Surface it happened
 *    in, named by the same codes the rest of DevHub names failures by, rather
 *    than swallowed into a blank pane.
 */

import { useEffect, useRef, useState } from "react";

import {
  MAX_TARGET_GENERATION,
  TERMINAL_PROTOCOL_VERSION,
  TerminalErrorCode,
  agentFailure,
  agentSurfaceKey,
  terminalError,
  type AgentFailure,
  type AttachReceipt,
  type TerminalFrame,
} from "../../ipc/agent.js";
import {
  agentDetachRequest,
  agentInputChunks,
  defaultAgentSurfaceClient,
  type AgentSurfaceClient,
} from "./client.js";
import { APP_ERROR_SUMMARY } from "../../ipc/appShell.js";
import { Failure, Waiting } from "../components/shell/SurfaceState";
import {
  FALLBACK_GEOMETRY,
  openXtermSession,
  type SurfaceGeometry,
  type XtermSession,
} from "../surfaces/xtermSession";
import {
  activePalette,
  prefersDark,
  terminalSurfaceStyle,
  type TerminalAppearance,
} from "../terminal/theme";

export interface AgentSurfaceViewProps {
  /** The domain Agent this surface shows. The surface key is derived. */
  readonly agentId: string;
  readonly agentLabel: string;
  /**
   * The surface is mounted but not on screen. A pooled surface keeps its
   * attachment and its scrollback while it waits its turn; it must not
   * report geometry, because a hidden host measures as nothing.
   */
  readonly hidden?: boolean;
  readonly client?: AgentSurfaceClient;
  /** The same appearance a terminal surface gets: it is the same emulator. */
  readonly appearance?: TerminalAppearance;
}

type ConnectionState = "connecting" | "connected" | "disconnected";

function validReceipt(surfaceKey: string, receipt: AttachReceipt): boolean {
  return (
    receipt.schemaVersion === TERMINAL_PROTOCOL_VERSION &&
    receipt.surfaceKey === surfaceKey &&
    /^[0-9a-f]{32}$/u.test(receipt.attachmentId) &&
    Number.isSafeInteger(receipt.targetGeneration) &&
    receipt.targetGeneration > 0 &&
    receipt.targetGeneration <= MAX_TARGET_GENERATION
  );
}

export function AgentSurfaceView({
  agentId,
  agentLabel,
  hidden = false,
  client,
  appearance,
}: AgentSurfaceViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<XtermSession | null>(null);
  const hiddenRef = useRef(hidden);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [failure, setFailure] = useState<AgentFailure>();
  hiddenRef.current = hidden;

  const [dark, setDark] = useState(() => prefersDark());
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return undefined;
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    query.addEventListener("change", onChange);
    setDark(query.matches);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const palette = activePalette(appearance, dark);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return undefined;
    }
    const surfaceKey = agentSurfaceKey(agentId);
    const surfaceClient = client ?? defaultAgentSurfaceClient();
    let disposed = false;
    let session: XtermSession | undefined;
    let receipt: AttachReceipt | undefined;
    let nextInputSequence = 1;
    let inputTail: Promise<void> = Promise.resolve();
    let inputFailed = false;

    // Every way this surface can fail ends here, and leaves as the same shape
    // the rest of DevHub shows a failure in: a code, the sentence that code is
    // always drawn as, and a detail that says what the channel reported.
    const report = (caught: unknown): void => {
      if (disposed) {
        return;
      }
      setConnection("disconnected");
      setFailure(agentFailure(caught));
    };

    const acknowledge = (sequence: number): void => {
      if (receipt === undefined) {
        return;
      }
      void surfaceClient
        .acknowledge({
          schemaVersion: TERMINAL_PROTOCOL_VERSION,
          surfaceKey,
          attachmentId: receipt.attachmentId,
          targetGeneration: receipt.targetGeneration,
          sequence,
        })
        .catch(report);
    };

    const onFrame = (frame: TerminalFrame): void => {
      if (disposed || receipt === undefined) {
        return;
      }
      if (frame.attachmentId !== receipt.attachmentId) {
        return;
      }
      switch (frame.type) {
        case "started":
          if (
            frame.surfaceKey !== surfaceKey ||
            frame.targetGeneration !== receipt.targetGeneration
          ) {
            report(terminalError(TerminalErrorCode.WrongAttachment));
            return;
          }
          setConnection("connected");
          return;
        case "output":
          session?.terminal.write(frame.bytes);
          acknowledge(frame.sequence);
          return;
        case "exited":
          setConnection("disconnected");
          setFailure(
            agentFailure(terminalError(TerminalErrorCode.SessionUnavailable)),
          );
          return;
        case "error":
          report(frame.error);
          return;
      }
    };

    const sendInput = (data: string): void => {
      if (receipt === undefined || inputFailed) {
        return;
      }
      const attachment = receipt;
      for (const bytes of agentInputChunks(data)) {
        const inputSequence = nextInputSequence;
        nextInputSequence += 1;
        inputTail = inputTail
          .then(() =>
            inputFailed
              ? undefined
              : surfaceClient.input({
                  schemaVersion: TERMINAL_PROTOCOL_VERSION,
                  surfaceKey,
                  attachmentId: attachment.attachmentId,
                  targetGeneration: attachment.targetGeneration,
                  inputSequence,
                  bytes,
                }),
          )
          .then(
            () => undefined,
            (inputError: unknown) => {
              // One rejected input invalidates the sequence: every
              // later chunk would be refused as a gap. Stop, and
              // say so.
              inputFailed = true;
              report(inputError);
            },
          );
      }
    };

    const reportGeometry = (geometry: SurfaceGeometry): void => {
      if (receipt === undefined || hiddenRef.current) {
        return;
      }
      void surfaceClient
        .resize({
          schemaVersion: TERMINAL_PROTOCOL_VERSION,
          surfaceKey,
          attachmentId: receipt.attachmentId,
          targetGeneration: receipt.targetGeneration,
          ...geometry,
        })
        .catch(report);
    };

    void (async () => {
      try {
        session = openXtermSession(host, {
          appearance,
          palette: paletteRef.current,
          inputLabel: `${agentLabel} agent input`,
          isHidden: () => hiddenRef.current,
          onGeometry: reportGeometry,
        });
        if (disposed) {
          session.dispose();
          return;
        }
        sessionRef.current = session;
        session.terminal.onData(sendInput);
        const geometry = hiddenRef.current
          ? FALLBACK_GEOMETRY
          : session.geometry;
        const attached = await surfaceClient.attach(
          {
            schemaVersion: TERMINAL_PROTOCOL_VERSION,
            surfaceKey,
            targetGeneration: 0,
            ...geometry,
          },
          onFrame,
        );
        if (disposed) {
          await surfaceClient
            .detach(agentDetachRequest(surfaceKey, attached))
            .catch(() => undefined);
          return;
        }
        if (!validReceipt(surfaceKey, attached)) {
          throw terminalError(TerminalErrorCode.WrongAttachment);
        }
        receipt = attached;
        setConnection("connected");
        if (!hiddenRef.current) session.focus();
      } catch (failure) {
        report(failure);
      }
    })();

    return () => {
      disposed = true;
      const attached = receipt;
      receipt = undefined;
      if (attached !== undefined) {
        void surfaceClient
          .detach(agentDetachRequest(surfaceKey, attached))
          .catch(() => undefined);
      }
      session?.dispose();
      sessionRef.current = null;
    };
    // The agent id is the mount identity: an appearance change updates the
    // live emulator below rather than tearing the attachment down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, client]);

  useEffect(() => {
    sessionRef.current?.applyAppearance(appearance, palette);
  }, [appearance, palette]);

  useEffect(() => {
    // Coming back on screen is the first moment the host has a real box, so
    // the size the surface missed while it was pooled is reported now.
    if (hidden) return;
    sessionRef.current?.remeasure();
    sessionRef.current?.focus();
  }, [hidden]);

  return (
    <div
      className="terminal-surface-shell"
      data-connection={connection}
      aria-label={`Agent surface for ${agentLabel}`}
      style={terminalSurfaceStyle(palette, appearance?.terminalMargin)}
    >
      <div
        ref={hostRef}
        className="terminal-surface"
        role="application"
        aria-label={`${agentLabel} agent`}
        tabIndex={0}
      />
      {connection === "connecting" && <Waiting label="Connecting…" />}
      {connection === "disconnected" && (
        <Failure
          summary={failure?.summary ?? APP_ERROR_SUMMARY.agent_not_connected}
          detail={failure?.detail}
        />
      )}
    </div>
  );
}
