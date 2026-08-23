import { Channel, invoke } from "@tauri-apps/api/core";
import {
  MAX_INPUT_BYTES,
  TERMINAL_PROTOCOL_VERSION,
} from "./generated-contract";
import type {
  TerminalAckRequest,
  TerminalAttachReceipt,
  TerminalAttachRequest,
  TerminalDetachRequest,
  TerminalInputRequest,
  TerminalResizeRequest,
} from "./generated-contract";

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
} from "./generated-contract";

export const TERMINAL_ATTACH_COMMAND = "terminal_attach" as const;
export const TERMINAL_INPUT_COMMAND = "terminal_input" as const;
export const TERMINAL_RESIZE_COMMAND = "terminal_resize" as const;
export const TERMINAL_ACKNOWLEDGE_COMMAND = "terminal_acknowledge" as const;
export const TERMINAL_DETACH_COMMAND = "terminal_detach" as const;

export interface TerminalChannel {
  onmessage: ((value: unknown) => void) | null;
}

export interface TerminalTransport {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  channel(onMessage: (value: unknown) => void): TerminalChannel;
}

const tauriTransport: TerminalTransport = {
  invoke: <T>(command: string, args: Record<string, unknown>) =>
    invoke<T>(command, args),
  channel(onMessage) {
    const channel = new Channel<unknown>();
    channel.onmessage = onMessage;
    return channel;
  },
};

export interface TerminalClient {
  attach(
    request: TerminalAttachRequest,
    onFrame: (value: unknown) => void,
  ): Promise<TerminalAttachReceipt>;
  input(request: TerminalInputRequest): Promise<void>;
  resize(request: TerminalResizeRequest): Promise<void>;
  acknowledge(request: TerminalAckRequest): Promise<void>;
  detach(request: TerminalDetachRequest): Promise<void>;
}

export function createTerminalClient(
  transport: TerminalTransport = tauriTransport,
): TerminalClient {
  return {
    async attach(request, onFrame) {
      const channel = transport.channel(onFrame);
      return transport.invoke<TerminalAttachReceipt>(TERMINAL_ATTACH_COMMAND, {
        payload: request,
        channel,
      });
    },
    async input(request) {
      await transport.invoke<void>(TERMINAL_INPUT_COMMAND, {
        payload: request,
      });
    },
    async resize(request) {
      await transport.invoke<void>(TERMINAL_RESIZE_COMMAND, {
        payload: request,
      });
    },
    async acknowledge(request) {
      await transport.invoke<void>(TERMINAL_ACKNOWLEDGE_COMMAND, {
        payload: request,
      });
    },
    async detach(request) {
      await transport.invoke<void>(TERMINAL_DETACH_COMMAND, {
        payload: request,
      });
    },
  };
}

export const defaultTerminalClient = createTerminalClient();

export function terminalInputChunks(
  value: Uint8Array,
): readonly (readonly number[])[] {
  const chunks: (readonly number[])[] = [];
  let offset = 0;
  while (offset < value.byteLength) {
    let end = Math.min(value.byteLength, offset + MAX_INPUT_BYTES);
    // xterm emits UTF-8 text. Keep a paste/code point in one request whenever
    // possible; malformed bytes are still forwarded losslessly and are only
    // split at the hard native byte limit.
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

export { TERMINAL_PROTOCOL_VERSION };
