/**
 * The page's terminal client.
 *
 * One client is bound to one mounted surface, by the channel id it allocates:
 * every request it sends and every message it receives belong to that surface and
 * no other. This is where a refusal from the main process — a value on the
 * wire, so the contract's error code survives the bridge — becomes a thrown
 * `TerminalFailure`, and it is the only place that conversion happens.
 *
 * Ported from the Tauri app's `src/terminal/client.ts`; the Tauri `Channel` and
 * `invoke` are the Electron preload's channel id and `ipcRenderer.invoke`.
 */

import { surfaceBridge } from "./surfaceBridge";
import {
  TerminalFailure,
  type DevhubTerminalApi,
  type TerminalAttachReceipt,
  type TerminalAttachRequest,
  type TerminalDetachRequest,
  type TerminalResult,
} from "../../ipc/terminal";
import type { ControlRequest } from "../../ipc/terminalControl";

export type {
  TerminalAttachReceipt,
  TerminalAttachRequest,
  TerminalDetachRequest,
  TerminalReceipt,
  TerminalSize,
} from "../../ipc/terminal";

/** The transport is exactly what the preload exposes; tests supply a fake. */
export type TerminalTransport = DevhubTerminalApi;

export interface TerminalClient {
  readonly channelId: string;
  /** `onMessage`: the control client's news (`ControlToPage`), in order. */
  attach(
    request: TerminalAttachRequest,
    onMessage: (value: unknown) => void,
  ): Promise<TerminalAttachReceipt>;
  detach(request: TerminalDetachRequest): Promise<void>;
  /** A request to the control client (`control/`). */
  control(request: ControlRequest): Promise<void>;
  /** "Restart Terminals": the pty host started afresh, every terminal attached again. */
  restart(): Promise<void>;
  /** The terminals were restarted, from this page or any other; the unsubscribe. */
  onRevived(listener: () => void): () => void;
}

/**
 * The bridge the preload installed. Its absence means the page was loaded
 * without its preload, which is not a state a terminal can work around.
 */
export function devhubTerminal(): TerminalTransport {
  return surfaceBridge().terminal;
}

function unwrap<T>(result: TerminalResult<T>): T {
  if (result.ok) return result.value;
  // The summary comes back from the wire rather than being looked up again
  // from the code: the main process may have said something the code cannot,
  // and a second derivation here is how that sentence gets thrown away.
  throw new TerminalFailure(result.error.code, {
    summary: result.error.summary,
  });
}

/** A fresh identity for one mounted surface. */
export function newTerminalChannelId(): string {
  return crypto.randomUUID();
}

export function createTerminalClient(
  channelId: string = newTerminalChannelId(),
  transport: TerminalTransport = devhubTerminal(),
): TerminalClient {
  return {
    channelId,
    async attach(request, onMessage) {
      return unwrap(await transport.attach(channelId, request, onMessage));
    },
    async detach(request) {
      unwrap(await transport.detach(channelId, request));
    },
    async control(request) {
      unwrap(await transport.control(channelId, request));
    },
    restart: () => transport.restart(),
    onRevived: (listener) => transport.onRevived(listener),
  };
}

/**
 * Whether a failed attach is to be made again by itself: one refused as
 * stale (`stale_target`: a newer attach for the same terminal, the page's
 * own clients released as it loaded, a provider operation cancelled under
 * it) while its surface still wants a client is no reason to stop and ask
 * for a Retry — the terminal is there. A few times, then the error stands.
 */
export function retriesAttach(error: unknown, attempts: number): boolean {
  return (
    error instanceof TerminalFailure &&
    error.code === "stale_target" &&
    attempts < STALE_RETRIES
  );
}

export const STALE_RETRIES = 3;

/**
 * The sentence a caught terminal failure is drawn as.
 *
 * A `TerminalFailure` already carries the words the main process chose — the
 * contract's stock summary for its code, or the named one it composed for a
 * missing executable. Rendering its code instead produced "Terminal
 * unavailable (runtime unavailable)", which says the same nothing twice.
 */
export function terminalErrorSummary(error: unknown): string {
  if (error instanceof TerminalFailure) return error.summary;
  return "The terminal connection is unavailable.";
}
