import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import {
  LoopbackSocket,
  validateServerFrame,
  validateServerUpgrade,
} from "../src/transport";

function serverTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length >= 126) throw new Error("test payload too large");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function handshake(request: string): string {
  const key = request.match(/Sec-WebSocket-Key: ([^\r\n]+)/i)?.[1];
  if (!key) throw new Error("missing websocket key");
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n");
}

async function listeningServer(
  onUpgrade: (socket: Socket, request: string) => void,
): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      request = Buffer.concat([request, chunk]);
      const end = request.indexOf("\r\n\r\n");
      if (end < 0) return;
      onUpgrade(socket, request.subarray(0, end + 4).toString("latin1"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as AddressInfo).port };
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("RFC6455 validators enforce upgrade and server-frame trust boundaries", () => {
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  assert.equal(
    validateServerUpgrade(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      key,
    ),
    true,
  );
  assert.equal(validateServerUpgrade("HTTP/1.1 200 OK\r\n\r\n", key), false);
  assert.equal(
    validateServerFrame(Buffer.from([0x81, 0x02, 0x7b, 0x7d])),
    true,
  );
  assert.equal(
    validateServerFrame(Buffer.from([0x01, 0x02, 0x7b, 0x7d])),
    false,
  );
  assert.equal(
    validateServerFrame(Buffer.from([0x81, 0x82, 1, 2, 0x7b, 0x7d])),
    false,
  );
  assert.equal(
    validateServerFrame(Buffer.from([0xc1, 0x02, 0x7b, 0x7d])),
    false,
  );
});

test("loopback transport authenticates and accepts a valid unmasked text frame", async (t) => {
  let authorization = "";
  let server: ReturnType<typeof createServer>;
  let port: number;
  try {
    ({ server, port } = await listeningServer((socket, request) => {
      authorization = request.match(/Authorization: ([^\r\n]+)/i)?.[1] ?? "";
      socket.write(handshake(request));
      socket.write(serverTextFrame('{"kind":"hello_accepted"}'));
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip(
        "sandbox disallows loopback bind; run the integration lane with network permission",
      );
      return;
    }
    throw error;
  }
  const message = new Promise<string>((resolve, reject) => {
    const client = new LoopbackSocket(
      `ws://127.0.0.1:${port}/bridge`,
      "secret",
      {
        onOpen: () => undefined,
        onMessage: (raw) => {
          try {
            assert.equal(raw, '{"kind":"hello_accepted"}');
            resolve(raw);
            client.close();
          } catch (error) {
            reject(error);
          }
        },
        onError: () => reject(new Error("unexpected transport error")),
        onClose: () => undefined,
      },
    );
    client.open();
  });
  await message;
  await closeServer(server);
  assert.equal(authorization, "Bearer secret");
});

test("loopback transport rejects endpoint authority/query and unsafe bearer tokens", () => {
  const handlers = {
    onOpen: () => undefined,
    onMessage: () => undefined,
    onError: () => undefined,
    onClose: () => undefined,
  };
  assert.throws(
    () =>
      new LoopbackSocket(
        "ws://user:pass@127.0.0.1:1/bridge",
        "token",
        handlers,
      ),
  );
  assert.throws(
    () => new LoopbackSocket("ws://127.0.0.1:1/bridge?x=1", "token", handlers),
  );
  assert.throws(
    () =>
      new LoopbackSocket("ws://127.0.0.1:1/bridge", "bad\r\nToken", handlers),
  );
});

test("loopback transport fails closed for masked and RSV server frames", async (t) => {
  for (const firstByte of [0x81, 0xc1]) {
    let server: ReturnType<typeof createServer>;
    let port: number;
    try {
      ({ server, port } = await listeningServer((socket, request) => {
        socket.write(handshake(request));
        socket.write(Buffer.from([firstByte, 0x81, 0x01, 0, 0, 0, 0]));
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip(
          "sandbox disallows loopback bind; run the integration lane with network permission",
        );
        return;
      }
      throw error;
    }
    const failure = new Promise<void>((resolve, reject) => {
      const client = new LoopbackSocket(
        `ws://127.0.0.1:${port}/bridge`,
        "secret",
        {
          onOpen: () => undefined,
          onMessage: () => reject(new Error("invalid frame was delivered")),
          onError: () => resolve(),
          onClose: () => undefined,
        },
      );
      client.open();
    });
    await failure;
    await closeServer(server);
  }
});
