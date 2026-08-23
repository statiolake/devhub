import { describe, expect, it, vi } from "vitest";
import { MAX_INPUT_BYTES, TERMINAL_PROTOCOL_VERSION } from "./generated";
import {
  createTerminalClient,
  terminalInputChunks,
  type TerminalChannel,
  type TerminalTransport,
} from "./client";

function transportHarness() {
  const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
  const channels: TerminalChannel[] = [];
  const invoke = async <T>(
    command: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    invokes.push({ command, args });
    return {
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      attachmentId: "0123456789abcdef0123456789abcdef",
      surfaceKey: "global-terminal",
      targetGeneration: 42,
    } as T;
  };
  const transport: TerminalTransport = {
    invoke: vi.fn(invoke) as unknown as TerminalTransport["invoke"],
    channel(onMessage) {
      const channel: TerminalChannel = { onmessage: onMessage };
      channels.push(channel);
      return channel;
    },
  };
  return { client: createTerminalClient(transport), invokes, channels };
}

describe("terminal client transport", () => {
  it("uses the narrow command payloads and binds attach to one Channel", async () => {
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

    expect(harness.channels).toHaveLength(1);
    expect(harness.channels[0].onmessage).toBe(onFrame);
    expect(harness.invokes.map(({ command }) => command)).toEqual([
      "terminal_attach",
      "terminal_input",
      "terminal_resize",
      "terminal_acknowledge",
      "terminal_detach",
    ]);
    expect(harness.invokes[0].args).toHaveProperty(
      "channel",
      harness.channels[0],
    );
    expect(
      harness.invokes.slice(1).every(({ args }) => !("channel" in args)),
    ).toBe(true);
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
});
