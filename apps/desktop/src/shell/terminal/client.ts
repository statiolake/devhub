/**
 * The page's terminal client.
 *
 * One client is bound to one mounted surface, by the channel id it allocates:
 * every request it sends and every frame it receives belong to that surface and
 * no other. This is where a refusal from the main process — a value on the
 * wire, so the contract's error code survives the bridge — becomes a thrown
 * `TerminalFailure`, and it is the only place that conversion happens.
 *
 * Ported from the Tauri app's `src/terminal/client.ts`; the Tauri `Channel` and
 * `invoke` are the Electron preload's channel id and `ipcRenderer.invoke`.
 */

import { devhub } from "../client";
import {
  MAX_INPUT_BYTES,
  TerminalFailure,
  type DevhubTerminalApi,
  type TerminalAckRequest,
  type TerminalAttachReceipt,
  type TerminalAttachRequest,
  type TerminalDetachRequest,
  type TerminalInputRequest,
  type TerminalResizeRequest,
  type TerminalResult,
} from "../../ipc/terminal";

export type {
  TerminalAckRequest,
  TerminalAttachReceipt,
  TerminalAttachRequest,
  TerminalDetachRequest,
  TerminalInputRequest,
  TerminalReceipt,
  TerminalResizeRequest,
  TerminalSize,
  TerminalFrame,
} from "../../ipc/terminal";

/** The transport is exactly what the preload exposes; tests supply a fake. */
export type TerminalTransport = DevhubTerminalApi;

export interface TerminalClient {
  readonly channelId: string;
  attach(
    request: TerminalAttachRequest,
    onFrame: (value: unknown) => void,
  ): Promise<TerminalAttachReceipt>;
  input(request: TerminalInputRequest): Promise<void>;
  resize(request: TerminalResizeRequest): Promise<void>;
  acknowledge(request: TerminalAckRequest): Promise<void>;
  detach(request: TerminalDetachRequest): Promise<void>;
}

/**
 * The bridge the preload installed. Its absence means the page was loaded
 * without its preload, which is not a state a terminal can work around.
 */
export function devhubTerminal(): TerminalTransport {
  return devhub().terminal;
}

function unwrap<T>(result: TerminalResult<T>): T {
  if (result.ok) return result.value;
  throw new TerminalFailure(result.error.code);
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
    async attach(request, onFrame) {
      return unwrap(await transport.attach(channelId, request, onFrame));
    },
    async input(request) {
      unwrap(await transport.input(channelId, request));
    },
    async resize(request) {
      unwrap(await transport.resize(channelId, request));
    },
    async acknowledge(request) {
      unwrap(await transport.acknowledge(channelId, request));
    },
    async detach(request) {
      unwrap(await transport.detach(channelId, request));
    },
  };
}

export function terminalInputChunks(
  value: Uint8Array,
): readonly (readonly number[])[] {
  const chunks: (readonly number[])[] = [];
  let offset = 0;
  while (offset < value.byteLength) {
    let end = Math.min(value.byteLength, offset + MAX_INPUT_BYTES);
    // xterm emits UTF-8 text. Keep a paste/code point in one request whenever
    // possible; malformed bytes are still forwarded losslessly and are only
    // split at the hard byte limit the main process enforces.
    if (end < value.byteLength) {
      while (end > offset && (value[end] & 0xc0) === 0x80) {
        end -= 1;
      }
      if (end === offset) {
        end = Math.min(value.byteLength, offset + MAX_INPUT_BYTES);
      }
    }
    chunks.push(Array.from(value.subarray(offset, end)));
    offset = end;
  }
  return chunks;
}

export function terminalErrorSummary(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return `Terminal unavailable (${error.code.replaceAll("_", " ")}).`;
  }
  return "The terminal connection is unavailable.";
}
