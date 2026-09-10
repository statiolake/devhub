/**
 * Every way the Bridge can fail, and the fact that it says which one.
 *
 * The old shape was `onError()` with no argument: nine distinct protocol
 * failures and seven configuration refusals arrived indistinguishable, became
 * one `log("endpoint_error")`, and were retried forever. These tests exist so
 * that a new failure mode cannot be added as another silent branch — each one
 * is asserted to arrive as a `BridgeFault` naming what it was.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import {
  describeFault,
  faultIdentity,
  faultIsTransient,
  type BridgeFault,
} from "../src/fault";
import {
  LoopbackSocket,
  MAX_MESSAGE_BYTES,
  readServerFrame,
  validateServerFrame,
} from "../src/transport";
import { BridgeSession } from "../src/session";
import {
  BridgeControllerCore,
  type ControllerSocket,
  type ControllerSocketHandlers,
} from "../src/controller";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

// ------------------------------------------------------- the frame grammar

test("one frame grammar names each violation it refuses", () => {
  const cases: [Uint8Array, string][] = [
    // FIN clear: this Bridge negotiated no fragmentation.
    [Buffer.from([0x01, 0x02, 0x7b, 0x7d]), "reserved_bits_set"],
    // A reserved bit: no extension was negotiated either.
    [Buffer.from([0xc1, 0x02, 0x7b, 0x7d]), "reserved_bits_set"],
    // A masked server frame, which RFC6455 forbids outright.
    [Buffer.from([0x81, 0x82, 1, 2, 0x7b, 0x7d]), "server_frame_masked"],
    // Binary — an opcode this Bridge does not speak.
    [Buffer.from([0x82, 0x02, 0x7b, 0x7d]), "unsupported_opcode"],
    // A 64-bit length beyond the message limit.
    [
      Buffer.concat([
        Buffer.from([0x81, 127]),
        (() => {
          const length = Buffer.alloc(8);
          length.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES) + 1n);
          return length;
        })(),
      ]),
      "frame_too_large",
    ],
    // A ping carrying more than a control frame may.
    [
      Buffer.concat([Buffer.from([0x89, 126, 0x00, 0xc8]), Buffer.alloc(200)]),
      "control_frame_invalid",
    ],
  ];
  for (const [bytes, violation] of cases) {
    const reading = readServerFrame(bytes);
    assert.equal(reading.kind, "invalid", violation);
    assert.equal(
      reading.kind === "invalid" && reading.fault.kind === "protocol"
        ? reading.fault.violation
        : "",
      violation,
    );
    // The exported predicate is the same grammar asked a narrower question,
    // not a second implementation that has to be kept in agreement by hand.
    assert.equal(validateServerFrame(bytes), false, violation);
  }
});

test("an incomplete frame is not a fault", () => {
  assert.equal(readServerFrame(Buffer.from([0x81])).kind, "incomplete");
  assert.equal(
    readServerFrame(Buffer.from([0x81, 0x05, 1, 2])).kind,
    "incomplete",
  );
  // …and a whole one is a frame, with the payload located once.
  const reading = readServerFrame(Buffer.from([0x81, 0x02, 0x7b, 0x7d]));
  assert.deepEqual(reading, {
    kind: "frame",
    opcode: 0x1,
    offset: 2,
    length: 2,
  });
  assert.equal(
    validateServerFrame(Buffer.from([0x81, 0x02, 0x7b, 0x7d])),
    true,
  );
});

// ---------------------------------------------------------- the transport

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

/** Connect to a server that answers with `respond`, and read the fault. */
async function faultFrom(
  t: { skip: (why: string) => void },
  respond: (socket: Socket, request: string) => void,
): Promise<BridgeFault | undefined> {
  let server: ReturnType<typeof createServer>;
  let port: number;
  try {
    ({ server, port } = await listeningServer(respond));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("sandbox disallows loopback bind");
      return undefined;
    }
    throw error;
  }
  const fault = await new Promise<BridgeFault>((resolve, reject) => {
    const client = new LoopbackSocket(
      `ws://127.0.0.1:${port}/bridge`,
      "secret",
      {
        onOpen: () => undefined,
        onMessage: () => reject(new Error("an invalid frame was delivered")),
        onError: resolve,
        onClose: () => undefined,
      },
    );
    client.open();
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return fault;
}

test("a refused upgrade says the handshake was refused, not just that something failed", async (t) => {
  const fault = await faultFrom(t, (socket) => {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  if (!fault) return;
  assert.deepEqual(fault, { kind: "handshake", refusal: "upgrade_rejected" });
});

test("a masked server frame says so", async (t) => {
  const fault = await faultFrom(t, (socket, request) => {
    socket.write(handshake(request));
    socket.write(Buffer.from([0x81, 0x81, 0x01, 0, 0, 0, 0]));
  });
  if (!fault) return;
  assert.deepEqual(fault, {
    kind: "protocol",
    violation: "server_frame_masked",
  });
});

test("a reserved bit says so", async (t) => {
  const fault = await faultFrom(t, (socket, request) => {
    socket.write(handshake(request));
    socket.write(Buffer.from([0xc1, 0x01, 0x20]));
  });
  if (!fault) return;
  assert.deepEqual(fault, { kind: "protocol", violation: "reserved_bits_set" });
});

test("a socket that will not connect reports the errno", async (t) => {
  // Bind and close, so the port is real and nothing is behind it.
  let port: number;
  try {
    const { server, port: taken } = await listeningServer(() => undefined);
    port = taken;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("sandbox disallows loopback bind");
      return;
    }
    throw error;
  }
  const fault = await new Promise<BridgeFault>((resolve, reject) => {
    const client = new LoopbackSocket(
      `ws://127.0.0.1:${port}/bridge`,
      "secret",
      {
        onOpen: () => reject(new Error("a closed port accepted a connection")),
        onMessage: () => undefined,
        onError: resolve,
        onClose: () => undefined,
      },
    );
    client.open();
  });
  assert.equal(fault.kind, "transport");
  // Node's own code, which is the whole diagnostic — and never "unknown" here.
  assert.notEqual(fault.kind === "transport" ? fault.errno : "", "unknown");
});

// ------------------------------------------------------------ the session

test("a session that goes out of step says which way", () => {
  const session = () =>
    new BridgeSession({
      surfaceId: ids[0],
      extensionVersion: "0.1.0",
      workbenchInstanceId: ids[1],
      createMessageId: () => ids[2],
    });

  // Not JSON the contract accepts at all.
  const unparsable = session();
  unparsable.onSocketOpen();
  assert.deepEqual(unparsable.onHostFrame("{").fault, {
    kind: "session",
    reason: "frame_unparsable",
  });

  // A well-formed frame that is not an acceptable hello.
  const wrongHello = session();
  wrongHello.onSocketOpen();
  const rejected = wrongHello.onHostFrame(
    JSON.stringify({
      version: 1,
      connection_id: ids[3],
      sequence: 1,
      message_id: ids[2],
      kind: "hello_accepted",
      payload: {
        accepted_version: 1,
        surface_id: ids[1],
        connection_generation: 1,
      },
    }),
  );
  assert.deepEqual(rejected.fault, {
    kind: "session",
    reason: "handshake_frame_rejected",
  });
  assert.equal(rejected.close, true);
});

// --------------------------------------------------------- the controller

class FakeSocket implements ControllerSocket {
  public closed = false;
  public constructor(
    private readonly handlers: ControllerSocketHandlers,
    /** A socket that never comes up — what a reconnect loop is made of. */
    private readonly connects = true,
  ) {}
  public open(): void {
    if (this.connects) this.handlers.onOpen();
  }
  public send(): boolean {
    return !this.closed;
  }
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose();
  }
  public fail(fault: BridgeFault): void {
    this.handlers.onError(fault);
  }
}

test("the controller reports a fault once, keeps it, and drops it when the Bridge comes back", () => {
  const reported: BridgeFault[] = [];
  const sockets: FakeSocket[] = [];
  const scheduled: (() => void)[] = [];
  // The first connection comes up; every reconnect after it does not, which is
  // the shape of DevHub going away.
  let connects = true;
  const controller = new BridgeControllerCore(
    {
      endpoint: "ws://127.0.0.1:9123/bridge",
      token: "token",
      surfaceId: ids[0],
      extensionVersion: "0.1.0",
      workbenchInstanceId: ids[1],
      createMessageId: () => ids[2],
    },
    {
      createSocket: (_endpoint, _token, handlers) => {
        const socket = new FakeSocket(handlers, connects);
        sockets.push(socket);
        return socket;
      },
      context: () => ({ kind: "global" }),
      dirty: () => false,
      report: (fault) => reported.push(fault),
      schedule: (callback) => {
        scheduled.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => undefined,
    },
  );

  controller.start();
  assert.equal(controller.lastFault(), null);

  connects = false;
  const refused: BridgeFault = { kind: "transport", errno: "ECONNREFUSED" };
  sockets[0].fail(refused);
  assert.deepEqual(reported, [refused]);
  assert.deepEqual(controller.lastFault(), refused);

  // The reconnect loop raises the same one every few seconds. It is kept as
  // state and reported once: a report that repeats is one nobody reads.
  scheduled.pop()?.();
  sockets[1].fail(refused);
  assert.deepEqual(reported, [refused]);
  assert.deepEqual(controller.lastFault(), refused);

  // A different failure is news.
  const masked: BridgeFault = {
    kind: "protocol",
    violation: "server_frame_masked",
  };
  scheduled.pop()?.();
  sockets[2].fail(masked);
  assert.deepEqual(reported, [refused, masked]);

  // A connection that came up is the answer to whatever the last one failed
  // with, and nothing else retires a fault.
  connects = true;
  scheduled.pop()?.();
  assert.equal(controller.lastFault(), null);
});

// -------------------------------------------------------------- the words

test("every fault has a sentence, an identity, and a place to be shown", () => {
  const every: BridgeFault[] = [
    {
      kind: "config",
      variable: "DEVHUB_BRIDGE_TOKEN",
      refusal: "token_unsafe",
    },
    {
      kind: "config",
      variable: "DEVHUB_BRIDGE_ENDPOINT",
      refusal: "endpoint_not_loopback",
    },
    {
      kind: "config",
      variable: "DEVHUB_BRIDGE_SURFACE_REGISTRY",
      refusal: "registry_path_unsafe",
    },
    {
      kind: "config",
      variable: "DEVHUB_BRIDGE_ENDPOINT",
      refusal: "partially_injected",
    },
    { kind: "registry", refusal: "unreadable" },
    { kind: "registry", refusal: "unparsable" },
    { kind: "surface", folders: 0 },
    { kind: "surface", folders: 2 },
    { kind: "handshake", refusal: "upgrade_rejected" },
    { kind: "handshake", refusal: "headers_too_large" },
    { kind: "protocol", violation: "reserved_bits_set" },
    { kind: "protocol", violation: "server_frame_masked" },
    { kind: "protocol", violation: "frame_too_large", bytes: 1 },
    { kind: "protocol", violation: "control_frame_invalid", bytes: 200 },
    { kind: "protocol", violation: "unsupported_opcode" },
    { kind: "transport", errno: "ECONNREFUSED" },
    { kind: "session", reason: "frame_unparsable" },
    { kind: "session", reason: "handshake_frame_rejected" },
    { kind: "session", reason: "sequence_broken" },
    { kind: "session", reason: "unexpected_message" },
    { kind: "startup", reason: "surface context unavailable" },
  ];
  const identities = new Set<string>();
  for (const fault of every) {
    const sentence = describeFault(fault);
    assert.ok(sentence.startsWith("DevHub Bridge: "), sentence);
    assert.ok(sentence.length > 30, sentence);
    // No `undefined` leaking from a tag that has no sentence.
    assert.ok(!sentence.includes("undefined"), sentence);
    identities.add(faultIdentity(fault));
    // A boolean either way, but it must be a decision the union makes.
    assert.equal(typeof faultIsTransient(fault), "boolean");
  }
  // Two faults that are told apart in words are told apart in identity too,
  // or a reconnect loop would suppress a fault that is genuinely new.
  assert.equal(identities.size, every.length);

  // The reconnect-shaped ones stay on the status item; the ones that need a
  // person are said out loud.
  assert.equal(faultIsTransient({ kind: "transport", errno: "EPIPE" }), true);
  assert.equal(
    faultIsTransient({
      kind: "config",
      variable: "DEVHUB_BRIDGE_TOKEN",
      refusal: "token_unsafe",
    }),
    false,
  );
});
