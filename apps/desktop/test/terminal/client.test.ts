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
  TERMINAL_PROTOCOL_VERSION,
  TerminalFailure,
} from "../../src/ipc/terminal";
import {
  createTerminalClient,
  terminalErrorSummary,
  type TerminalTransport,
} from "../../src/shell/terminal/client";

function transportHarness(refuse?: TerminalFailure) {
  const calls: Array<{ method: string; channelId: string; request: unknown }> =
    [];
  const sinks: Array<(value: unknown) => void> = [];
  const answer = <T>(value: T) =>
    refuse
      ? ({ ok: false, error: refuse.toWire() } as const)
      : ({ ok: true, value } as const);
  const record =
    (method: string) =>
    async (channelId: string, request: unknown, onMessage?: unknown) => {
      calls.push({ method, channelId, request });
      if (typeof onMessage === "function") {
        sinks.push(onMessage as (value: unknown) => void);
      }
      return answer(
        method === "attach"
          ? {
              schemaVersion: TERMINAL_PROTOCOL_VERSION,
              attachmentId: "0123456789abcdef0123456789abcdef",
              surfaceKey:
                "workspace-terminal:00000000-0000-4000-8000-00000000005c",
              targetGeneration: 42,
            }
          : undefined,
      );
    };
  const transport = {
    attach: vi.fn(record("attach")),
    control: vi.fn(record("control")),
    detach: vi.fn(record("detach")),
  } as unknown as TerminalTransport;
  return {
    client: createTerminalClient("channel-1", transport),
    calls,
    sinks,
  };
}

describe("terminal client transport", () => {
  it("addresses every request to its own surface and binds attach to one listener", async () => {
    const harness = transportHarness();
    const onMessage = vi.fn();
    const receipt = await harness.client.attach(
      {
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
        targetGeneration: 0,
        cols: 80,
        rows: 24,
        pixelWidth: 0,
        pixelHeight: 0,
      },
      onMessage,
    );
    await harness.client.control({
      surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
      message: { kind: "resize", cols: 100, rows: 40 },
    });
    await harness.client.detach({
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
      attachmentId: receipt.attachmentId,
      targetGeneration: receipt.targetGeneration,
    });

    expect(harness.sinks).toEqual([onMessage]);
    expect(harness.calls.map(({ method }) => method)).toEqual([
      "attach",
      "control",
      "detach",
    ]);
    expect(
      harness.calls.every(({ channelId }) => channelId === "channel-1"),
    ).toBe(true);
    expect(receipt.targetGeneration).toBe(42);
  });

  it("turns a refusal back into a failure that still carries its code", async () => {
    const harness = transportHarness(
      new TerminalFailure("surface_unavailable"),
    );
    await expect(
      harness.client.attach(
        {
          schemaVersion: TERMINAL_PROTOCOL_VERSION,
          surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
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
    const named = "DevHub could not find 'tmux' at /opt/nothing/bin/tmux.";
    const harness = transportHarness(
      new TerminalFailure("runtime_unavailable", { summary: named }),
    );
    await expect(
      harness.client.attach(
        {
          schemaVersion: TERMINAL_PROTOCOL_VERSION,
          surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
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
