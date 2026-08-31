/**
 * The Agent Surface Channel client.
 *
 * Ported from the Tauri app's `src/agent/client.ts`. The transport was a Tauri
 * `invoke` plus a per-attach `Channel`; it is now `window.devhub.agent`, backed
 * by Electron IPC. The shape is unchanged: six bounded semantic requests and
 * one stream of frames.
 *
 * Main pushes every attachment's frames on one channel, so this client routes
 * by attachment id — the id is already in each frame header, and a frame for
 * an attachment nobody is listening to is dropped here rather than mis-routed.
 */

import { devhub } from "../client";
import {
  MAX_INPUT_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  decodeFrame,
  type AckRequest,
  type AgentApi,
  type AttachReceipt,
  type AttachRequest,
  type DetachRequest,
  type InputRequest,
  type ResizeRequest,
  type ScrollRequest,
  type TerminalFrame,
} from "../../ipc/agent.js";

export type AgentFrameListener = (frame: TerminalFrame) => void;

export interface AgentSurfaceClient {
  attach(
    request: AttachRequest,
    onFrame: AgentFrameListener,
  ): Promise<AttachReceipt>;
  input(request: InputRequest): Promise<void>;
  resize(request: ResizeRequest): Promise<void>;
  scroll(request: ScrollRequest): Promise<void>;
  acknowledge(request: AckRequest): Promise<void>;
  detach(request: DetachRequest): Promise<void>;
}

/**
 * Splits a UTF-8 payload into request-sized chunks without ever cutting a
 * multi-byte character in half: main decodes each chunk on its own, so a split
 * code point would reach the agent as replacement bytes.
 */
export function agentInputChunks(text: string): number[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  const chunks: number[][] = [];
  let index = 0;
  while (index < bytes.length) {
    let end = Math.min(index + MAX_INPUT_BYTES, bytes.length);
    while (end > index && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    if (end === index) {
      end = Math.min(index + MAX_INPUT_BYTES, bytes.length);
    }
    chunks.push(bytes.slice(index, end));
    index = end;
  }
  return chunks;
}

export function createAgentSurfaceClient(api: AgentApi): AgentSurfaceClient {
  /** attachmentId → listener. A frame with no listener is dropped. */
  const listeners = new Map<string, AgentFrameListener>();
  /** The listener waiting for its first frame, before its id is known. */
  let pendingListener: AgentFrameListener | undefined;
  let unsubscribe: (() => void) | undefined;

  const ensureSubscribed = (): void => {
    if (unsubscribe !== undefined) {
      return;
    }
    unsubscribe = api.onFrame((raw) => {
      const frame = decodeFrame(raw);
      const listener = listeners.get(frame.attachmentId) ?? pendingListener;
      if (listener === undefined) {
        return;
      }
      if (frame.type === "started") {
        pendingListener = undefined;
        listeners.set(frame.attachmentId, listener);
      }
      listener(frame);
    });
  };

  return {
    async attach(request, onFrame) {
      ensureSubscribed();
      pendingListener = onFrame;
      try {
        const receipt = await api.attach(request);
        listeners.set(receipt.attachmentId, onFrame);
        // The id is known now, so the fallback that existed only for a
        // Started frame racing the receipt is retired: leaving it armed
        // would hand this listener somebody else's frames.
        pendingListener = undefined;
        return receipt;
      } catch (error) {
        pendingListener = undefined;
        throw error;
      }
    },
    async input(request) {
      await api.input(request);
    },
    async resize(request) {
      await api.resize(request);
    },
    async scroll(request) {
      await api.scroll(request);
    },
    async acknowledge(request) {
      await api.acknowledge(request);
    },
    async detach(request) {
      listeners.delete(request.attachmentId);
      await api.detach(request);
    },
  };
}

/**
 * The client the page uses. `window.devhub.agent` is installed by the preload;
 * if it is missing the page is broken, and saying so is the whole job of this
 * throw — a stub client here would hide a wiring failure behind a dead view.
 */
export function defaultAgentSurfaceClient(): AgentSurfaceClient {
  const api = devhub().agent;
  return createAgentSurfaceClient(api);
}

export function agentDetachRequest(
  surfaceKey: string,
  receipt: AttachReceipt,
): DetachRequest {
  return {
    schemaVersion: TERMINAL_PROTOCOL_VERSION,
    surfaceKey,
    attachmentId: receipt.attachmentId,
    targetGeneration: receipt.targetGeneration,
  };
}
