import {
  MAX_ATTACHMENT_ID_BYTES,
  MAX_CHANNEL_FRAME_BYTES,
  MAX_COLS,
  MAX_ERROR_SUMMARY_BYTES,
  MAX_INPUT_SEQUENCE,
  MAX_OUTPUT_FRAME_BYTES,
  MAX_PIXEL,
  MAX_ROWS,
  MAX_SURFACE_KEY_BYTES,
  MAX_TARGET_GENERATION,
  MIN_COLS,
  MIN_ROWS,
  TERMINAL_FRAME_KINDS,
  TERMINAL_PROTOCOL_VERSION,
} from "./generated-contract";
import type {
  ExitReason,
  TerminalError,
  TerminalErrorCode,
  TerminalFrame,
} from "./generated-contract";

export * from "./generated-contract";

const ERROR_CODES = new Set<TerminalErrorCode>([
  "invalid_request",
  "invalid_surface",
  "surface_unavailable",
  "stale_target",
  "wrong_attachment",
  "attachment_limit",
  "session_unavailable",
  "pty_unavailable",
  "input_too_large",
  "invalid_resize",
  "channel_closed",
  "backpressure",
  "runtime_unavailable",
  "internal",
]);

const EXIT_REASONS = new Set<ExitReason>(["eof", "detached", "childExited"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => expected.has(key))
  );
}

function boundedString(value: unknown, maxBytes: number, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${name}`);
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new Error(`${name} is too long`);
  }
  return value;
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function schemaVersion(value: unknown): 1 {
  if (value !== TERMINAL_PROTOCOL_VERSION)
    throw new Error("invalid schema version");
  return 1;
}

function attachmentId(value: unknown): string {
  const id = boundedString(value, MAX_ATTACHMENT_ID_BYTES, "attachment id");
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("invalid attachment id");
  return id;
}

function surfaceKey(value: unknown): string {
  const key = boundedString(value, MAX_SURFACE_KEY_BYTES, "surface key");
  if (
    /\s/u.test(key) ||
    key.includes("\0") ||
    (key !== "global-terminal" &&
      !/^workspace-terminal:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        key,
      ))
  ) {
    throw new Error("invalid surface key");
  }
  return key;
}

function dimensions(
  colsValue: unknown,
  rowsValue: unknown,
  pixelWidthValue: unknown,
  pixelHeightValue: unknown,
): { readonly cols: number; readonly rows: number } {
  const cols = safeInteger(colsValue, "columns");
  const rows = safeInteger(rowsValue, "rows");
  const pixelWidth = safeInteger(pixelWidthValue, "pixel width");
  const pixelHeight = safeInteger(pixelHeightValue, "pixel height");
  if (
    cols < MIN_COLS ||
    cols > MAX_COLS ||
    rows < MIN_ROWS ||
    rows > MAX_ROWS ||
    pixelWidth > MAX_PIXEL ||
    pixelHeight > MAX_PIXEL
  ) {
    throw new Error("invalid terminal size");
  }
  return { cols, rows };
}

function sequence(value: unknown): number {
  const result = safeInteger(value, "sequence");
  if (result > MAX_INPUT_SEQUENCE) throw new Error("sequence is too large");
  return result;
}

function parseError(value: unknown): TerminalError {
  if (!isRecord(value) || !exactKeys(value, ["code", "summary"])) {
    throw new Error("invalid terminal error");
  }
  if (
    typeof value.code !== "string" ||
    !ERROR_CODES.has(value.code as TerminalErrorCode)
  ) {
    throw new Error("invalid terminal error code");
  }
  const summary = boundedString(
    value.summary,
    MAX_ERROR_SUMMARY_BYTES,
    "error summary",
  );
  return { code: value.code as TerminalErrorCode, summary };
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  throw new Error("terminal Channel frame must be raw bytes");
}

/** Decode exactly one native raw Channel frame; malformed/truncated frames fail closed. */
export function decodeTerminalFrame(value: unknown): TerminalFrame {
  const bytes = toBytes(value);
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_CHANNEL_FRAME_BYTES) {
    throw new Error("terminal frame length is invalid");
  }
  if (
    bytes[0] !== TERMINAL_PROTOCOL_VERSION ||
    bytes[2] !== 0 ||
    bytes[3] !== 0
  ) {
    throw new Error("terminal frame header is invalid");
  }
  const headerLength = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(4, true);
  if (
    headerLength > MAX_CHANNEL_FRAME_BYTES - 8 ||
    headerLength > bytes.byteLength - 8
  ) {
    throw new Error("terminal frame header length is invalid");
  }
  const kind = bytes[1];
  const headerBytes = bytes.subarray(8, 8 + headerLength);
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(headerBytes),
    );
  } catch {
    throw new Error("terminal frame metadata is invalid");
  }
  if (!isRecord(header) || typeof header.type !== "string") {
    throw new Error("terminal frame metadata is invalid");
  }
  const payload = bytes.subarray(8 + headerLength);
  const schema = schemaVersion(header.schemaVersion);
  const id = attachmentId(header.attachmentId);
  const frameSequence = sequence(header.sequence);
  const frameType = header.type;
  if (frameType === "started") {
    if (
      kind !== TERMINAL_FRAME_KINDS.started ||
      payload.byteLength !== 0 ||
      !exactKeys(header, [
        "type",
        "schemaVersion",
        "attachmentId",
        "sequence",
        "surfaceKey",
        "targetGeneration",
        "cols",
        "rows",
      ])
    )
      throw new Error("started frame is invalid");
    const generation = safeInteger(
      header.targetGeneration,
      "target generation",
    );
    const size = dimensions(header.cols, header.rows, 0, 0);
    if (
      frameSequence !== 0 ||
      generation === 0 ||
      generation > MAX_TARGET_GENERATION
    )
      throw new Error("started frame sequence is invalid");
    return {
      type: "started",
      schemaVersion: schema,
      attachmentId: id,
      sequence: 0,
      surfaceKey: surfaceKey(header.surfaceKey),
      targetGeneration: generation,
      cols: size.cols,
      rows: size.rows,
    };
  }
  if (frameType === "output") {
    if (
      kind !== TERMINAL_FRAME_KINDS.output ||
      !exactKeys(header, ["type", "schemaVersion", "attachmentId", "sequence"])
    ) {
      throw new Error("output frame is invalid");
    }
    if (
      payload.byteLength === 0 ||
      payload.byteLength > MAX_OUTPUT_FRAME_BYTES
    ) {
      throw new Error("output frame bytes are invalid");
    }
    return {
      type: "output",
      schemaVersion: schema,
      attachmentId: id,
      sequence: frameSequence,
      bytes: new Uint8Array(payload),
    };
  }
  if (frameType === "exited") {
    if (
      kind !== TERMINAL_FRAME_KINDS.exited ||
      payload.byteLength !== 0 ||
      !exactKeys(header, [
        "type",
        "schemaVersion",
        "attachmentId",
        "sequence",
        "reason",
      ])
    )
      throw new Error("exited frame is invalid");
    if (
      typeof header.reason !== "string" ||
      !EXIT_REASONS.has(header.reason as ExitReason)
    ) {
      throw new Error("exit reason is invalid");
    }
    return {
      type: "exited",
      schemaVersion: schema,
      attachmentId: id,
      sequence: frameSequence,
      reason: header.reason as ExitReason,
    };
  }
  if (frameType === "error") {
    if (
      kind !== TERMINAL_FRAME_KINDS.error ||
      payload.byteLength !== 0 ||
      !exactKeys(header, [
        "type",
        "schemaVersion",
        "attachmentId",
        "sequence",
        "error",
      ])
    )
      throw new Error("error frame is invalid");
    return {
      type: "error",
      schemaVersion: schema,
      attachmentId: id,
      sequence: frameSequence,
      error: parseError(header.error),
    };
  }
  throw new Error("unknown terminal frame type");
}

/** Enforce one attachment identity and a contiguous sequence after decoding. */
export class TerminalFrameDecoder {
  private attachment?: string;
  private expectedSequence = 0;
  private started = false;
  private terminal = false;

  get attachmentId(): string | undefined {
    return this.attachment;
  }

  push(value: unknown): TerminalFrame {
    if (this.terminal) throw new Error("terminal frame arrived after exit");
    const frame = decodeTerminalFrame(value);
    if (this.attachment === undefined) this.attachment = frame.attachmentId;
    if (frame.attachmentId !== this.attachment)
      throw new Error("attachment identity changed");
    if (frame.type === "started") {
      if (this.started || this.expectedSequence !== 0)
        throw new Error("duplicate started frame");
      this.started = true;
      return frame;
    }
    if (
      frame.type === "error" &&
      !this.started &&
      this.expectedSequence === 0 &&
      frame.sequence === 0
    ) {
      this.expectedSequence = frame.sequence;
      this.terminal = true;
      return frame;
    }
    if (frame.type === "output" && !this.started) {
      throw new Error("output arrived before started frame");
    }
    const expected = this.expectedSequence + 1;
    if (frame.sequence !== expected)
      throw new Error("terminal frame sequence is not contiguous");
    this.expectedSequence = frame.sequence;
    if (frame.type === "exited" || frame.type === "error") {
      this.terminal = true;
    }
    return frame;
  }
}
