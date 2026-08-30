/** Ported from the Tauri app's `src/agent/client.test.ts`. */

import { describe, expect, it, vi } from "vitest";

import {
  MAX_INPUT_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  encodeFrame,
  type AgentApi,
  type AttachReceipt,
  type TerminalFrame,
} from "../../ipc/agent.js";
import { agentInputChunks, createAgentSurfaceClient } from "./client.js";

const SURFACE_KEY = "agent:00000000-0000-4000-8000-000000000001";
const ATTACHMENT_ID = "0123456789abcdef0123456789abcdef";

function receipt(): AttachReceipt {
  return {
    schemaVersion: TERMINAL_PROTOCOL_VERSION,
    attachmentId: ATTACHMENT_ID,
    surfaceKey: SURFACE_KEY,
    targetGeneration: 1,
  };
}

function fakeApi(): AgentApi & {
  calls: string[];
  emit: (frame: TerminalFrame) => void;
} {
  const calls: string[] = [];
  let listener: ((raw: Uint8Array) => void) | undefined;
  return {
    calls,
    emit(frame) {
      listener?.(encodeFrame(frame));
    },
    async attach() {
      calls.push("attach");
      return receipt();
    },
    async input() {
      calls.push("input");
    },
    async resize() {
      calls.push("resize");
    },
    async acknowledge() {
      calls.push("acknowledge");
    },
    async detach() {
      calls.push("detach");
    },
    onFrame(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
}

describe("the agent surface channel client", () => {
  it("routes only bounded semantic requests through the agent channels", async () => {
    const api = fakeApi();
    const client = createAgentSurfaceClient(api);
    const attached = await client.attach(
      {
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        surfaceKey: SURFACE_KEY,
        targetGeneration: 0,
        cols: 80,
        rows: 24,
        pixelWidth: 0,
        pixelHeight: 0,
      },
      () => undefined,
    );
    const base = {
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      surfaceKey: SURFACE_KEY,
      attachmentId: attached.attachmentId,
      targetGeneration: attached.targetGeneration,
    };
    await client.input({ ...base, inputSequence: 1, bytes: [65] });
    await client.resize({
      ...base,
      cols: 80,
      rows: 24,
      pixelWidth: 0,
      pixelHeight: 0,
    });
    await client.acknowledge({ ...base, sequence: 1 });
    await client.detach(base);
    expect(api.calls).toEqual([
      "attach",
      "input",
      "resize",
      "acknowledge",
      "detach",
    ]);
  });

  it("routes frames to the attachment that asked for them", async () => {
    const api = fakeApi();
    const client = createAgentSurfaceClient(api);
    const seen = vi.fn();
    await client.attach(
      {
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        surfaceKey: SURFACE_KEY,
        targetGeneration: 0,
        cols: 80,
        rows: 24,
        pixelWidth: 0,
        pixelHeight: 0,
      },
      seen,
    );
    api.emit({
      type: "output",
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      attachmentId: ATTACHMENT_ID,
      sequence: 1,
      bytes: Uint8Array.from([0, 0xff, 0x1b]),
    });
    // A frame for somebody else's attachment is dropped, never mis-routed.
    api.emit({
      type: "output",
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      attachmentId: "ffffffffffffffffffffffffffffffff",
      sequence: 1,
      bytes: Uint8Array.from([1]),
    });
    expect(seen).toHaveBeenCalledTimes(1);
    const frame = seen.mock.calls[0][0] as TerminalFrame;
    expect(frame.type).toBe("output");
    if (frame.type === "output") {
      expect([...frame.bytes]).toEqual([0, 0xff, 0x1b]);
    }
  });

  it("chunks input on character boundaries", () => {
    expect(agentInputChunks("abc")).toEqual([[97, 98, 99]]);
    const wide = "あ".repeat(MAX_INPUT_BYTES); // three bytes each
    const chunks = agentInputChunks(wide);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_INPUT_BYTES);
      // A chunk that started mid-character would begin with a continuation byte.
      expect(chunk[0] & 0xc0).not.toBe(0x80);
    }
    expect(Buffer.from(chunks.flat()).toString("utf8")).toBe(wide);
  });
});
