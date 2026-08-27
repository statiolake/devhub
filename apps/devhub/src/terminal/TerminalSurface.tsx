import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  activePalette,
  prefersDark,
  terminalFontStack,
  terminalSurfaceStyle,
  xtermTheme,
} from "./theme";
import type { TerminalChannelDiagnostic } from "../app/client";
import type { AppAppearance } from "../generated/app-shell";
import {
  defaultTerminalClient,
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
} from "./generated";

export interface TerminalSurfaceProps {
  readonly surfaceKey: string;
  readonly surfaceLabel: string;
  readonly appearance?: AppAppearance;
  readonly client?: TerminalClient;
  readonly hideTitle?: boolean;
  readonly onInteractive?: () => void;
  readonly onAttachInvokeRejected?: () => void;
  readonly onResizeInvokeEntered?: () => void;
  readonly onResizeInvokeRejected?: () => void;
  readonly onInputInvokeEntered?: () => void;
  readonly onInputInvokeRejected?: () => void;
  readonly onOutputRendered?: () => void;
  readonly onOutputAfterInputRendered?: () => void;
  readonly onChannelDiagnostic?: (marker: TerminalChannelDiagnostic) => void;
}

type ConnectionState = "connecting" | "connected" | "disconnected";

const FALLBACK_SIZE: TerminalSize = {
  cols: 80,
  rows: 24,
  pixelWidth: 0,
  pixelHeight: 0,
};

const DETACHABLE_ERROR = "The terminal connection is unavailable.";
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_HANDSHAKE_BUFFER_FRAMES = 8;
const MAX_HANDSHAKE_BUFFER_BYTES = 256 * 1024;

type InteractiveInputProbe = {
  readonly serial: number;
  readonly attachmentId: string;
  readonly gestureEpoch: number;
  readonly inputSequence: number;
  accepted: boolean;
  outputRendered: boolean;
  failed: boolean;
  reported: boolean;
};

function terminalSize(fit: FitAddon): TerminalSize {
  try {
    fit.fit();
    const dimensions = fit.proposeDimensions();
    if (dimensions && dimensions.cols > 0 && dimensions.rows > 0) {
      return {
        cols: Math.min(500, Math.max(1, dimensions.cols)),
        rows: Math.min(500, Math.max(1, dimensions.rows)),
        pixelWidth: 0,
        pixelHeight: 0,
      };
    }
  } catch {
    // jsdom and a hidden webview can lack layout metrics; native validation
    // still receives a bounded initial size.
  }
  return FALLBACK_SIZE;
}

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

function isTerminalFrame(value: TerminalFrame): value is TerminalFrame {
  return value.type.length > 0;
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
    throw new Error("terminal attachment receipt did not match its Channel");
  }
}

export function TerminalSurface({
  surfaceKey,
  surfaceLabel,
  appearance,
  client = defaultTerminalClient,
  hideTitle = false,
  onInteractive,
  onAttachInvokeRejected,
  onResizeInvokeEntered,
  onResizeInvokeRejected,
  onInputInvokeEntered,
  onInputInvokeRejected,
  onOutputRendered,
  onOutputAfterInputRendered,
  onChannelDiagnostic,
}: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef(client);
  const terminalRef = useRef<Terminal | null>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  const controllerRef = useRef<{ retry: () => void } | null>(null);
  const interactiveRef = useRef(onInteractive);
  const attachInvokeRejectedRef = useRef(onAttachInvokeRejected);
  const resizeInvokeEnteredRef = useRef(onResizeInvokeEntered);
  const resizeInvokeRejectedRef = useRef(onResizeInvokeRejected);
  const inputInvokeEnteredRef = useRef(onInputInvokeEntered);
  const inputInvokeRejectedRef = useRef(onInputInvokeRejected);
  const outputRenderedRef = useRef(onOutputRendered);
  const outputAfterInputRenderedRef = useRef(onOutputAfterInputRendered);
  const channelDiagnosticRef = useRef(onChannelDiagnostic);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string>();

  clientRef.current = client;
  interactiveRef.current = onInteractive;
  attachInvokeRejectedRef.current = onAttachInvokeRejected;
  resizeInvokeEnteredRef.current = onResizeInvokeEntered;
  resizeInvokeRejectedRef.current = onResizeInvokeRejected;
  inputInvokeEnteredRef.current = onInputInvokeEntered;
  inputInvokeRejectedRef.current = onInputInvokeRejected;
  outputRenderedRef.current = onOutputRendered;
  outputAfterInputRenderedRef.current = onOutputAfterInputRendered;
  channelDiagnosticRef.current = onChannelDiagnostic;

  // The palette follows the system appearance rather than a saved choice, so
  // it changes without the snapshot changing. Both schemes are already here.
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
    const terminal = terminalRef.current;
    if (terminal && palette) terminal.options.theme = xtermTheme(palette);
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
    let observer: ResizeObserver | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingResize: TerminalSize | undefined;
    let currentSize = FALLBACK_SIZE;
    let firstOutputRendered = false;
    let inputGestureEpoch = 0;
    let armedInputGestureEpoch: number | undefined;
    let consumedInputGestureEpoch: number | undefined;
    let interactiveProbe: InteractiveInputProbe | undefined;

    const reportInteractiveIfReady = (probe: InteractiveInputProbe) => {
      if (
        probe.serial !== attachSerial ||
        probe.attachmentId !== receipt?.attachmentId ||
        probe.failed ||
        probe.reported ||
        !probe.accepted ||
        !probe.outputRendered
      ) {
        return;
      }
      probe.reported = true;
      interactiveRef.current?.();
    };

    const discardInputGesture = () => {
      inputGestureEpoch += 1;
      armedInputGestureEpoch = undefined;
      consumedInputGestureEpoch = undefined;
      interactiveProbe = undefined;
    };

    const armInputGesture = () => {
      inputGestureEpoch += 1;
      armedInputGestureEpoch = inputGestureEpoch;
    };

    let terminal: Terminal;
    let fit: FitAddon;
    try {
      terminal = new Terminal({
        cursorBlink: true,
        convertEol: false,
        fontFamily: terminalFontStack(appearance?.terminalFontFamily),
        fontSize: appearance?.terminalFontSize ?? 13,
        lineHeight: appearance?.terminalLineHeight ?? 1.2,
        scrollback: 10_000,
        theme: paletteRef.current ? xtermTheme(paletteRef.current) : undefined,
      });
      terminalRef.current = terminal;
      fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      // xterm owns a hidden native textarea for keyboard and IME input. Keep
      // that responder discoverable to VoiceOver without adding a second
      // visible control or intercepting composition events in React.
      const input = host.querySelector<HTMLTextAreaElement>("textarea");
      if (input) {
        input.setAttribute("aria-label", `${surfaceLabel} terminal input`);
        if (!hideTitle) {
          input.setAttribute(
            "aria-describedby",
            `${surfaceKey}-terminal-title`,
          );
        }
      }
      terminal.attachCustomKeyEventHandler(() => true);
    } catch {
      terminalRef.current?.dispose();
      terminalRef.current = null;
      setConnection("disconnected");
      setError("The terminal renderer is unavailable.");
      return undefined;
    }

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
      try {
        resizeInvokeEnteredRef.current?.();
        await clientRef.current.resize({
          ...request,
          attachmentId: nextReceipt.attachmentId,
        });
      } catch (resizeError: unknown) {
        try {
          resizeInvokeRejectedRef.current?.();
        } catch {
          // Diagnostics must never alter terminal resize behavior.
        }
        throw resizeError;
      }
    };

    const queueResize = (size: TerminalSize, serial: number) => {
      pendingResize = size;
      if (resizeTimer !== undefined) return;
      // ResizeObserver can deliver a burst while layout settles. Keep only
      // the latest bounded dimensions and send at most one request per frame
      // interval; native applies the same coalescing policy as a backstop.
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        const nextSize = pendingResize;
        pendingResize = undefined;
        const nextReceipt = receipt;
        if (!nextSize || !nextReceipt || receiptDetached) return;
        void sendResize(nextReceipt, nextSize, serial).catch(
          (resizeError: unknown) => fail(serial, resizeError),
        );
      }, 16);
    };

    resizeRef.current = () => {
      currentSize = terminalSize(fit);
      queueResize(currentSize, attachSerial);
    };

    const attach = async () => {
      const serial = ++attachSerial;
      discardInputGesture();
      const previousReceipt = receipt;
      if (previousReceipt && !receiptDetached) detachExact(previousReceipt);
      receipt = undefined;
      receiptDetached = false;
      inputQueue = undefined;
      firstOutputRendered = false;
      interactiveProbe = undefined;
      const decoder = new TerminalFrameDecoder();
      let started: StartedFrame | undefined;
      let returnedReceipt: TerminalReceipt | undefined;
      let channelFailure: unknown;
      let channelFailed = false;
      let firstChannelCallbackReceived = false;
      let startedFrameValidated = false;
      let frameFailureReported = false;
      let resolveStarted: () => void = () => undefined;
      let rejectStarted: (reason?: unknown) => void = () => undefined;
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      const bufferedFrames: TerminalFrame[] = [];
      let bufferedOutputBytes = 0;
      const startedReady = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      const reportChannelDiagnostic = (marker: TerminalChannelDiagnostic) => {
        try {
          channelDiagnosticRef.current?.(marker);
        } catch {
          // Diagnostics must never alter terminal Channel behavior.
        }
      };
      const validateStartedFrame = (
        frame: StartedFrame,
        frameReceipt: TerminalReceipt,
      ) => {
        validateStarted(surfaceKey, frameReceipt, frame);
        if (!startedFrameValidated) {
          startedFrameValidated = true;
          reportChannelDiagnostic("terminal_started_frame_validated");
        }
      };
      const reportFrameFailure = () => {
        if (frameFailureReported) return;
        frameFailureReported = true;
        reportChannelDiagnostic("terminal_frame_decode_or_identity_failed");
      };
      setConnection("connecting");
      setError(undefined);
      currentSize = terminalSize(fit);

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
            if (!firstOutputRendered) {
              firstOutputRendered = true;
              outputRenderedRef.current?.();
            }
            const probe = interactiveProbe;
            if (
              probe &&
              probe.serial === serial &&
              probe.attachmentId === frameReceipt.attachmentId &&
              !probe.failed
            ) {
              probe.outputRendered = true;
              try {
                if (!probe.reported) outputAfterInputRenderedRef.current?.();
              } catch {
                // Diagnostics must never alter terminal rendering.
              }
              reportInteractiveIfReady(probe);
            }
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
        if (!firstChannelCallbackReceived) {
          firstChannelCallbackReceived = true;
          reportChannelDiagnostic("terminal_channel_callback_received");
        }
        try {
          const frame = decoder.push(value);
          if (!isTerminalFrame(frame)) return;
          if (frame.type === "started") {
            started = frame;
            if (returnedReceipt) {
              validateStartedFrame(frame, returnedReceipt);
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
              throw new Error("terminal Channel handshake buffer is full");
            }
            bufferedFrames.push(frame);
            if (frame.type === "output") {
              bufferedOutputBytes += frame.bytes.byteLength;
            }
            return;
          }
          processFrame(frame, returnedReceipt);
        } catch (frameError: unknown) {
          reportFrameFailure();
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
        const timeout = new Error("terminal Channel handshake timed out");
        reportChannelDiagnostic(
          returnedReceipt
            ? "terminal_handshake_timeout_after_receipt"
            : "terminal_handshake_timeout_before_receipt",
        );
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
        try {
          returnedReceipt = await clientRef.current.attach(
            {
              schemaVersion: TERMINAL_PROTOCOL_VERSION,
              surfaceKey,
              targetGeneration: 0,
              ...currentSize,
            },
            onFrame,
          );
        } catch (invokeError: unknown) {
          // A rejection here is the only frontend-observable indication that
          // the command response crossed the invoke boundary unsuccessfully.
          // Keep the marker content-free; Rust emits the entered/typed result
          // markers when the command itself was admitted.
          try {
            attachInvokeRejectedRef.current?.();
          } catch {
            // Diagnostics must never alter terminal attach behavior.
          }
          throw invokeError;
        }
        if (disposed || serial !== attachSerial) {
          detachExact(returnedReceipt);
          return;
        }
        if (!started) {
          reportChannelDiagnostic("terminal_receipt_before_started");
        }
        if (!validReceipt(surfaceKey, returnedReceipt)) {
          throw new Error("terminal attachment receipt is invalid");
        }
        receipt = returnedReceipt;
        if (channelFailure) throw channelFailure;
        await startedReady;
        if (started) validateStartedFrame(started, returnedReceipt);
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
          throw new Error("terminal Channel closed during handshake");
        }
        inputQueue = {
          serial,
          attachmentId: returnedReceipt.attachmentId,
          nextSequence: 0,
          tail: Promise.resolve(),
          failed: false,
        };
        setConnection("connected");
        await sendResize(returnedReceipt, currentSize, serial);
      } catch (attachError: unknown) {
        if (handshakeTimer !== undefined) {
          clearTimeout(handshakeTimer);
          handshakeTimer = undefined;
        }
        // The invoke can resolve with a receipt after the Channel already
        // rejected it, or after a replacement/unmount. Always release exactly
        // that returned opaque handle; stale Channels are ignored by serial.
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
      let chunks: readonly (readonly number[])[];
      try {
        chunks = terminalInputChunks(new TextEncoder().encode(data));
      } catch (inputError: unknown) {
        fail(queue.serial, inputError);
        return;
      }
      const gestureEpoch = armedInputGestureEpoch;
      const qualifiedGesture =
        gestureEpoch !== undefined &&
        gestureEpoch !== consumedInputGestureEpoch;
      if (qualifiedGesture) consumedInputGestureEpoch = gestureEpoch;
      for (const [chunkIndex, bytes] of chunks.entries()) {
        if (bytes.length === 0 || queue.failed) continue;
        const qualifiesInteractive =
          qualifiedGesture &&
          chunkIndex === 0 &&
          (!interactiveProbe ||
            interactiveProbe.reported ||
            interactiveProbe.failed);
        const sequence = ++queue.nextSequence;
        const probe = qualifiesInteractive
          ? {
              serial: queue.serial,
              attachmentId: currentReceipt.attachmentId,
              gestureEpoch: gestureEpoch!,
              inputSequence: sequence,
              accepted: false,
              outputRendered: false,
              failed: false,
              reported: false,
            }
          : undefined;
        if (probe) interactiveProbe = probe;
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
            try {
              inputInvokeEnteredRef.current?.();
              await clientRef.current.input({
                schemaVersion: TERMINAL_PROTOCOL_VERSION,
                surfaceKey,
                attachmentId: currentReceipt.attachmentId,
                targetGeneration: currentReceipt.targetGeneration,
                inputSequence: sequence,
                bytes,
              });
            } catch (inputError: unknown) {
              try {
                inputInvokeRejectedRef.current?.();
              } catch {
                // Diagnostics must never alter terminal input behavior.
              }
              throw inputError;
            }
            if (probe) {
              probe.accepted = true;
              reportInteractiveIfReady(probe);
            }
          })
          .catch((inputError: unknown) => {
            if (probe) probe.failed = true;
            fail(queue.serial, inputError);
          });
      }
    });

    const resize = () => {
      currentSize = terminalSize(fit);
      queueResize(currentSize, attachSerial);
    };
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(resize);
      observer.observe(host);
    }
    const focusTerminal = () => terminal.focus();
    host.addEventListener("click", focusTerminal);
    host.addEventListener("keydown", armInputGesture, true);
    void attach();
    terminal.focus();

    controllerRef.current = {
      retry() {
        void attach();
      },
    };

    return () => {
      disposed = true;
      attachSerial += 1;
      if (resizeTimer !== undefined) {
        clearTimeout(resizeTimer);
        resizeTimer = undefined;
      }
      pendingResize = undefined;
      resizeRef.current = null;
      observer?.disconnect();
      host.removeEventListener("click", focusTerminal);
      host.removeEventListener("keydown", armInputGesture, true);
      discardInputGesture();
      dataDisposable.dispose();
      if (receipt && !receiptDetached) detachExact(receipt);
      receipt = undefined;
      inputQueue = undefined;
      terminal.dispose();
      terminalRef.current = null;
      controllerRef.current = null;
    };
    // The surface key is the mount identity, so unrelated snapshot revisions
    // never remount the xterm or reconnect its PTY client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceKey]);

  useEffect(() => {
    // Appearance is a projection, not a surface identity. Update the live
    // xterm options and geometry without tearing down the PTY attachment.
    const terminal = terminalRef.current;
    if (terminal && appearance) {
      terminal.options.fontFamily = terminalFontStack(
        appearance.terminalFontFamily,
      );
      terminal.options.fontSize = appearance.terminalFontSize;
      terminal.options.lineHeight = appearance.terminalLineHeight;
      resizeRef.current?.();
    }
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
      {connection === "connecting" && (
        <div className="surface-state" role="status" aria-live="polite">
          <span className="surface-spinner" aria-hidden="true" />
          <p className="surface-line">Connecting…</p>
        </div>
      )}
      {connection === "disconnected" && (
        <div
          className="surface-state surface-failure"
          role="alert"
          aria-live="polite"
        >
          <p className="failure-title">
            <svg
              className="failure-icon"
              viewBox="0 0 16 16"
              aria-hidden="true"
              focusable="false"
            >
              <circle cx="8" cy="8" r="7" />
              <path d="M8 4.6v4.2M8 11.1v.6" />
            </svg>
            The terminal session is not connected.
          </p>
          <p className="failure-detail">{error ?? DETACHABLE_ERROR}</p>
          <div className="surface-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => controllerRef.current?.retry()}
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
