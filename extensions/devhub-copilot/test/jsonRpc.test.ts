import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { JsonRpcConnection, RequestCancelledError } from "../src/jsonRpc";

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"),
    body,
  ]);
}

function readFrames(buffer: Buffer): unknown[] {
  const messages: unknown[] = [];
  let current = buffer;
  while (current.length > 0) {
    const separator = current.indexOf("\r\n\r\n");
    if (separator < 0) {
      break;
    }
    const header = current.subarray(0, separator).toString("ascii");
    const length = Number.parseInt(header.split(":", 2)[1]!.trim(), 10);
    const start = separator + 4;
    if (current.length < start + length) {
      break;
    }
    messages.push(
      JSON.parse(
        current.subarray(start, start + length).toString("utf8"),
      ) as unknown,
    );
    current = current.subarray(start + length);
  }
  return messages;
}

function createToken(): {
  token: {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => unknown): { dispose(): void };
  };
  cancel(): void;
} {
  let cancelled = false;
  const listeners = new Set<() => unknown>();
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    cancel() {
      cancelled = true;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

test("writes and parses UTF-8 LSP frames, including fragmented input", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection(input, output, {
    requestTimeoutMs: 500,
  });
  let written = Buffer.alloc(0);
  output.on("data", (chunk: Buffer) => {
    written = Buffer.concat([written, chunk]);
  });

  const resultPromise = connection.request<{ ok: boolean }>("example", {
    text: "日本語😀",
  });
  const request = readFrames(written)[0] as {
    id: number;
    method: string;
    params: { text: string };
  };
  assert.equal(request.method, "example");
  assert.equal(request.params.text, "日本語😀");

  const response = frame({
    jsonrpc: "2.0",
    id: request.id,
    result: { ok: true },
  });
  input.write(response.subarray(0, 3));
  input.write(response.subarray(3));
  assert.deepEqual(await resultPromise, { ok: true });
  connection.dispose();
});

test("propagates cancellation through $/cancelRequest", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection(input, output, {
    requestTimeoutMs: 500,
  });
  let written = Buffer.alloc(0);
  output.on("data", (chunk: Buffer) => {
    written = Buffer.concat([written, chunk]);
  });
  const cancellation = createToken();
  const requestPromise = connection.request("inline", {}, cancellation.token);
  cancellation.cancel();

  await assert.rejects(
    requestPromise,
    (error: unknown) => error instanceof RequestCancelledError,
  );
  const messages = readFrames(written) as Array<{ method: string }>;
  assert.deepEqual(
    messages.map((message) => message.method),
    ["inline", "$/cancelRequest"],
  );
  connection.dispose();
});

test("does not send a request when cancellation was already requested", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection(input, output, {
    requestTimeoutMs: 500,
  });
  let written = Buffer.alloc(0);
  output.on("data", (chunk: Buffer) => {
    written = Buffer.concat([written, chunk]);
  });
  const cancellation = createToken();
  cancellation.cancel();
  await assert.rejects(
    connection.request("inline", {}, cancellation.token),
    (error: unknown) => error instanceof RequestCancelledError,
  );
  assert.equal(written.length, 0);
  connection.dispose();
});

test("answers server requests and forwards notifications", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const notifications: string[] = [];
  const connection = new JsonRpcConnection(input, output, {
    requestHandler: (method) => ({ method }),
    notificationHandler: (method) => notifications.push(method),
  });
  let written = Buffer.alloc(0);
  output.on("data", (chunk: Buffer) => {
    written = Buffer.concat([written, chunk]);
  });

  input.write(frame({ jsonrpc: "2.0", method: "status" }));
  input.write(
    frame({ jsonrpc: "2.0", id: 9, method: "configuration", params: {} }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, ["status"]);
  assert.deepEqual(readFrames(written), [
    { jsonrpc: "2.0", id: 9, result: { method: "configuration" } },
  ]);
  connection.dispose();
});
