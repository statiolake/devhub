import { useEffect, useMemo, useRef, useState } from "react";
import "./terminal.css";
import { useColorScheme } from "../appearance";
import { Failure, Waiting } from "../components/shell/SurfaceState";
import { openXtermSession, type XtermSession } from "../surfaces/xtermSession";
import {
  activePalette,
  terminalSurfaceStyle,
  type TerminalAppearance,
} from "./theme";
import {
  createTerminalClient,
  terminalErrorSummary,
  terminalInputChunks,
  type TerminalClient,
  type TerminalDetachRequest,
  type TerminalReceipt,
  type TerminalResizeRequest,
  type TerminalSize,
} from "./client";
import {
  MAX_TARGET_GENERATION,
  TERMINAL_PROTOCOL_VERSION,
  TerminalFrameDecoder,
  type StartedFrame,
  type TerminalFrame,
} from "../../ipc/terminal";

/**
 * One terminal surface: an xterm.js emulator bound to one PTY in main.
 *
 * Ported from the Tauri app's `src/terminal/TerminalSurface.tsx`. The identity
 * of the mount is the surface key, so an unrelated re-render never tears down
 * the emulator or reconnects its PTY; the pooled `hidden` surface keeps its
 * attachment and its scrollback while another surface is on screen.
 */
export interface TerminalSurfaceProps {
  readonly surfaceKey: string;
  readonly surfaceLabel: string;
  readonly appearance?: TerminalAppearance;
  readonly client?: TerminalClient;
  readonly hideTitle?: boolean;
  /**
   * The surface is mounted but not on screen. A pooled surface keeps its PTY
   * attachment and its scrollback while it waits its turn; it must not report
   * geometry, because a `display: none` host measures as nothing and the
   * fallback size would resize the pane behind the user's back.
   */
  readonly hidden?: boolean;
}

type ConnectionState = "connecting" | "connected" | "disconnected";

const DETACHABLE_ERROR = "The terminal connection is unavailable.";
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_HANDSHAKE_BUFFER_FRAMES = 8;
const MAX_HANDSHAKE_BUFFER_BYTES = 256 * 1024;

function requestFor(
  surfaceKey: string,
  targetGeneration: number,
  size: TerminalSize,
): TerminalResizeRequest {
  return {
    schemaVersion: TERMINAL_PROTOCOL_VERSION,
    surfaceKey,
    attachmentId: "",
    targetGeneration,
    ...size,
  };
}

function detachRequest(
  surfaceKey: string,
  receipt: TerminalReceipt,
): TerminalDetachRequest {
  return {
    schemaVersion: TERMINAL_PROTOCOL_VERSION,
    surfaceKey,
    attachmentId: receipt.attachmentId,
    targetGeneration: receipt.targetGeneration,
  };
}

function validReceipt(surfaceKey: string, receipt: TerminalReceipt): boolean {
  return (
    receipt.schemaVersion === TERMINAL_PROTOCOL_VERSION &&
    receipt.surfaceKey === surfaceKey &&
    /^[0-9a-f]{32}$/u.test(receipt.attachmentId) &&
    Number.isSafeInteger(receipt.targetGeneration) &&
    receipt.targetGeneration > 0 &&
    receipt.targetGeneration <= MAX_TARGET_GENERATION
  );
}

function validateStarted(
  surfaceKey: string,
  receipt: TerminalReceipt,
  frame: StartedFrame,
): void {
  if (
    frame.attachmentId !== receipt.attachmentId ||
    frame.surfaceKey !== surfaceKey ||
    frame.surfaceKey !== receipt.surfaceKey ||
    frame.targetGeneration !== receipt.targetGeneration
  ) {
    throw new Error("terminal attachment receipt did not match its channel");
  }
}

export function TerminalSurface({
  surfaceKey,
  surfaceLabel,
  appearance,
  client,
  hideTitle = false,
  hidden = false,
}: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // One client per mounted surface: its channel id is what makes a frame this
  // surface's frame and not another's.
  const boundClient = useMemo(() => client ?? createTerminalClient(), [client]);
  const clientRef = useRef(boundClient);
  const sessionRef = useRef<XtermSession | null>(null);
  const controllerRef = useRef<{ retry: () => void } | null>(null);
  const hiddenRef = useRef(hidden);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string>();

  clientRef.current = boundClient;
  hiddenRef.current = hidden;

  // The palette follows the page's scheme rather than a saved choice, so it
  // changes without the snapshot changing. Both schemes are already here, and
  // the scheme is the document's one answer — the viewport picks the ground
  // around this pane from the same palette, and the two have to match.
  const scheme = useColorScheme();

  const palette = activePalette(appearance, scheme === "dark");
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  useEffect(() => {
    sessionRef.current?.applyAppearance(undefined, palette);
  }, [palette]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    let attachSerial = 0;
    let receipt: TerminalReceipt | undefined;
    let receiptDetached = false;
    const detachedAttachmentIds = new Set<string>();
    let inputQueue:
      | {
          readonly serial: number;
          readonly attachmentId: string;
          nextSequence: number;
          tail: Promise<void>;
          failed: boolean;
        }
      | undefined;
    let session: XtermSession;
    try {
      session = openXtermSession(host, {
        appearance,
        palette: paletteRef.current,
        inputLabel: `${surfaceLabel} terminal input`,
        describedBy: hideTitle ? undefined : `${surfaceKey}-terminal-title`,
        isHidden: () => hiddenRef.current,
        onGeometry: (next) => {
          const nextReceipt = receipt;
          if (!nextReceipt || receiptDetached) return;
          const serial = attachSerial;
          void sendResize(nextReceipt, next, serial).catch(
            (resizeError: unknown) => fail(serial, resizeError),
          );
        },
      });
    } catch {
      // The emulator itself could not be constructed. There is no terminal to
      // recover into, so the pane says so instead of pretending to connect.
      setConnection("disconnected");
      setError("The terminal renderer is unavailable.");
      return undefined;
    }
    sessionRef.current = session;
    const terminal = session.terminal;

    const detachExact = (targetReceipt: TerminalReceipt) => {
      if (detachedAttachmentIds.has(targetReceipt.attachmentId)) return;
      detachedAttachmentIds.add(targetReceipt.attachmentId);
      if (receipt === targetReceipt) receiptDetached = true;
      void clientRef.current
        .detach(detachRequest(surfaceKey, targetReceipt))
        .catch(() => undefined);
    };

    const fail = (serial: number, failure: unknown) => {
      if (disposed || serial !== attachSerial) return;
      if (inputQueue?.serial === serial) inputQueue.failed = true;
      setConnection("disconnected");
      setError(terminalErrorSummary(failure));
      if (receipt && !receiptDetached) detachExact(receipt);
    };

    const sendResize = async (
      nextReceipt: TerminalReceipt,
      size: TerminalSize,
      serial: number,
    ) => {
      if (
        disposed ||
        serial !== attachSerial ||
        receipt !== nextReceipt ||
        receiptDetached
      ) {
        return;
      }
      const request = requestFor(
        surfaceKey,
        nextReceipt.targetGeneration,
        size,
      );
      await clientRef.current.resize({
        ...request,
        attachmentId: nextReceipt.attachmentId,
      });
    };

    const attach = async () => {
      const serial = ++attachSerial;
      const previousReceipt = receipt;
      if (previousReceipt && !receiptDetached) detachExact(previousReceipt);
      receipt = undefined;
      receiptDetached = false;
      inputQueue = undefined;
      const decoder = new TerminalFrameDecoder();
      let started: StartedFrame | undefined;
      let returnedReceipt: TerminalReceipt | undefined;
      let channelFailure: unknown;
      let channelFailed = false;
      let resolveStarted: () => void = () => undefined;
      let rejectStarted: (reason?: unknown) => void = () => undefined;
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      const bufferedFrames: TerminalFrame[] = [];
      let bufferedOutputBytes = 0;
      const startedReady = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      setConnection("connecting");
      setError(undefined);
      session.remeasure();

      const processFrame = (
        frame: TerminalFrame,
        frameReceipt: TerminalReceipt,
      ) => {
        if (frame.attachmentId !== frameReceipt.attachmentId) {
          throw new Error("terminal frame attachment identity changed");
        }
        if (frame.type === "output") {
          terminal.write(frame.bytes, () => {
            if (
              disposed ||
              serial !== attachSerial ||
              receipt !== frameReceipt ||
              receiptDetached
            ) {
              return;
            }
            // The acknowledgement is sent when the bytes are *rendered*, which
            // is what makes the window a real measure of what the view has
            // consumed rather than of what it has received.
            void clientRef.current
              .acknowledge({
                schemaVersion: TERMINAL_PROTOCOL_VERSION,
                surfaceKey,
                attachmentId: frame.attachmentId,
                targetGeneration: frameReceipt.targetGeneration,
                sequence: frame.sequence,
              })
              .catch((ackError: unknown) => fail(serial, ackError));
          });
        } else if (frame.type === "error") {
          throw new Error(frame.error.summary);
        } else if (frame.type === "exited") {
          setConnection("disconnected");
          setError("The terminal session disconnected. Retry to reconnect.");
          detachExact(frameReceipt);
        }
      };

      const onFrame = (value: unknown) => {
        if (disposed || serial !== attachSerial || channelFailed) return;
        try {
          const frame = decoder.push(value);
          if (frame.type === "started") {
            started = frame;
            if (returnedReceipt) {
              validateStarted(surfaceKey, returnedReceipt, frame);
            }
            if (
              returnedReceipt &&
              validReceipt(surfaceKey, returnedReceipt) &&
              handshakeTimer !== undefined
            ) {
              clearTimeout(handshakeTimer);
              handshakeTimer = undefined;
            }
            resolveStarted();
            return;
          }
          if (!returnedReceipt) {
            if (frame.type === "error") {
              throw new Error(frame.error.summary);
            }
            if (
              bufferedFrames.length >= MAX_HANDSHAKE_BUFFER_FRAMES ||
              (frame.type === "output" &&
                bufferedOutputBytes + frame.bytes.byteLength >
                  MAX_HANDSHAKE_BUFFER_BYTES)
            ) {
              throw new Error("terminal handshake buffer is full");
            }
            bufferedFrames.push(frame);
            if (frame.type === "output") {
              bufferedOutputBytes += frame.bytes.byteLength;
            }
            return;
          }
          processFrame(frame, returnedReceipt);
        } catch (frameError: unknown) {
          channelFailed = true;
          channelFailure = frameError;
          if (returnedReceipt && handshakeTimer !== undefined) {
            clearTimeout(handshakeTimer);
            handshakeTimer = undefined;
          }
          rejectStarted(frameError);
          if (returnedReceipt) fail(serial, frameError);
        }
      };

      handshakeTimer = setTimeout(() => {
        const timeout = new Error("terminal handshake timed out");
        channelFailed = true;
        channelFailure = timeout;
        rejectStarted(timeout);
        if (returnedReceipt) {
          fail(serial, timeout);
        } else if (!disposed && serial === attachSerial) {
          setConnection("disconnected");
          setError(terminalErrorSummary(timeout));
        }
      }, HANDSHAKE_TIMEOUT_MS);

      try {
        returnedReceipt = await clientRef.current.attach(
          {
            schemaVersion: TERMINAL_PROTOCOL_VERSION,
            surfaceKey,
            targetGeneration: 0,
            ...session.geometry,
          },
          onFrame,
        );
        if (disposed || serial !== attachSerial) {
          detachExact(returnedReceipt);
          return;
        }
        if (!validReceipt(surfaceKey, returnedReceipt)) {
          throw new Error("terminal attachment receipt is invalid");
        }
        receipt = returnedReceipt;
        if (channelFailure) throw channelFailure;
        await startedReady;
        if (started) validateStarted(surfaceKey, returnedReceipt, started);
        if (handshakeTimer !== undefined) {
          clearTimeout(handshakeTimer);
          handshakeTimer = undefined;
        }
        for (const frame of bufferedFrames) {
          processFrame(frame, returnedReceipt);
        }
        bufferedFrames.length = 0;
        bufferedOutputBytes = 0;
        if (receiptDetached) {
          throw new Error("terminal channel closed during handshake");
        }
        inputQueue = {
          serial,
          attachmentId: returnedReceipt.attachmentId,
          nextSequence: 0,
          tail: Promise.resolve(),
          failed: false,
        };
        setConnection("connected");
        await sendResize(returnedReceipt, session.geometry, serial);
      } catch (attachError: unknown) {
        if (handshakeTimer !== undefined) {
          clearTimeout(handshakeTimer);
          handshakeTimer = undefined;
        }
        // The request can resolve with a receipt after the frames already
        // rejected it, or after a replacement/unmount. Always release exactly
        // that returned opaque handle; stale channels are ignored by serial.
        if (returnedReceipt) detachExact(returnedReceipt);
        fail(serial, attachError);
      }
    };

    const dataDisposable = terminal.onData((data) => {
      const queue = inputQueue;
      const currentReceipt = receipt;
      if (
        !queue ||
        !currentReceipt ||
        queue.serial !== attachSerial ||
        queue.attachmentId !== currentReceipt.attachmentId ||
        queue.failed ||
        receiptDetached ||
        disposed
      ) {
        return;
      }
      const chunks = terminalInputChunks(new TextEncoder().encode(data));
      for (const bytes of chunks) {
        if (bytes.length === 0 || queue.failed) continue;
        const sequence = ++queue.nextSequence;
        // Input is a strict sequence, so the requests are chained rather than
        // raced: keystroke order is the whole meaning of a terminal.
        queue.tail = queue.tail
          .then(async () => {
            if (
              disposed ||
              queue.failed ||
              queue.serial !== attachSerial ||
              receipt !== currentReceipt ||
              receiptDetached
            ) {
              return;
            }
            await clientRef.current.input({
              schemaVersion: TERMINAL_PROTOCOL_VERSION,
              surfaceKey,
              attachmentId: currentReceipt.attachmentId,
              targetGeneration: currentReceipt.targetGeneration,
              inputSequence: sequence,
              bytes,
            });
          })
          .catch((inputError: unknown) => fail(queue.serial, inputError));
      }
    });

    const focusTerminal = () => terminal.focus();
    host.addEventListener("click", focusTerminal);
    void attach();
    if (!hiddenRef.current) terminal.focus();

    controllerRef.current = {
      retry() {
        void attach();
      },
    };

    return () => {
      disposed = true;
      attachSerial += 1;
      host.removeEventListener("click", focusTerminal);
      dataDisposable.dispose();
      if (receipt && !receiptDetached) detachExact(receipt);
      receipt = undefined;
      inputQueue = undefined;
      session.dispose();
      sessionRef.current = null;
      controllerRef.current = null;
    };
    // The surface key is the mount identity, so unrelated snapshot revisions
    // never remount the xterm or reconnect its PTY client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceKey]);

  useEffect(() => {
    // Coming back on screen is the first moment the host has a real box, so
    // the size the pane missed while it was pooled is sent now.
    if (hidden) return;
    sessionRef.current?.remeasure();
    // Selecting a surface is a request to type into it, whether it is being
    // attached for the first time or coming back out of the pool.
    sessionRef.current?.focus();
  }, [hidden]);

  useEffect(() => {
    // Appearance is a projection, not a surface identity. Update the live
    // xterm options and geometry without tearing down the PTY attachment.
    sessionRef.current?.applyAppearance(appearance, undefined);
  }, [appearance]);

  return (
    <div
      className="terminal-surface-shell"
      data-connection={connection}
      style={
        terminalSurfaceStyle(
          palette,
          appearance?.terminalMargin,
        ) as React.CSSProperties
      }
    >
      {!hideTitle && (
        <h1
          id={`${surfaceKey}-terminal-title`}
          className="terminal-surface-title"
        >
          {surfaceLabel}
        </h1>
      )}
      <div
        ref={hostRef}
        className="terminal-surface"
        role="application"
        aria-label={`${surfaceLabel} terminal`}
        tabIndex={0}
      />
      {connection === "connecting" && <Waiting label="Connecting…" />}
      {connection === "disconnected" && (
        <Failure
          summary="The terminal session is not connected."
          detail={error ?? DETACHABLE_ERROR}
          actions={[
            {
              label: "Retry",
              primary: true,
              run: () => controllerRef.current?.retry(),
            },
          ]}
        />
      )}
    </div>
  );
}
