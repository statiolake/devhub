import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { BridgeFault } from "./fault";

export const MAX_MESSAGE_BYTES = 262_144;
export const MAX_TOKEN_BYTES = 4_096;

export function isSafeBearerToken(token: string): boolean {
  return (
    token.length > 0 &&
    Buffer.byteLength(token, "utf8") <= MAX_TOKEN_BYTES &&
    /^[\x21-\x7e]+$/u.test(token)
  );
}

export interface LoopbackSocketHandlers {
  onOpen: () => void;
  onMessage: (raw: string) => void;
  /**
   * Why this connection is over.
   *
   * It used to take no argument, so nine distinct protocol failures arrived
   * indistinguishable and became one `log("endpoint_error")` and a reconnect.
   * The fault is the whole point: a reconnect loop that cannot say what it is
   * retrying is a reconnect loop nobody can debug.
   */
  onError: (fault: BridgeFault) => void;
  onClose: () => void;
}

function frame(text: string): Uint8Array {
  const payload = Buffer.from(text, "utf8");
  if (payload.byteLength > MAX_MESSAGE_BYTES)
    throw new Error("bridge frame too large");
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.byteLength < 126) {
    header = Buffer.from([0x81, 0x80 | payload.byteLength]);
  } else if (payload.byteLength <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.byteLength, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  const masked = Buffer.alloc(payload.byteLength);
  for (let index = 0; index < payload.byteLength; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function pong(payload: Uint8Array): Buffer {
  if (payload.byteLength > 125) return Buffer.from([0x88, 0]);
  return Buffer.concat([
    Buffer.from([0x8a, payload.byteLength]),
    Buffer.from(payload),
  ]);
}

function headerValue(headers: string, name: string): string | null {
  const line = headers
    .split("\r\n")
    .find((value) => value.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(line.indexOf(":") + 1).trim() ?? null;
}

export function validateServerUpgrade(headers: string, key: string): boolean {
  if (
    !/^HTTP\/1\.1 101(?: |$)/m.test(headers) ||
    !/^Upgrade:\s*websocket\s*$/im.test(headers) ||
    !/^Connection:\s*Upgrade\s*$/im.test(headers)
  )
    return false;
  const accept = headerValue(headers, "sec-websocket-accept");
  const expected = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  return accept === expected;
}

/**
 * What the front of a buffer is.
 *
 * One grammar, one implementation. There used to be two: `validateServerFrame`
 * checked a whole assembled frame, and `readFrames` re-checked the reserved
 * bits, the mask, the length and the opcode inline before calling it. Two
 * implementations of one grammar have to be kept in agreement by hand, and
 * these two had already drifted — only the exported one had the opcode
 * allow-list. Now the reader is the grammar, and the exported predicate is a
 * question asked of it.
 */
export type FrameReading =
  /** Not enough bytes yet. Nothing is wrong; wait for more. */
  | { readonly kind: "incomplete" }
  | {
      readonly kind: "frame";
      readonly opcode: number;
      /** Where the payload starts, and how long it is. */
      readonly offset: number;
      readonly length: number;
    }
  | { readonly kind: "invalid"; readonly fault: BridgeFault };

function protocolFault(
  violationKind: Extract<BridgeFault, { kind: "protocol" }>["violation"],
  bytes?: number,
): FrameReading {
  return {
    kind: "invalid",
    fault:
      bytes === undefined
        ? { kind: "protocol", violation: violationKind }
        : { kind: "protocol", violation: violationKind, bytes },
  };
}

/** Read one server frame from the front of `buffer`, or say why not. */
export function readServerFrame(buffer: Uint8Array): FrameReading {
  if (buffer.byteLength < 2) return { kind: "incomplete" };
  const first = buffer[0];
  const second = buffer[1];
  // No fragmentation and no extension: this Bridge negotiated neither, so a
  // frame that claims either is a host speaking a protocol we did not agree.
  if ((first & 0x80) === 0 || (first & 0x70) !== 0)
    return protocolFault("reserved_bits_set");
  if ((second & 0x80) !== 0) return protocolFault("server_frame_masked");
  const opcode = first & 0x0f;
  if (![0x1, 0x8, 0x9, 0xa].includes(opcode))
    return protocolFault("unsupported_opcode");
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.byteLength < 4) return { kind: "incomplete" };
    length = buffer[2] * 256 + buffer[3];
    offset = 4;
  } else if (length === 127) {
    if (buffer.byteLength < 10) return { kind: "incomplete" };
    const longLength = new DataView(
      buffer.buffer,
      buffer.byteOffset + 2,
      8,
    ).getBigUint64(0);
    if (longLength > BigInt(MAX_MESSAGE_BYTES))
      return protocolFault("frame_too_large");
    length = Number(longLength);
    offset = 10;
  }
  if (length > MAX_MESSAGE_BYTES)
    return protocolFault("frame_too_large", length);
  // A control frame carries its whole meaning in one short frame, always.
  if (opcode >= 0x8 && length > 125)
    return protocolFault("control_frame_invalid", length);
  if (buffer.byteLength < offset + length) return { kind: "incomplete" };
  return { kind: "frame", opcode, offset, length };
}

/**
 * Whether `frame` is exactly one complete, acceptable server frame.
 *
 * Kept as the narrow question the contract tests ask. It has no rules of its
 * own — it is `readServerFrame` plus "and nothing left over".
 */
export function validateServerFrame(frame: Uint8Array): boolean {
  const reading = readServerFrame(frame);
  return (
    reading.kind === "frame" &&
    reading.offset + reading.length === frame.byteLength
  );
}

/** Minimal RFC6455 client for the injected loopback endpoint. */
export class LoopbackSocket {
  private readonly endpoint: URL;
  private readonly token: string;
  private readonly handlers: LoopbackSocketHandlers;
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private upgraded = false;
  private closed = false;
  private closeNotified = false;
  private readonly key = randomBytes(16).toString("base64");

  public constructor(
    endpoint: string,
    token: string,
    handlers: LoopbackSocketHandlers,
  ) {
    this.endpoint = new URL(endpoint);
    this.token = token;
    this.handlers = handlers;
    if (
      this.endpoint.protocol !== "ws:" ||
      !["127.0.0.1", "localhost"].includes(this.endpoint.hostname) ||
      this.endpoint.username !== "" ||
      this.endpoint.password !== "" ||
      this.endpoint.search !== "" ||
      this.endpoint.hash !== ""
    ) {
      throw new Error("bridge endpoint is not loopback websocket");
    }
    const port = Number(this.endpoint.port || 80);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error("bridge endpoint port invalid");
    if (!isSafeBearerToken(token)) {
      throw new Error("bridge token invalid");
    }
  }

  public open(): void {
    if (this.closed) return;
    const host = this.endpoint.hostname;
    const port = Number(this.endpoint.port || 80);
    this.socket = connect({ host, port }, () => {
      const path = `${this.endpoint.pathname || "/"}${this.endpoint.search || ""}`;
      this.socket?.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${this.key}`,
          `Authorization: Bearer ${this.token}`,
          "\r\n",
        ].join("\r\n"),
      );
    });
    this.socket.on("data", (chunk: Buffer) => this.receive(chunk));
    this.socket.on("error", (error: NodeJS.ErrnoException) => {
      // Node's code, which is the whole diagnostic: ECONNREFUSED means DevHub
      // is not listening, EPIPE means it went away mid-frame, and the two want
      // different things looked at.
      if (!this.closed)
        this.handlers.onError({
          kind: "transport",
          errno: error.code ?? "unknown",
        });
    });
    this.socket.on("close", () => {
      this.notifyClose();
    });
  }

  public send(raw: string): boolean {
    if (!this.socket || !this.upgraded || this.closed) return false;
    try {
      this.socket.write(frame(raw));
      return true;
    } catch {
      return false;
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
    this.notifyClose();
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.handlers.onClose();
  }

  /** End this connection, and say why. */
  private fail(fault: BridgeFault): void {
    this.close();
    this.handlers.onError(fault);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_MESSAGE_BYTES + 16 * 1024) {
      this.fail({
        kind: "protocol",
        violation: "frame_too_large",
        bytes: this.buffer.byteLength,
      });
      return;
    }
    if (!this.upgraded) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (this.buffer.byteLength > 16 * 1024) {
        this.fail({ kind: "handshake", refusal: "headers_too_large" });
        return;
      }
      if (end < 0) return;
      const headers = this.buffer.subarray(0, end).toString("latin1");
      this.buffer = this.buffer.subarray(end + 4);
      if (!validateServerUpgrade(headers, this.key)) {
        this.fail({ kind: "handshake", refusal: "upgrade_rejected" });
        return;
      }
      this.upgraded = true;
      this.handlers.onOpen();
    }
    this.readFrames();
  }

  private readFrames(): void {
    for (;;) {
      const reading = readServerFrame(this.buffer);
      if (reading.kind === "incomplete") return;
      if (reading.kind === "invalid") {
        this.fail(reading.fault);
        return;
      }
      const { opcode, offset, length } = reading;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      // A close from the host is the host ending the conversation, not a
      // failure: there is nothing to report and nothing to retry differently.
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.socket?.write(pong(payload));
        continue;
      }
      if (opcode === 0xa) continue;
      this.handlers.onMessage(payload.toString("utf8"));
    }
  }
}
