import { describe, expect, it, vi } from "vitest";
import {
  AGENT_SURFACE_ACKNOWLEDGE_COMMAND,
  AGENT_SURFACE_ATTACH_COMMAND,
  AGENT_SURFACE_DETACH_COMMAND,
  AGENT_SURFACE_INPUT_COMMAND,
  AGENT_SURFACE_RESIZE_COMMAND,
  createAgentSurfaceClient,
} from "./client";
import type { TerminalTransport } from "../terminal/client";

describe("Agent Surface Channel client", () => {
  it("routes only bounded semantic requests through the native agent commands", async () => {
    const invoke = vi.fn(
      async <T>(command: string, _args: Record<string, unknown>) => {
        void _args;
        if (command === AGENT_SURFACE_ATTACH_COMMAND) {
          return {
            schemaVersion: 1,
            attachmentId: "0123456789abcdef0123456789abcdef",
            surfaceKey: "agent:00000000-0000-4000-8000-000000000001",
            targetGeneration: 1,
          } as T;
        }
        return undefined as T;
      },
    );
    const client = createAgentSurfaceClient({
      invoke: invoke as TerminalTransport["invoke"],
      channel: () => ({ onmessage: null }),
    });
    const request = {
      schemaVersion: 1 as const,
      surfaceKey: "agent:00000000-0000-4000-8000-000000000001",
      targetGeneration: 0 as const,
      cols: 80,
      rows: 24,
      pixelWidth: 0,
      pixelHeight: 0,
    };
    await client.attach(request, () => undefined);
    await client.input({
      schemaVersion: 1,
      surfaceKey: request.surfaceKey,
      attachmentId: "0123456789abcdef0123456789abcdef",
      targetGeneration: 1,
      inputSequence: 1,
      bytes: [65],
    });
    await client.resize({
      schemaVersion: 1,
      surfaceKey: request.surfaceKey,
      attachmentId: "0123456789abcdef0123456789abcdef",
      targetGeneration: 1,
      cols: 80,
      rows: 24,
      pixelWidth: 0,
      pixelHeight: 0,
    });
    await client.acknowledge({
      schemaVersion: 1,
      surfaceKey: request.surfaceKey,
      attachmentId: "0123456789abcdef0123456789abcdef",
      targetGeneration: 1,
      sequence: 1,
    });
    await client.detach({
      schemaVersion: 1,
      surfaceKey: request.surfaceKey,
      attachmentId: "0123456789abcdef0123456789abcdef",
      targetGeneration: 1,
    });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      AGENT_SURFACE_ATTACH_COMMAND,
      AGENT_SURFACE_INPUT_COMMAND,
      AGENT_SURFACE_RESIZE_COMMAND,
      AGENT_SURFACE_ACKNOWLEDGE_COMMAND,
      AGENT_SURFACE_DETACH_COMMAND,
    ]);
  });
});
