import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvelope } from "../src/generated/bridge/index";
import type { Context } from "../src/generated/bridge/index";
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
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
];

class FakeSocket implements ControllerSocket {
  public readonly sent: string[] = [];
  public closed = false;
  private readonly handlers: ControllerSocketHandlers;

  public constructor(handlers: ControllerSocketHandlers) {
    this.handlers = handlers;
  }

  public open(): void {
    this.handlers.onOpen();
  }

  public send(raw: string): boolean {
    if (this.closed) return false;
    this.sent.push(raw);
    return true;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose();
  }

  public receive(raw: string): void {
    this.handlers.onMessage(raw);
  }
}

function accepted(
  socket: FakeSocket,
  connectionId: string,
  generation: number,
): void {
  socket.receive(
    JSON.stringify({
      version: 1,
      connection_id: connectionId,
      sequence: 1,
      message_id: ids[4],
      kind: "hello_accepted",
      payload: {
        accepted_version: 1,
        surface_id: ids[0],
        connection_generation: generation,
      },
    }),
  );
}

function config(workbenchInstanceId: string) {
  return {
    endpoint: "ws://127.0.0.1:9123/bridge",
    token: "token",
    surfaceId: ids[0],
    extensionVersion: "0.1.0",
    workbenchInstanceId,
    createMessageId: (() => {
      let index = 0;
      return () => ids[(index++ + 1) % ids.length];
    })(),
  };
}

test("controller aggregates observations, public requests, host requests, and reconnect state", () => {
  let context: Context = { kind: "global" };
  let dirty = false;
  const sockets: FakeSocket[] = [];
  const scheduled: (() => void)[] = [];
  const controller = new BridgeControllerCore(config(ids[2]), {
    createSocket: (_endpoint, _token, handlers) => {
      const socket = new FakeSocket(handlers);
      sockets.push(socket);
      return socket;
    },
    context: () => context,
    dirty: () => dirty,
    schedule: (callback) => {
      scheduled.push(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => undefined,
  });

  controller.start();
  assert.equal(sockets.length, 1);
  assert.equal(parseEnvelope(sockets[0].sent[0]).kind, "hello");
  accepted(sockets[0], ids[3], 1);
  assert.equal(parseEnvelope(sockets[0].sent[1]).kind, "state_snapshot");

  dirty = true;
  controller.observeDirty();
  assert.equal(parseEnvelope(sockets[0].sent[2]).kind, "dirty_changed");
  context = {
    kind: "workspace",
    workspace_id: ids[1] as never,
    canonical_root: "/work/project" as never,
  };
  controller.observeWorkspace();
  assert.equal(parseEnvelope(sockets[0].sent[3]).kind, "identity_changed");

  controller.openFolder("/work/other");
  controller.newWindow(null);
  assert.ok(sockets[0].sent[4], JSON.stringify(sockets[0].sent));
  assert.ok(sockets[0].sent[5], JSON.stringify(sockets[0].sent));
  assert.equal(
    parseEnvelope(sockets[0].sent[4]).kind,
    "open_workspace_requested",
  );
  assert.equal(parseEnvelope(sockets[0].sent[5]).kind, "new_window_requested");

  sockets[0].receive(
    JSON.stringify({
      version: 1,
      connection_id: ids[3],
      sequence: 2,
      message_id: ids[5],
      kind: "focus",
      payload: { reason: "navigation" },
    }),
  );
  assert.ok(sockets[0].sent[6], JSON.stringify(sockets[0].sent));
  assert.equal(parseEnvelope(sockets[0].sent[6]).kind, "response");
  sockets[0].close();
  assert.equal(scheduled.length, 1);
  scheduled.shift()?.();
  assert.equal(sockets.length, 2);
  assert.ok(sockets[1].sent[0], JSON.stringify(sockets[1].sent));
  assert.notEqual(parseEnvelope(sockets[1].sent[0]).kind, "state_snapshot");
  accepted(sockets[1], ids[6], 2);
  assert.ok(sockets[1].sent[1], JSON.stringify(sockets[1].sent));
  assert.equal(parseEnvelope(sockets[1].sent[1]).kind, "state_snapshot");
  sockets[1].receive(
    JSON.stringify({
      version: 1,
      connection_id: ids[6],
      sequence: 2,
      message_id: ids[5],
      kind: "focus",
      payload: { reason: "navigation" },
    }),
  );
  assert.ok(sockets[1].sent[2], JSON.stringify(sockets[1].sent));
  const replay = parseEnvelope(sockets[1].sent[2]);
  assert.equal(replay.kind, "response");
  assert.equal(replay.connection_id, ids[6]);

  context = null as unknown as Context;
  sockets[1].close();
  assert.equal(scheduled.length, 0);
  context = { kind: "global" };
  controller.observeWorkspace();
  assert.equal(sockets.length, 3);
  assert.ok(sockets[2].sent[0], JSON.stringify(sockets[2].sent));
  assert.equal(parseEnvelope(sockets[2].sent[0]).kind, "hello");
});

test("each activation receives its own workbench identity", () => {
  const helloIds: string[] = [];
  for (const workbenchInstanceId of [ids[2], ids[3]]) {
    const controller = new BridgeControllerCore(config(workbenchInstanceId), {
      createSocket: (_endpoint, _token, handlers) => ({
        open: () => handlers.onOpen(),
        send: (raw) => {
          helloIds.push(
            (parseEnvelope(raw).payload as { workbench_instance_id?: string })
              .workbench_instance_id ?? "",
          );
          return true;
        },
        close: () => handlers.onClose(),
      }),
      context: () => ({ kind: "global" }),
      dirty: () => false,
    });
    controller.start();
  }
  assert.deepEqual(helloIds, [ids[2], ids[3]]);
});
