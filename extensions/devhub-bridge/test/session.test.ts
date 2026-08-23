import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvelope } from "../../../apps/devhub/src/generated/bridge/index";
import { BridgeSession } from "../src/session";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
];

function session(): BridgeSession {
  let index = 0;
  return new BridgeSession({
    surfaceId: ids[0],
    extensionVersion: "0.1.0",
    workbenchInstanceId: ids[2],
    createMessageId: () => ids[(index++ + 3) % ids.length],
  });
}

function accepted(
  sessionValue: BridgeSession,
  connectionId = ids[3],
  generation = 1,
): string[] {
  const hello = sessionValue.onSocketOpen().frames[0];
  const helloEnvelope = JSON.parse(hello) as Record<string, unknown>;
  assert.equal(helloEnvelope.kind, "hello");
  return sessionValue.onHostFrame(
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
  ).frames;
}

test("handshake emits generated-contract-valid hello and snapshot", () => {
  const value = session();
  const snapshot = accepted(value);
  assert.equal(snapshot.length, 1);
  assert.equal(parseEnvelope(snapshot[0]).kind, "state_snapshot");
  assert.equal(value.isConnected, true);
});

test("host request is answered once and exact duplicate replays the cached frame", () => {
  const value = session();
  accepted(value);
  const request = JSON.stringify({
    version: 1,
    connection_id: ids[3],
    sequence: 2,
    message_id: ids[5],
    kind: "focus",
    payload: { reason: "navigation" },
  });
  const first = value.onHostFrame(request);
  const second = value.onHostFrame(request);
  assert.equal(first.frames.length, 1);
  assert.deepEqual(second.frames, first.frames);
});

test("cross-generation request replay re-encodes the current connection and snapshot", () => {
  const value = session();
  accepted(value);
  const request = (connectionId: string, sequence: number) =>
    JSON.stringify({
      version: 1,
      connection_id: connectionId,
      sequence,
      message_id: ids[5],
      kind: "request_state_snapshot",
      payload: { reason: "host_reconcile" },
    });
  const first = value.onHostFrame(request(ids[3], 2));
  assert.equal(first.frames.length, 2);
  value.onSocketClosed();
  value.onSocketOpen();
  accepted(value, ids[1], 2);
  const replay = value.onHostFrame(request(ids[1], 2));
  assert.equal(replay.frames.length, 2);
  assert.equal(parseEnvelope(replay.frames[0]).connection_id, ids[1]);
  assert.equal(parseEnvelope(replay.frames[1]).kind, "state_snapshot");
});

test("sequence gaps, identity mismatches, and generation regressions close the session", () => {
  const value = session();
  accepted(value);
  const gap = value.onHostFrame(
    JSON.stringify({
      version: 1,
      connection_id: ids[3],
      sequence: 4,
      message_id: ids[5],
      kind: "focus",
      payload: { reason: "navigation" },
    }),
  );
  assert.equal(gap.close, true);

  const reconnect = session();
  accepted(reconnect);
  reconnect.onSocketClosed();
  reconnect.onSocketOpen();
  const stale = reconnect.onHostFrame(
    JSON.stringify({
      version: 1,
      connection_id: ids[3],
      sequence: 1,
      message_id: ids[4],
      kind: "hello_accepted",
      payload: {
        accepted_version: 1,
        surface_id: ids[0],
        connection_generation: 1,
      },
    }),
  );
  assert.equal(stale.close, true);
});

test("dirty and identity observations are coalesced and safe without content", () => {
  const value = session();
  accepted(value);
  assert.equal(value.sendDirty(false), null);
  assert.notEqual(value.sendDirty(true), null);
  assert.equal(value.sendDirty(true), null);
  const nextContext = {
    kind: "workspace",
    workspace_id: ids[1],
    canonical_root: "/devhub",
  } as const;
  assert.notEqual(value.sendIdentity(nextContext as never), null);
  assert.equal(value.sendIdentity(nextContext as never), null);
});

test("oversized host frames are rejected before JSON parsing", () => {
  const value = session();
  const result = value.onHostFrame("x".repeat(262_145));
  assert.equal(result.close, true);
});
