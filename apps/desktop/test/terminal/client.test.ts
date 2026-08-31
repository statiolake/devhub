/**
 * The page's terminal client.
 *
 * Ported from the Tauri app's `src/terminal/client.test.ts`. The Tauri Channel
 * is the preload's channel id here, so what the transport test asserts is that
 * every request carries the same one and that a refusal becomes a throw with
 * the wire code intact.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MAX_INPUT_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  TerminalFailure,
} from "../../src/ipc/terminal";
import {
  createTerminalClient,
  terminalErrorSummary,
  terminalInputChunks,
  type TerminalTransport,
} from "../../src/shell/terminal/client";

function transportHarness(refuse?: TerminalFailure) {
  const calls: Array<{ method: string; channelId: string; request: unknown }> =
    [];
  const frameSinks: Array<(value: unknown) => void> = [];
  const answer = <T>(value: T) =>
    refuse
      ? ({ ok: false, error: refuse.toWire() } as const)
      : ({ ok: true, value } as const);
  const record =
    (method: string) =>
    async (channelId: string, request: unknown, onFrame?: unknown) => {
      calls.push({ method, channelId, request });
      if (typeof onFrame === "function") {
        frameSinks.push(onFrame as (value: unknown) => void);
      }
      return answer(
        method === "attach"
          ? {
              schemaVersion: TERMINAL_PROTOCOL_VERSION,
              attachmentId: "0123456789abcdef0123456789abcdef",
              surfaceKey: "global-terminal",
              targetGeneration: 42,
            }
          : undefined,
      );
    };
  const transport = {
    attach: vi.fn(record("attach")),
    input: vi.fn(record("input")),
    resize: vi.fn(record("resize")),
    acknowledge: vi.fn(record("acknowledge")),
    detach: vi.fn(record("detach")),
  } as unknown as TerminalTransport;
  return {
    client: createTerminalClient("channel-1", transport),
    calls,
    frameSinks,
  };
}

describe("terminal client transport", () => {
  it("addresses every request to its own surface and binds attach to one frame sink", async () => {
    const harness = transportHarness();
    const onFrame = vi.fn();
    const receipt = await harness.client.attach(
      {
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        surfaceKey: "global-terminal",
        targetGeneration: 0,
        cols: 80,
        rows: 24,
        pixelWidth: 0,
        pixelHeight: 0,
      },
      onFrame,
    );
    await harness.client.input({
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      surfaceKey: "global-terminal",
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
      inputSequence: 1,
      bytes: [0xe3, 0x81, 0x82],
    });
    await harness.client.resize({
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      surfaceKey: "global-terminal",
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
      cols: 100,
      rows: 40,
      pixelWidth: 0,
      pixelHeight: 0,
    });
    await harness.client.acknowledge({
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      surfaceKey: "global-terminal",
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
      sequence: 1,
    });
    await harness.client.detach({
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      surfaceKey: "global-terminal",
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
    });

    expect(harness.frameSinks).toEqual([onFrame]);
    expect(harness.calls.map(({ method }) => method)).toEqual([
      "attach",
      "input",
      "resize",
      "acknowledge",
      "detach",
    ]);
    expect(
      harness.calls.every(({ channelId }) => channelId === "channel-1"),
    ).toBe(true);
    expect(receipt.targetGeneration).toBe(42);
  });

  it("turns a refusal back into a failure that still carries its code", async () => {
    const harness = transportHarness(new TerminalFailure("surface_unavailable"));
    await expect(
      harness.client.attach(
        {
          schemaVersion: TERMINAL_PROTOCOL_VERSION,
          surfaceKey: "global-terminal",
          targetGeneration: 0,
          cols: 80,
          rows: 24,
          pixelWidth: 0,
          pixelHeight: 0,
        },
        vi.fn(),
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "surface_unavailable",
      }) as unknown as Error,
    );
  });

  it("chunks raw UTF-8 bytes without splitting or reordering Unicode", () => {
    const prefix = new TextEncoder().encode("日本語💻");
    const input = new Uint8Array(MAX_INPUT_BYTES + prefix.byteLength + 1);
    input.set(prefix, MAX_INPUT_BYTES - prefix.byteLength);
    input[input.byteLength - 1] = 0xff;
    const chunks = terminalInputChunks(input);
    expect(chunks.every((chunk) => chunk.length <= MAX_INPUT_BYTES)).toBe(true);
    expect(Uint8Array.from(chunks.flat())).toEqual(input);
  });

  it("shows the words the main process chose, not the code again", () => {
    // The contract's own summary for a code that has one...
    expect(terminalErrorSummary(new TerminalFailure("stale_target"))).toBe(
      "The terminal target is stale.",
    );
    // ...and, where the main process said something the code cannot, that.
    // Re-deriving here produced "Terminal unavailable (runtime unavailable)",
    // which named neither the missing program nor where DevHub looked for it.
    const named =
      "DevHub could not find 'tmux' on PATH (looked in: /usr/bin, /bin).";
    expect(
      terminalErrorSummary(
        new TerminalFailure("runtime_unavailable", { summary: named }),
      ),
    ).toBe(named);
    expect(terminalErrorSummary(new Error("boom"))).toBe(
      "The terminal connection is unavailable.",
    );
  });

  it("carries the wire's summary into the failure it throws", async () => {
    const named = "DevHub could not find 'herdr' at /opt/nothing/bin/herdr.";
    const harness = transportHarness(
      new TerminalFailure("runtime_unavailable", { summary: named }),
    );
    await expect(
      harness.client.attach(
        {
          schemaVersion: TERMINAL_PROTOCOL_VERSION,
          surfaceKey: "global-terminal",
          targetGeneration: 0,
          cols: 80,
          rows: 24,
          pixelWidth: 0,
          pixelHeight: 0,
        },
        vi.fn(),
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "runtime_unavailable",
        summary: named,
      }) as unknown as Error,
    );
  });
});
