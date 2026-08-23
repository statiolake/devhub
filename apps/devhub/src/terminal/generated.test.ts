import fixture from "../../../../contracts/terminal/terminal-v1.fixture.json";
import { describe, expect, it } from "vitest";
import {
  MAX_CHANNEL_FRAME_BYTES,
  MAX_INPUT_BYTES,
  MAX_INPUT_SEQUENCE,
  MAX_ATTACHMENT_ID_BYTES,
  MAX_ERROR_SUMMARY_BYTES,
  MAX_OUTPUT_FRAME_BYTES,
  MAX_PIXEL,
  MAX_TARGET_GENERATION,
  MAX_SURFACE_KEY_BYTES,
  MAX_COLS,
  MAX_ROWS,
  TerminalFrameDecoder,
  TERMINAL_PROTOCOL_VERSION,
  decodeTerminalFrame,
} from "./generated";

function raw(
  kind: number,
  header: Record<string, unknown>,
  output = new Uint8Array(),
) {
  const metadata = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(8 + metadata.byteLength + output.byteLength);
  bytes[0] = TERMINAL_PROTOCOL_VERSION;
  bytes[1] = kind;
  new DataView(bytes.buffer).setUint32(4, metadata.byteLength, true);
  bytes.set(metadata, 8);
  bytes.set(output, 8 + metadata.byteLength);
  return bytes;
}

describe("terminal v1 generated contract", () => {
  it("keeps the Rust fixture constants and frame tags aligned", () => {
    expect(TERMINAL_PROTOCOL_VERSION).toBe(fixture.protocolVersion);
    expect(MAX_INPUT_BYTES).toBe(fixture.limits.maxInputBytes);
    expect(MAX_OUTPUT_FRAME_BYTES).toBe(fixture.limits.maxOutputFrameBytes);
    expect(MAX_CHANNEL_FRAME_BYTES).toBe(fixture.limits.maxChannelFrameBytes);
    expect(MAX_SURFACE_KEY_BYTES).toBe(fixture.limits.maxSurfaceKeyBytes);
    expect(MAX_ATTACHMENT_ID_BYTES).toBe(fixture.limits.maxAttachmentIdBytes);
    expect(MAX_ERROR_SUMMARY_BYTES).toBe(fixture.limits.maxErrorSummaryBytes);
    expect(MAX_INPUT_SEQUENCE).toBe(fixture.limits.maxInputSequence);
    expect(MAX_COLS).toBe(fixture.limits.maxCols);
    expect(MAX_ROWS).toBe(fixture.limits.maxRows);
    expect(MAX_PIXEL).toBe(fixture.limits.maxPixel);
    expect(MAX_TARGET_GENERATION).toBe(fixture.limits.maxTargetGeneration);
  });

  it("rejects malformed and out-of-order raw frames", () => {
    const decoder = new TerminalFrameDecoder();
    expect(() =>
      decoder.push(raw(2, fixture.outputMetadata, new Uint8Array([1]))),
    ).toThrow();
    expect(decoder.push(raw(1, fixture.started))).toMatchObject({
      type: "started",
    });
    expect(
      decoder.push(raw(2, fixture.outputMetadata, new Uint8Array([1, 2]))),
    ).toMatchObject({
      sequence: 1,
    });
    expect(decoder.push(raw(3, fixture.exited))).toMatchObject({
      type: "exited",
    });
    expect(() => decoder.push(raw(3, fixture.exited))).toThrow();
    expect(() => decodeTerminalFrame(new Uint8Array([1, 2, 0]))).toThrow();
  });

  it("accepts the complete error shape and treats it as terminal", () => {
    const decoder = new TerminalFrameDecoder();
    const error = decoder.push(raw(4, fixture.errorMetadata));
    expect(error).toMatchObject({
      type: "error",
      error: { code: "channel_closed" },
    });
    expect(() => decoder.push(raw(1, fixture.started))).toThrow();
  });

  it("keeps generations inside JavaScript's exact integer range", () => {
    expect(
      decodeTerminalFrame(
        raw(1, { ...fixture.started, targetGeneration: MAX_TARGET_GENERATION }),
      ),
    ).toMatchObject({ targetGeneration: MAX_TARGET_GENERATION });
    expect(() =>
      decodeTerminalFrame(
        raw(1, {
          ...fixture.started,
          targetGeneration: MAX_TARGET_GENERATION + 1,
        }),
      ),
    ).toThrow();
  });
});
