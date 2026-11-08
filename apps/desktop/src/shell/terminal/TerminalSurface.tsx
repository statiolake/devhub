import { useEffect, useMemo, useRef, useState } from "react";
import "./terminal.css";
import { useColorScheme } from "../appearance";
import { Failure, Waiting } from "../components/shell/SurfaceState";
import { openXtermSession, type XtermSession } from "../surfaces/xtermSession";
import { ControlTerminalSurface } from "./control/ControlTerminalSurface";
import { perfProbe } from "../perfProbe";
import type { TerminalPanesWire } from "../../ipc/contract";
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
  TerminalFailure,
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
   *
   * A surface that has *never* been on screen has neither yet: its emulator
   * is made and its client attached the first time it is shown. An Agent
   * started in the background used to build an xterm and a WebGL context and
   * take its TUI's whole start-up redraw on this page's thread at once —
   * while the person was typing into the Agent beside it — for a screen
   * nobody was looking at. tmux keeps that screen, and the attach that comes
   * with the first show draws it as it is then.
   *
   * A surface that has been on screen and is hidden again keeps its client
   * attached and acknowledges every frame as it arrives, so tmux is never held
   * back, but does not hand the frames to xterm: parsing a stream nobody sees
   * was most of this page's thread with four Agents streaming
   * (docs/process-model.md, phase 6). Coming back draws what was missed —
   * the frames themselves while they are few (`HIDDEN_TAIL_BYTES`), else an
   * attach of a new client, which tmux draws from scratch. Once there is
   * more than that, the client it has is no use to it, and it lets it go
   * there and then: tmux stops drawing for it, the pty host stops reading
   * it, and this page stops receiving and acknowledging its frames (phase
   * 6d). The program in the pane is not held back by it either way; tmux
   * keeps its screen and history for the client attached on reveal.
   */
  readonly hidden?: boolean;
  /**
   * In tmux control mode, where the panes are drawn and what each is, as
   * it changes; `null` when this surface goes. What a Neovim DevHub draws
   * over a pane is placed by (`PaneBridge.reportTerminalPanes`).
   */
  readonly onControlPanes?: (panes: TerminalPanesWire | null) => void;
  /**
   * A session that ended (its last window closed, a detach) is attached
   * again at once — made again — instead of the pane saying it
   * disconnected: a Workspace's terminal is a place, not a process. Every
   * time it ends, however soon after the last: the pane is said to be
   * disconnected only when a session made again ends by itself straight
   * away (`REATTACH_ON_EXIT_MS`), which is a shell that cannot start.
   */
  readonly reattachOnExit?: boolean;
}

/**
 * How long a session made again on exit has to have been connected before its
 * own end is attached again without the person having typed into it.
 *
 * A session the person typed into ended because of what they typed — `exit`,
 * `:q` — however fast, and is made again every time. One that ends sooner
 * than this with nothing typed, right after it was made again, is a shell
 * that cannot start, and attaching it again would loop. This used to be a
 * clock between any two reattaches, which said "not connected" to a person
 * who typed `exit` twice within it.
 */
const REATTACH_ON_EXIT_MS = 3_000;

type ConnectionState = "connecting" | "connected" | "disconnected";

const DETACHABLE_ERROR = "The terminal connection is unavailable.";
/**
 * How long the handshake may go without a word from main.
 *
 * It bounds *silence*, not the handshake: main answers an attach by resolving
 * the request and then sending frames, and every one of those is a sign of
 * life that starts this clock again. Attaching is not a fixed amount of work —
 * it brings the tmux server up, resolves the session and spawns the client,
 * and on a cold start with several Agents mounted at once that is legitimately
 * slower than any number written here. A fixed budget turned that into a pane
 * saying the session was not connected, cured by pressing Retry once the
 * machine was quiet, which is the signature of a load problem being reported
 * as a failure.
 *
 * A main that genuinely stops answering still lands here, in the same time it
 * always did, and says so.
 */
const HANDSHAKE_SILENCE_MS = 5_000;
const MAX_HANDSHAKE_BUFFER_FRAMES = 8;
/**
 * How long after its pty host ended a surface attaches again. The tmux
 * session is intact (tmux owns the shell), so the next attach finds it; the
 * pause lets the detach of the lost client be answered first.
 */
const HOST_RESTART_REATTACH_MS = 250;
const MAX_HANDSHAKE_BUFFER_BYTES = 256 * 1024;
/**
 * How much of what a hidden surface was sent it keeps, to draw when it is
 * shown again.
 *
 * Under this, coming back writes the frames it missed, in order, which is the
 * exact stream and costs one parse of at most this much (a few ms). Over it,
 * the client is let go, and coming back attaches a new one instead: tmux
 * starts that client's terminal from nothing — the modes, the cursor, the
 * whole screen — so nothing that was skipped can be missing from it, and the
 * cost is one screen however much was missed. The bytes a busy TUI sends
 * while it sits in the background for a while, or one screen of a stream,
 * fit; a build log does not.
 */
const HIDDEN_TAIL_BYTES = 128 * 1024;

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

/**
 * A terminal surface: in tmux control mode, DevHub's own panes
 * (`control/ControlTerminalSurface.tsx`, `[terminal] tmux_control_mode`);
 * otherwise one xterm.js on one tmux client. Keyed by which, so a change of
 * the setting mounts the other one rather than reusing this one's state.
 */
export function TerminalSurface(props: TerminalSurfaceProps) {
  return props.appearance?.terminalTmuxControlMode === true ? (
    <ControlTerminalSurface key="control" {...props} />
  ) : (
    <XtermTerminalSurface key="xterm" {...props} />
  );
}

function XtermTerminalSurface({
  surfaceKey,
  surfaceLabel,
  appearance,
  client,
  hideTitle = false,
  hidden = false,
  reattachOnExit = false,
}: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // One client per mounted surface: its channel id is what makes a frame this
  // surface's frame and not another's.
  const boundClient = useMemo(() => client ?? createTerminalClient(), [client]);
  const clientRef = useRef(boundClient);
  const sessionRef = useRef<XtermSession | null>(null);
  const controllerRef = useRef<{
    retry: () => void;
    /** Off screen: frames are acknowledged and not drawn. */
    park: () => void;
    /** On screen again: draw what was missed. */
    reveal: () => void;
  } | null>(null);
  const hiddenRef = useRef(hidden);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  // Connecting again because the pty host the client was in ended, not for
  // the first time: the spinner says so.
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string>();
  const connectionRef = useRef(connection);
  // Once true, stays true: see `hidden`.
  const [shown, setShown] = useState(!hidden);
  if (!hidden && !shown) setShown(true);

  const reattachRef = useRef(reattachOnExit);
  reattachRef.current = reattachOnExit;
  clientRef.current = boundClient;
  hiddenRef.current = hidden;
  connectionRef.current = connection;

  // The palette follows the page's scheme rather than a saved choice, so it
  // changes without the snapshot changing. Both schemes are already here, and
  // the scheme is the document's one answer — the viewport picks the ground
  // around this pane from the same palette, and the two have to match.
  const scheme = useColorScheme();

  const palette = activePalette(appearance, scheme === "dark");
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  // The scheme is a dependency in its own right: with no configured theme the
  // palette stays undefined while the colours the pane is painted still move,
  // and the emulator has to be told, or it goes on naming the old ground to
  // anything that asks with OSC 11.
  useEffect(() => {
    sessionRef.current?.applyTheme(palette);
  }, [palette, scheme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !shown) return undefined;
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
          /** When this client was connected, for `REATTACH_ON_EXIT_MS`. */
          readonly connectedAt: number;
          /**
           * The person typed into this client: a key or a paste, not
           * `onData`, which also carries the terminal's own replies to what
           * tmux asks it on every attach.
           */
          typed: boolean;
        }
      | undefined;
    /**
     * The client there is was attached because the one before it ended
     * (`reattachOnExit`). Its own end is attached again only once it was
     * typed into or connected for `REATTACH_ON_EXIT_MS`. Any other attach —
     * Retry, a reveal — clears it: that is the person asking.
     */
    let reattachedOnExit = false;
    /**
     * Off screen since the last `reveal`. Its own flag rather than
     * `hiddenRef`, which a render changes before the effect that reveals the
     * surface runs: a frame in between would be drawn ahead of the ones it
     * follows.
     */
    let parked = hiddenRef.current;
    /** What arrived while parked, in order, while it is under the bound. */
    let missed: Uint8Array[] = [];
    let missedBytes = 0;
    /** More arrived while parked than `missed` keeps. */
    let missedTooMuch = false;
    /**
     * Keys typed while a reveal, a Retry or a reattach on exit attaches a new
     * client: the pane is on screen and the person is at it, so they are
     * theirs, and they go to the new client once it is there. `undefined`
     * outside such an attach.
     */
    let heldInput: string[] | undefined;
    /** A key or a paste while the client being attached was not there yet. */
    let typedWhileAttaching = false;
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
      // Not caught: a detach that fails leaves an attachment open in main,
      // and a person whose terminals stop attaching needs the first one to
      // have said so. It goes to the root like any other unhandled rejection.
      void clientRef.current.detach(detachRequest(surfaceKey, targetReceipt));
    };

    let reattachingFor: number | undefined;
    const fail = (serial: number, failure: unknown) => {
      if (disposed || serial !== attachSerial) return;
      if (inputQueue?.serial === serial) inputQueue.failed = true;
      if (receipt && !receiptDetached) detachExact(receipt);
      // The pty host that ran this client ended. The session is tmux's and
      // still there, so this is not a failure to show: the surface says it
      // is reconnecting and attaches again, once per client lost. A host
      // that keeps ending is given up on by main, and the next attach is
      // then a client in main.
      if (
        failure instanceof TerminalFailure &&
        failure.code === "host_restarted"
      ) {
        if (reattachingFor === serial) return;
        reattachingFor = serial;
        setConnection("connecting");
        setReconnecting(true);
        setError(undefined);
        setTimeout(() => {
          if (!disposed && serial === attachSerial) void attach();
        }, HOST_RESTART_REATTACH_MS);
        return;
      }
      setReconnecting(false);
      setConnection("disconnected");
      setError(terminalErrorSummary(failure));
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

    /**
     * Attach a client, in place of the one there is.
     *
     * `quiet` is a reveal's: the pane is on screen showing what it last drew,
     * so it says nothing about connecting — the new client's first frame
     * replaces that screen — and keys typed meanwhile wait for the client.
     * `onExit` is a reattach because the session ended (`reattachOnExit`).
     * `hold` keeps the keys typed meanwhile for the client, as `quiet` does:
     * the person is at the pane, a Retry or an `exit` ago.
     */
    const attach = async ({
      quiet = false,
      onExit = false,
      hold = false,
    }: { quiet?: boolean; onExit?: boolean; hold?: boolean } = {}) => {
      const serial = ++attachSerial;
      reattachedOnExit = onExit;
      typedWhileAttaching = false;
      // A new client's terminal is drawn by tmux from nothing, so whatever an
      // earlier one sent while parked is moot.
      missed = [];
      missedBytes = 0;
      missedTooMuch = false;
      heldInput = quiet || hold ? [] : undefined;
      const previousReceipt = receipt;
      if (previousReceipt && !receiptDetached) detachExact(previousReceipt);
      receipt = undefined;
      receiptDetached = false;
      inputQueue = undefined;
      const decoder = new TerminalFrameDecoder((id) =>
        detachedAttachmentIds.has(id),
      );
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
      const clearHandshakeWatchdog = () => {
        if (handshakeTimer === undefined) return;
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
      };

      /**
       * Start the silence watchdog, or start it again.
       *
       * Called once when the attach is made and again on every sign of life
       * from main, so the pane stays in `connecting` — a spinner, not a
       * failure — for as long as the other side is still talking.
       */
      const armHandshakeWatchdog = () => {
        clearHandshakeWatchdog();
        handshakeTimer = setTimeout(() => {
          const timeout = new Error("terminal handshake timed out");
          handshakeTimer = undefined;
          channelFailed = true;
          channelFailure = timeout;
          rejectStarted(timeout);
          if (returnedReceipt) {
            fail(serial, timeout);
          } else if (!disposed && serial === attachSerial) {
            setConnection("disconnected");
            setError(terminalErrorSummary(timeout));
          }
        }, HANDSHAKE_SILENCE_MS);
      };

      if (!quiet) setConnection("connecting");
      setError(undefined);
      session.remeasure();

      const processFrame = (
        frame: TerminalFrame,
        frameReceipt: TerminalReceipt,
      ) => {
        if (frame.attachmentId !== frameReceipt.attachmentId) {
          throw new Error("terminal frame attachment identity changed");
        }
        // A client this surface let go of (one parked with more than it
        // keeps): what it still sends, its end included, is not news.
        if (detachedAttachmentIds.has(frame.attachmentId)) return;
        if (frame.type === "output") {
          if (parked) {
            // Acknowledged now, not drawn: tmux is not held back by a view
            // nobody is looking at. Kept to draw on reveal while it is small.
            if (missedBytes + frame.bytes.byteLength > HIDDEN_TAIL_BYTES) {
              // Too much to draw from: the reveal attaches a new client, so
              // this one is let go now rather than read for nothing until
              // then. What it still has on the way is passed over.
              missedTooMuch = true;
              missed = [];
              missedBytes = 0;
              detachExact(frameReceipt);
              return;
            }
            missed.push(frame.bytes);
            missedBytes += frame.bytes.byteLength;
            void clientRef.current
              .acknowledge({
                schemaVersion: TERMINAL_PROTOCOL_VERSION,
                surfaceKey,
                attachmentId: frame.attachmentId,
                targetGeneration: frameReceipt.targetGeneration,
                sequence: frame.sequence,
              })
              .catch((ackError: unknown) => fail(serial, ackError));
            return;
          }
          terminal.write(frame.bytes, () => {
            perfProbe("terminal-output", { surfaceKey, bytes: frame.bytes });
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
          throw new TerminalFailure(frame.error.code, {
            summary: frame.error.summary,
          });
        } else if (frame.type === "exited") {
          const ended =
            inputQueue?.attachmentId === frameReceipt.attachmentId
              ? inputQueue
              : undefined;
          const lived =
            ended !== undefined &&
            (ended.typed ||
              Date.now() - ended.connectedAt >= REATTACH_ON_EXIT_MS);
          if (reattachRef.current && (!reattachedOnExit || lived)) {
            detachExact(frameReceipt);
            setConnection("connecting");
            queueMicrotask(() => {
              if (disposed || serial !== attachSerial) return;
              void attach({ onExit: true, hold: true });
            });
            return;
          }
          setConnection("disconnected");
          setError("The terminal session disconnected. Retry to reconnect.");
          detachExact(frameReceipt);
        }
      };

      const onFrame = (value: unknown) => {
        if (disposed || serial !== attachSerial || channelFailed) return;
        // A frame is main talking, whatever it says. The watchdog is looking
        // for silence, so anything at all on this channel starts it again.
        if (handshakeTimer !== undefined) armHandshakeWatchdog();
        try {
          const frame = decoder.push(value);
          if (frame === undefined) return;
          if (frame.type === "started") {
            started = frame;
            if (returnedReceipt) {
              validateStarted(surfaceKey, returnedReceipt, frame);
            }
            if (returnedReceipt && validReceipt(surfaceKey, returnedReceipt)) {
              clearHandshakeWatchdog();
            }
            resolveStarted();
            return;
          }
          if (!returnedReceipt) {
            if (frame.type === "error") {
              throw new TerminalFailure(frame.error.code, {
                summary: frame.error.summary,
              });
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
          if (returnedReceipt) clearHandshakeWatchdog();
          rejectStarted(frameError);
          if (returnedReceipt) fail(serial, frameError);
        }
      };

      armHandshakeWatchdog();

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
        // Main answered. Whatever the attach cost, it was not silence, so
        // the wait for the `started` frame gets the full budget of its own.
        if (handshakeTimer !== undefined) armHandshakeWatchdog();
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
        clearHandshakeWatchdog();
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
          connectedAt: Date.now(),
          typed: typedWhileAttaching,
        };
        const held = heldInput ?? [];
        heldInput = undefined;
        for (const data of held) sendInput(data);
        setConnection("connected");
        setReconnecting(false);
        focusIfUnclaimed();
        await sendResize(returnedReceipt, session.geometry, serial);
      } catch (attachError: unknown) {
        clearHandshakeWatchdog();
        // The request can resolve with a receipt after the frames already
        // rejected it, or after a replacement/unmount. Always release exactly
        // that returned opaque handle; stale channels are ignored by serial.
        if (returnedReceipt) detachExact(returnedReceipt);
        if (serial === attachSerial) heldInput = undefined;
        fail(serial, attachError);
      }
    };

    const sendInput = (data: string) => {
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
    };

    const dataDisposable = terminal.onData((data) => {
      if (heldInput !== undefined) {
        heldInput.push(data);
        return;
      }
      sendInput(data);
    });

    const focusTerminal = () => terminal.focus();
    /**
     * A client just connected: the keys go to the terminal again, when it is
     * on screen and nothing outside it has them. What had them inside it was
     * Retry — Return on it or a click — or the pane's own textarea; the
     * button goes with the failure it was on, and the keys went with it to
     * `body`, where typing reached nothing and only a click brought them
     * back. In a view that does not have the keyboard this only places the
     * caret, for when it does.
     */
    function focusIfUnclaimed() {
      if (hiddenRef.current) return;
      const active = document.activeElement;
      const shell = host?.parentElement;
      if (
        active === null ||
        active === document.body ||
        (shell?.contains(active) ?? false)
      ) {
        terminal.focus();
      }
    }
    host.addEventListener("click", focusTerminal);
    // Capture: xterm stops the keys it handles at its textarea.
    const markTyped = () => {
      if (inputQueue) inputQueue.typed = true;
      else typedWhileAttaching = true;
    };
    host.addEventListener("keydown", markTyped, true);
    host.addEventListener("paste", markTyped, true);
    void attach();
    if (!hiddenRef.current) terminal.focus();

    controllerRef.current = {
      retry() {
        void attach({ hold: true });
      },
      park() {
        parked = true;
      },
      reveal() {
        if (!parked) return;
        parked = false;
        // A pane that is disconnected is retried by the caller, and that
        // attach draws everything.
        if (connectionRef.current === "disconnected") return;
        if (missedTooMuch) {
          terminal.clearSelection();
          void attach({ quiet: true });
          return;
        }
        for (const bytes of missed) {
          terminal.write(bytes, () => {
            perfProbe("terminal-output", { surfaceKey, bytes });
          });
        }
        missed = [];
        missedBytes = 0;
      },
    };

    return () => {
      disposed = true;
      attachSerial += 1;
      host.removeEventListener("click", focusTerminal);
      host.removeEventListener("keydown", markTyped, true);
      host.removeEventListener("paste", markTyped, true);
      dataDisposable.dispose();
      if (receipt && !receiptDetached) detachExact(receipt);
      receipt = undefined;
      inputQueue = undefined;
      session.dispose();
      sessionRef.current = null;
      controllerRef.current = null;
    };
    // The surface key is the mount identity, so unrelated snapshot revisions
    // never remount the xterm or reconnect its PTY client. `shown` changes
    // once, from false to true, the first time a pooled surface comes on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceKey, shown]);

  useEffect(() => {
    if (hidden) {
      controllerRef.current?.park();
      return;
    }
    // What arrived while it was off screen, drawn before anything newer.
    controllerRef.current?.reveal();
    // Coming back on screen is the first moment the host has a real box, so
    // the size the pane missed while it was pooled is sent now.
    sessionRef.current?.remeasure();
    // Selecting a surface is a request to type into it, whether it is being
    // attached for the first time or coming back out of the pool.
    sessionRef.current?.focus();
    // …and a request to use it, so a pane that is disconnected when it comes
    // on screen reconnects on its own, exactly once. The rule is tied to the
    // transition and to nothing else: one activation, one try. If that try
    // fails the pane says so exactly as it did — the error, and Retry — and
    // nothing tries again until the person does, or until the pane is shown
    // again. No timer, no count to reset: a connect that succeeds has nothing
    // left to retry, and the next activation is a new request. A pane mounted
    // on screen needs none of this; its mount's own attach is that try.
    if (connectionRef.current === "disconnected") {
      controllerRef.current?.retry();
    }
  }, [hidden]);

  useEffect(() => {
    // Appearance is a projection, not a surface identity. Update the live
    // xterm options and geometry without tearing down the PTY attachment.
    sessionRef.current?.applyAppearance(appearance);
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
        <Waiting label={reconnecting ? "Reconnecting…" : "Connecting…"} />
      )}
      {connection === "disconnected" && (
        <Failure
          summary="The terminal session is not connected."
          detail={error ?? DETACHABLE_ERROR}
          actions={[
            {
              label: "Retry",
              primary: true,
              run: () => {
                controllerRef.current?.retry();
                // The keys leave the button now, not once the client is
                // there: what is typed straight after goes to the terminal.
                sessionRef.current?.focus();
              },
            },
          ]}
        />
      )}
    </div>
  );
}
