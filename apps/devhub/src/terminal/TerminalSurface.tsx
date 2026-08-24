import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
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

function terminalTheme(colorScheme: AppAppearance["colorScheme"]) {
  // App Shell v1 currently exposes the light product appearance only. Keep
  // this as an xterm theme projection so adding a native dark scheme later
  // does not require reconnecting the PTY surface.
  if (colorScheme === "light") {
    return {
      background: "#101513",
      foreground: "#f4f4ed",
      cursor: "#c7e6c2",
      selectionBackground: "#3c594a",
    };
  }
  return {
    background: "#101513",
    foreground: "#f4f4ed",
    cursor: "#c7e6c2",
    selectionBackground: "#3c594a",
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
}: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef(client);
  const terminalRef = useRef<Terminal | null>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  const controllerRef = useRef<{ retry: () => void } | null>(null);
  const interactiveRef = useRef(onInteractive);
  const attachInvokeRejectedRef = useRef(onAttachInvokeRejected);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string>();

  clientRef.current = client;
  interactiveRef.current = onInteractive;
  attachInvokeRejectedRef.current = onAttachInvokeRejected;

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

    let terminal: Terminal;
    let fit: FitAddon;
    try {
      terminal = new Terminal({
        cursorBlink: true,
        convertEol: false,
        fontFamily:
          appearance?.terminalFontFamily ?? "SF Mono, Menlo, monospace",
        fontSize: appearance?.terminalFontSize ?? 13,
        lineHeight: appearance?.terminalLineHeight ?? 1.35,
        scrollback: 10_000,
        theme: terminalTheme(appearance?.colorScheme ?? "light"),
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
      await clientRef.current.resize({
        ...request,
        attachmentId: nextReceipt.attachmentId,
      });
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
          if (!isTerminalFrame(frame)) return;
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
        interactiveRef.current?.();
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
      for (const bytes of chunks) {
        if (bytes.length === 0 || queue.failed) continue;
        const sequence = ++queue.nextSequence;
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
      terminal.options.fontFamily = appearance.terminalFontFamily;
      terminal.options.fontSize = appearance.terminalFontSize;
      terminal.options.lineHeight = appearance.terminalLineHeight;
      terminal.options.theme = terminalTheme(appearance.colorScheme);
      resizeRef.current?.();
    }
  }, [appearance]);

  return (
    <div className="terminal-surface-shell">
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
      {connection !== "connected" && (
        <div
          className="terminal-surface-overlay"
          role="status"
          aria-live="polite"
        >
          <span>
            {connection === "connecting"
              ? "Connecting…"
              : (error ?? DETACHABLE_ERROR)}
          </span>
          {connection === "disconnected" && (
            <button
              type="button"
              className="terminal-retry-button"
              onClick={() => controllerRef.current?.retry()}
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
