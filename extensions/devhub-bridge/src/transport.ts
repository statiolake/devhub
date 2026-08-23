import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

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
  onError: () => void;
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

/** Validate one complete server frame before handing it to the stateful reader. */
export function validateServerFrame(frame: Uint8Array): boolean {
  if (frame.byteLength < 2) return false;
  const first = frame[0];
  const second = frame[1];
  if ((first & 0x80) === 0 || (first & 0x70) !== 0 || (second & 0x80) !== 0)
    return false;
  const opcode = first & 0x0f;
  if (![0x1, 0x8, 0x9, 0xa].includes(opcode)) return false;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (frame.byteLength < 4) return false;
    length = frame[2] * 256 + frame[3];
    offset = 4;
  } else if (length === 127) {
    if (frame.byteLength < 10) return false;
    const longLength = new DataView(
      frame.buffer,
      frame.byteOffset + 2,
      8,
    ).getBigUint64(0);
    if (longLength > BigInt(MAX_MESSAGE_BYTES)) return false;
    length = Number(longLength);
    offset = 10;
  }
  if (length > MAX_MESSAGE_BYTES || frame.byteLength !== offset + length)
    return false;
  return opcode < 0x8 || ((first & 0x80) !== 0 && length <= 125);
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
    this.socket.on("error", () => {
      if (!this.closed) this.handlers.onError();
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

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_MESSAGE_BYTES + 16 * 1024) {
      this.close();
      this.handlers.onError();
      return;
    }
    if (!this.upgraded) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (this.buffer.byteLength > 16 * 1024) {
        this.close();
        this.handlers.onError();
        return;
      }
      if (end < 0) return;
      const headers = this.buffer.subarray(0, end).toString("latin1");
      this.buffer = this.buffer.subarray(end + 4);
      if (!validateServerUpgrade(headers, this.key)) {
        this.close();
        this.handlers.onError();
        return;
      }
      this.upgraded = true;
      this.handlers.onOpen();
    }
    this.readFrames();
  }

  private readFrames(): void {
    while (this.buffer.byteLength >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      if ((first & 0x80) === 0 || (first & 0x70) !== 0) {
        this.close();
        this.handlers.onError();
        return;
      }
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if (masked) {
        this.close();
        this.handlers.onError();
        return;
      }
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.byteLength < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.byteLength < offset + 8) return;
        const longLength = this.buffer.readBigUInt64BE(offset);
        if (longLength > BigInt(MAX_MESSAGE_BYTES)) {
          this.close();
          this.handlers.onError();
          return;
        }
        length = Number(longLength);
        offset += 8;
      }
      if (length > MAX_MESSAGE_BYTES) {
        this.close();
        this.handlers.onError();
        return;
      }
      if (this.buffer.byteLength < offset + length) return;
      const completeFrame = this.buffer.subarray(0, offset + length);
      if (!validateServerFrame(completeFrame)) {
        this.close();
        this.handlers.onError();
        return;
      }
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode >= 0x8 && ((first & 0x80) === 0 || length > 125)) {
        this.close();
        this.handlers.onError();
        return;
      }
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.socket?.write(pong(payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode !== 0x1) {
        this.close();
        this.handlers.onError();
        return;
      }
      this.handlers.onMessage(payload.toString("utf8"));
    }
  }
}
