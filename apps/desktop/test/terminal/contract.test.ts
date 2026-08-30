/**
 * The terminal wire contract, both directions.
 *
 * Ported from the Rust `terminal/contract.rs` tests and the generated decoder's
 * tests. The fixture beside this file is the one the Tauri app and its Rust
 * counterpart were both checked against; keeping it means the framing this port
 * produces is the framing that was proven, byte for byte.
 */

import { describe, expect, it } from "vitest";
import fixture from "./terminal-v1.fixture.json" with { type: "json" };
import {
  MAX_CHANNEL_FRAME_BYTES,
  MAX_INPUT_BYTES,
  MAX_INPUT_SEQUENCE,
  MAX_OUTPUT_FRAME_BYTES,
  MAX_SURFACE_KEY_BYTES,
  MAX_TARGET_GENERATION,
  TERMINAL_FRAME_HEADER_BYTES,
  TERMINAL_FRAME_KINDS,
  TERMINAL_PROTOCOL_VERSION,
  TerminalFailure,
  TerminalFrameDecoder,
  decodeTerminalFrame,
  encodeTerminalFrame,
  validateAckRequest,
  validateAttachRequest,
  validateDetachRequest,
  validateInputRequest,
  validateResizeRequest,
  validateSize,
  validateSurfaceKey,
  type TerminalFrame,
} from "../../src/ipc/terminal";

const ATTACHMENT_ID = fixture.receipt.attachmentId;

function header(frame: TerminalFrame): unknown {
  const raw = encodeTerminalFrame(frame);
  const length = new DataView(
    raw.buffer,
    raw.byteOffset,
    raw.byteLength,
  ).getUint32(4, true);
  return JSON.parse(
    new TextDecoder().decode(
      raw.subarray(
        TERMINAL_FRAME_HEADER_BYTES,
        TERMINAL_FRAME_HEADER_BYTES + length,
      ),
    ),
  );
}

describe("terminal frame encoding", () => {
  it("keeps output raw and bounded rather than base64", () => {
    const raw = encodeTerminalFrame({
      type: "output",
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      attachmentId: ATTACHMENT_ID,
      sequence: 1,
      bytes: Uint8Array.from([0, 1, 2, 255]),
    });
    expect(raw[0]).toBe(TERMINAL_PROTOCOL_VERSION);
    expect(raw[1]).toBe(TERMINAL_FRAME_KINDS.output);
    expect(new TextDecoder().decode(raw)).not.toContain("base");
    expect(raw.subarray(raw.byteLength - 4)).toEqual(
      Uint8Array.from([0, 1, 2, 255]),
    );
  });

  it("refuses a frame larger than the channel bound", () => {
    expect(() =>
      encodeTerminalFrame({
        type: "output",
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        attachmentId: ATTACHMENT_ID,
        sequence: 1,
        bytes: new Uint8Array(MAX_OUTPUT_FRAME_BYTES + 1),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "backpressure" }) as unknown as Error,
    );
  });

  it("matches the shared fixture's field names and values", () => {
    expect(
      header({
        type: "started",
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        attachmentId: ATTACHMENT_ID,
        sequence: 0,
        surfaceKey: fixture.started.surfaceKey,
        targetGeneration: fixture.started.targetGeneration,
        cols: fixture.started.cols,
        rows: fixture.started.rows,
      }),
    ).toEqual(fixture.started);
    expect(
      header({
        type: "error",
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        attachmentId: ATTACHMENT_ID,
        sequence: fixture.errorMetadata.sequence,
        error: new TerminalFailure("channel_closed").toWire(),
      }),
    ).toEqual(fixture.errorMetadata);
    expect(
      header({
        type: "exited",
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        attachmentId: ATTACHMENT_ID,
        sequence: fixture.exited.sequence,
        reason: "detached",
      }),
    ).toEqual(fixture.exited);
    expect(
      header({
        type: "output",
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        attachmentId: ATTACHMENT_ID,
        sequence: fixture.outputMetadata.sequence,
        bytes: Uint8Array.from([65]),
      }),
    ).toEqual(fixture.outputMetadata);
  });

  it("keeps the protocol constants the fixture pins", () => {
    expect(fixture.protocolVersion).toBe(TERMINAL_PROTOCOL_VERSION);
    expect(fixture.headerBytes).toBe(TERMINAL_FRAME_HEADER_BYTES);
    expect(fixture.frameKinds).toEqual(TERMINAL_FRAME_KINDS);
    expect(fixture.limits.maxInputBytes).toBe(MAX_INPUT_BYTES);
    expect(fixture.limits.maxOutputFrameBytes).toBe(MAX_OUTPUT_FRAME_BYTES);
    expect(fixture.limits.maxChannelFrameBytes).toBe(MAX_CHANNEL_FRAME_BYTES);
    expect(fixture.limits.maxSurfaceKeyBytes).toBe(MAX_SURFACE_KEY_BYTES);
    expect(fixture.limits.maxInputSequence).toBe(MAX_INPUT_SEQUENCE);
    expect(fixture.limits.maxTargetGeneration).toBe(MAX_TARGET_GENERATION);
    expect(fixture.errors.codes.every((code) => typeof code === "string")).toBe(
      true,
    );
  });
});

describe("terminal frame decoding", () => {
  it("round-trips every frame the main process can produce", () => {
    const frames: TerminalFrame[] = [
      {
        type: "started",
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        attachmentId: ATTACHMENT_ID,
        sequence: 0,
        surfaceKey: "global-terminal",
        targetGeneration: 7,
        cols: 80,
        rows: 24,
      },
      {
        type: "output",
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        attachmentId: ATTACHMENT_ID,
        sequence: 1,
        bytes: new TextEncoder().encode("日本語 💻\n"),
      },
      {
        type: "error",
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        attachmentId: ATTACHMENT_ID,
        sequence: 2,
        error: new TerminalFailure("backpressure").toWire(),
      },
      {
        type: "exited",
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        attachmentId: ATTACHMENT_ID,
        sequence: 3,
        reason: "eof",
      },
    ];
    for (const frame of frames) {
      expect(decodeTerminalFrame(encodeTerminalFrame(frame))).toEqual(frame);
    }
  });

  it("fails closed on a truncated, retagged, or foreign frame", () => {
    const raw = encodeTerminalFrame({
      type: "exited",
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      attachmentId: ATTACHMENT_ID,
      sequence: 1,
      reason: "eof",
    });
    expect(() => decodeTerminalFrame(raw.subarray(0, raw.byteLength - 3))).toThrow();
    const retagged = Uint8Array.from(raw);
    retagged[1] = TERMINAL_FRAME_KINDS.output;
    expect(() => decodeTerminalFrame(retagged)).toThrow();
    const wrongVersion = Uint8Array.from(raw);
    wrongVersion[0] = 2;
    expect(() => decodeTerminalFrame(wrongVersion)).toThrow();
    expect(() => decodeTerminalFrame("not bytes")).toThrow();
    expect(() => decodeTerminalFrame(new Uint8Array(4))).toThrow();
  });

  it("holds one identity and a contiguous sequence", () => {
    const decoder = new TerminalFrameDecoder();
    const started = encodeTerminalFrame({
      type: "started",
      schemaVersion: TERMINAL_PROTOCOL_VERSION,
      attachmentId: ATTACHMENT_ID,
      sequence: 0,
      surfaceKey: "global-terminal",
      targetGeneration: 1,
      cols: 80,
      rows: 24,
    });
    const output = (sequence: number) =>
      encodeTerminalFrame({
        type: "output",
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        attachmentId: ATTACHMENT_ID,
        sequence,
        bytes: Uint8Array.from([65]),
      });
    expect(decoder.push(started).type).toBe("started");
    expect(decoder.push(output(1)).type).toBe("output");
    // A gap is a lost frame, and a terminal that renders around a lost frame
    // is showing something that never happened.
    expect(() => decoder.push(output(3))).toThrow();

    const fresh = new TerminalFrameDecoder();
    expect(() => fresh.push(output(1))).toThrow();

    const other = new TerminalFrameDecoder();
    other.push(started);
    expect(() =>
      other.push(
        encodeTerminalFrame({
          type: "output",
          schemaVersion: TERMINAL_PROTOCOL_VERSION,
          attachmentId: "ffffffffffffffffffffffffffffffff",
          sequence: 1,
          bytes: Uint8Array.from([65]),
        }),
      ),
    ).toThrow();
  });

  it("ends at the first terminal frame", () => {
    const decoder = new TerminalFrameDecoder();
    decoder.push(
      encodeTerminalFrame({
        type: "error",
        schemaVersion: TERMINAL_PROTOCOL_VERSION,
        attachmentId: ATTACHMENT_ID,
        sequence: 0,
        error: new TerminalFailure("pty_unavailable").toWire(),
      }),
    );
    expect(() =>
      decoder.push(
        encodeTerminalFrame({
          type: "exited",
          schemaVersion: TERMINAL_PROTOCOL_VERSION,
          attachmentId: ATTACHMENT_ID,
          sequence: 1,
          reason: "childExited",
        }),
      ),
    ).toThrow();
  });
});

describe("terminal request validation", () => {
  it("accepts exactly the surfaces DevHub has", () => {
    expect(validateSurfaceKey("global-terminal")).toBe("global-terminal");
    expect(
      validateSurfaceKey(
        "workspace-terminal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
    ).toBeTruthy();
    for (const invalid of [
      "",
      "/var/folders/session",
      "workspace terminal",
      "workspace-terminal:not-a-uuid",
      "global-terminal\0",
      "x".repeat(MAX_SURFACE_KEY_BYTES + 1),
      42,
    ]) {
      expect(() => validateSurfaceKey(invalid)).toThrowError(
        expect.objectContaining({ code: "invalid_surface" }) as unknown as Error,
      );
    }
  });

  it("bounds the grid", () => {
    expect(
      validateSize({ cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 }),
    ).toEqual({ cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 });
    for (const size of [
      { cols: 0, rows: 24, pixelWidth: 0, pixelHeight: 0 },
      { cols: 80, rows: 0, pixelWidth: 0, pixelHeight: 0 },
      { cols: 501, rows: 24, pixelWidth: 0, pixelHeight: 0 },
      { cols: 80, rows: 24, pixelWidth: 10_001, pixelHeight: 0 },
      { cols: 80.5, rows: 24, pixelWidth: 0, pixelHeight: 0 },
    ]) {
      expect(() => validateSize(size)).toThrowError(
        expect.objectContaining({ code: "invalid_resize" }) as unknown as Error,
      );
    }
  });

  it("takes the fixture's requests and refuses anything extra", () => {
    expect(validateAttachRequest(fixture.requests.attach).surfaceKey).toBe(
      "global-terminal",
    );
    expect(validateInputRequest(fixture.requests.input).inputSequence).toBe(1);
    expect(validateResizeRequest(fixture.requests.resize).size.cols).toBe(100);
    expect(validateAckRequest(fixture.requests.acknowledge).sequence).toBe(1);
    expect(validateDetachRequest(fixture.requests.detach).attachmentId).toBe(
      ATTACHMENT_ID,
    );
    expect(() =>
      validateAttachRequest({ ...fixture.requests.attach, extra: 1 }),
    ).toThrow();
    // Attach never names a generation: the capability is main's to allocate.
    expect(() =>
      validateAttachRequest({ ...fixture.requests.attach, targetGeneration: 1 }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_request" }) as unknown as Error,
    );
  });

  it("bounds input and refuses a replayed or out-of-range sequence", () => {
    const base = fixture.requests.input;
    expect(
      validateInputRequest({
        ...base,
        bytes: new Array(MAX_INPUT_BYTES).fill(0),
      }).bytes.byteLength,
    ).toBe(MAX_INPUT_BYTES);
    expect(() =>
      validateInputRequest({
        ...base,
        bytes: new Array(MAX_INPUT_BYTES + 1).fill(0),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "input_too_large" }) as unknown as Error,
    );
    expect(() =>
      validateInputRequest({ ...base, inputSequence: 0 }),
    ).toThrow();
    expect(() =>
      validateInputRequest({
        ...base,
        inputSequence: MAX_INPUT_SEQUENCE + 1,
      }),
    ).toThrow();
    expect(() =>
      validateInputRequest({ ...base, attachmentId: "short" }),
    ).toThrowError(
      expect.objectContaining({
        code: "wrong_attachment",
      }) as unknown as Error,
    );
    expect(() =>
      validateInputRequest({ ...base, targetGeneration: 0 }),
    ).toThrowError(
      expect.objectContaining({
        code: "wrong_attachment",
      }) as unknown as Error,
    );
  });
});
