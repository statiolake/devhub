import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  attributesFor,
  autoForwardAction,
  labelFor,
  makeTunnelFactory,
  requestForwardPort,
  requiresLocalPort,
  type HeldForward,
  type PortsConfiguration,
} from "../src/ports";

const scratch = await mkdtemp(join(tmpdir(), "devhub-ports-"));
after(() => rm(scratch, { recursive: true, force: true }));

/** A DevHub that answers one forward and keeps the connection. */
async function fakeDevHub(answer: object): Promise<{
  path: string;
  asked: object[];
  held: Socket[];
  close: () => void;
}> {
  const path = join(scratch, `c${String(Math.random()).slice(2, 8)}.sock`);
  const asked: object[] = [];
  const held: Socket[] = [];
  const server = createServer((socket) => {
    held.push(socket);
    socket.setEncoding("utf8");
    socket.on("data", (line: string) => {
      asked.push(JSON.parse(line.trim()) as object);
      socket.write(`${JSON.stringify(answer)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, asked, held, close: () => server.close() };
}

test("a forward is asked for once and held open", async () => {
  const devhub = await fakeDevHub({
    ok: true,
    message: "127.0.0.1:4000",
    forward: { localPort: 4000 },
  });
  const forward = await requestForwardPort(
    devhub.path,
    "container:ab",
    "localhost",
    3000,
    3000,
    false,
  );
  strictEqual(forward.localPort, 4000);
  deepStrictEqual(devhub.asked, [
    {
      kind: "forward-port",
      machine: "container:ab",
      host: "localhost",
      port: 3000,
      localPort: 3000,
    },
  ]);
  let ended = false;
  forward.onClosed(() => {
    ended = true;
  });
  // DevHub ending the connection ends the forward.
  devhub.held[0]?.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  strictEqual(ended, true);
  devhub.close();
});

test("a refused forward rejects with DevHub's sentence", async () => {
  const devhub = await fakeDevHub({
    ok: false,
    message: "Local port 3000 is already in use.",
  });
  await rejects(
    requestForwardPort(
      devhub.path,
      "container:ab",
      "localhost",
      3000,
      3000,
      true,
    ),
    /already in use/u,
  );
  devhub.close();
});

test("the tunnel factory builds a tunnel that disposes once", async () => {
  let closed = 0;
  let fired = 0;
  let onClosed: (() => void) | undefined;
  const held: HeldForward = {
    localPort: 4001,
    close: () => {
      closed++;
      onClosed?.();
    },
    onClosed: (listener) => {
      onClosed = listener;
    },
  };
  const asked: string[] = [];
  const factory = makeTunnelFactory(
    {
      emitter: () => ({
        event: "event",
        fire: () => {
          fired++;
        },
        dispose: () => {},
      }),
    },
    (host, port, localPort, required) => {
      asked.push(
        `${host}:${String(port)} ${String(localPort)} ${String(required)}`,
      );
      return Promise.resolve(held);
    },
    (port) => port === 3000,
  );
  const tunnel = await factory({
    remoteAddress: { host: "localhost", port: 3000 },
    localAddressPort: 3000,
  });
  deepStrictEqual(asked, ["localhost:3000 3000 true"]);
  deepStrictEqual(tunnel.localAddress, { host: "localhost", port: 4001 });
  deepStrictEqual(tunnel.remoteAddress, { host: "localhost", port: 3000 });
  tunnel.dispose();
  tunnel.dispose();
  strictEqual(closed, 2);
  strictEqual(fired, 1);
});

const config: PortsConfiguration = {
  forwardPorts: [{ host: "localhost", port: 3000 }],
  portsAttributes: {
    "3000": {
      label: "Web",
      onAutoForward: "openBrowser",
      requireLocalPort: true,
    },
    "9000-9100": { onAutoForward: "ignore" },
    "node.+server\\.js": { onAutoForward: "silent" },
  },
  otherPortsAttributes: { onAutoForward: "notify" },
};

test("portsAttributes match by port, by range, and by command line", () => {
  strictEqual(labelFor(config, 3000), "Web");
  strictEqual(autoForwardAction(attributesFor(config, 3000)), 2);
  strictEqual(autoForwardAction(attributesFor(config, 9050)), 5);
  strictEqual(
    autoForwardAction(attributesFor(config, 8000, "node /app/server.js")),
    4,
  );
  strictEqual(autoForwardAction(attributesFor(config, 8000, "python")), 1);
  strictEqual(requiresLocalPort(config, 3000), true);
  strictEqual(requiresLocalPort(config, 8000), false);
  strictEqual(requiresLocalPort(undefined, 3000), false);
  strictEqual(autoForwardAction(undefined), undefined);
});
