import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { after, test } from "node:test";
import { requestResolveRemote, type ResolveRemoteAnswer } from "../src/control";
import {
  machineFromAuthority,
  resolveRemote,
  type ResolverApi,
} from "../src/resolveRemote";

/**
 * The `vscode` stand-in.
 *
 * The real module exists only inside an extension host, so it cannot be
 * imported here — but the resolver never imports it either: it takes the three
 * things it needs as {@link ResolverApi}, and `src/extension.ts` is the one
 * place the real `vscode.ResolvedAuthority` and
 * `vscode.RemoteAuthorityResolverError` are named. This fake is that same
 * surface with the two error constructors kept apart by class, because which
 * of the two the resolver chose is the whole decision under test: VS Code
 * retries one and gives up on the other.
 */
class NotAvailable extends Error {}
class TemporarilyNotAvailable extends Error {}

interface Authority {
  host: string;
  port: number;
  connectionToken: string;
}

const api: ResolverApi = {
  resolved: (host, port, connectionToken): Authority => ({
    host,
    port,
    connectionToken,
  }),
  notAvailable: (message) => new NotAvailable(message),
  temporarilyNotAvailable: (message) => new TemporarilyNotAvailable(message),
};

const directories: string[] = [];
const servers: Server[] = [];
after(async () => {
  for (const server of servers)
    await new Promise<void>((done) => server.close(() => done()));
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});

/** A real unix socket standing in for the running DevHub. */
async function devhub(
  answer: ResolveRemoteAnswer,
  seen: string[] = [],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "devhub-remote-test-"));
  directories.push(directory);
  const path = resolvePath(directory, "control.sock");
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      seen.push(chunk);
      socket.end(`${JSON.stringify(answer)}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(path, done));
  return path;
}

/** A directory with no socket in it: DevHub is not listening. */
async function nothingListening(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "devhub-remote-test-"));
  directories.push(directory);
  return resolvePath(directory, "control.sock");
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the resolver resolved where it had to fail");
}

test("an ssh-remote authority names the machine DevHub spells", () => {
  strictEqual(machineFromAuthority("ssh-remote+myhost"), "ssh:myhost");
  // The host is an ssh host alias taken whole — dots, dashes and all.
  strictEqual(
    machineFromAuthority("ssh-remote+build.box-1"),
    "ssh:build.box-1",
  );
});

/** What `encodeContainerAuthority` in `model/domain.ts` writes. */
function containerPayload(fields: Record<string, string>): string {
  let hex = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(fields))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

test("a dev-container authority names the container by its payload", () => {
  // The container is named by main's own spelling of "this folder, with this
  // definition" — the key its container hosts are filed under — so it is
  // passed through whole rather than taken apart and put back together here.
  const payload = containerPayload({
    hostPath: "/src/api (copy)/wörk",
    configPath: "/src/api (copy)/wörk/.devcontainer/devcontainer.json",
  });
  strictEqual(
    machineFromAuthority(`dev-container+${payload}`),
    `container:${payload}`,
  );
  const onHost = containerPayload({
    hostPath: "/srv/api",
    configPath: "/srv/api/.devcontainer/python/devcontainer.json",
    sshHost: "build",
  });
  strictEqual(
    machineFromAuthority(`dev-container+${onHost}`),
    `container:${onHost}`,
  );
});

test("a dev-container authority without its definition names no container", () => {
  // An authority from before the definition was carried in it is one this
  // DevHub did not write: which container it means would be a guess.
  strictEqual(
    machineFromAuthority(
      `dev-container+${containerPayload({ hostPath: "/src/api" })}`,
    ),
    null,
  );
});

test("a malformed authority names no machine", () => {
  strictEqual(machineFromAuthority("ssh-remote"), null);
  strictEqual(machineFromAuthority("ssh-remote+"), null);
  strictEqual(machineFromAuthority("wsl+ubuntu"), null);
  // A container payload that is not hex, is a half byte, is not JSON, or is
  // JSON without a host path, is an authority this DevHub did not write — and
  // that is "no machine", the same answer as somebody else's scheme, rather
  // than a crash in the middle of opening a window.
  strictEqual(machineFromAuthority("dev-container+"), null);
  strictEqual(machineFromAuthority("dev-container+zz"), null);
  strictEqual(machineFromAuthority("dev-container+abc"), null);
  strictEqual(machineFromAuthority("dev-container+6162"), null);
  strictEqual(machineFromAuthority("dev-container+7b7d"), null);
});

test("a malformed authority is a permanent failure", async () => {
  const error = await rejection(
    resolveRemote(
      api,
      requestResolveRemote,
      await nothingListening(),
      "ssh-remote+",
      1,
    ),
  );
  ok(error instanceof NotAvailable);
});

test("DevHub is asked with exactly the documented request line", async () => {
  const seen: string[] = [];
  const socketPath = await devhub(
    {
      ok: true,
      message: "connected",
      remote: { port: 41234, connectionToken: "token" },
    },
    seen,
  );
  await resolveRemote(
    api,
    requestResolveRemote,
    socketPath,
    "ssh-remote+myhost",
    3,
  );
  deepStrictEqual(seen, [
    '{"kind":"resolve-remote","machine":"ssh:myhost","attempt":3}\n',
  ]);
});

test("an endpoint becomes a resolved authority on the loopback", async () => {
  const socketPath = await devhub({
    ok: true,
    message: "connected",
    remote: { port: 41234, connectionToken: "token" },
  });
  const resolved = await resolveRemote(
    api,
    requestResolveRemote,
    socketPath,
    "ssh-remote+myhost",
    1,
  );
  deepStrictEqual(resolved, {
    host: "127.0.0.1",
    port: 41234,
    connectionToken: "token",
  });
  // Absent unless main sent one: an empty env is not the same as no env.
  ok(!("extensionHostEnv" in resolved));
});

/**
 * `SSH_AUTH_SOCK` is what main puts there when the host has an agent
 * forwarded. The resolver does not decide it; it has to arrive unchanged.
 */
test("an extension host environment is carried through", async () => {
  const socketPath = await devhub({
    ok: true,
    message: "connected",
    remote: {
      port: 41234,
      connectionToken: "token",
      extensionHostEnv: { SSH_AUTH_SOCK: "/run/agent.sock", STALE: null },
    },
  });
  const resolved = await resolveRemote(
    api,
    requestResolveRemote,
    socketPath,
    "ssh-remote+myhost",
    1,
  );
  deepStrictEqual(resolved, {
    host: "127.0.0.1",
    port: 41234,
    connectionToken: "token",
    extensionHostEnv: { SSH_AUTH_SOCK: "/run/agent.sock", STALE: null },
  });
});

test("a transient failure is one VS Code will retry, in DevHub's words", async () => {
  const socketPath = await devhub({
    ok: false,
    message: "myhost is not answering; it may be asleep.",
    retry: true,
  });
  const error = await rejection(
    resolveRemote(
      api,
      requestResolveRemote,
      socketPath,
      "ssh-remote+myhost",
      1,
    ),
  );
  ok(error instanceof TemporarilyNotAvailable);
  strictEqual(error.message, "myhost is not answering; it may be asleep.");
});

test("a failure with no retry flag is permanent, in DevHub's words", async () => {
  const socketPath = await devhub({
    ok: false,
    message: "DevHub knows no host called myhost.",
  });
  const error = await rejection(
    resolveRemote(
      api,
      requestResolveRemote,
      socketPath,
      "ssh-remote+myhost",
      1,
    ),
  );
  ok(error instanceof NotAvailable);
  strictEqual(error.message, "DevHub knows no host called myhost.");
});

test("retry: false is permanent too", async () => {
  const socketPath = await devhub({
    ok: false,
    message: "No remote server is published for that architecture.",
    retry: false,
  });
  const error = await rejection(
    resolveRemote(
      api,
      requestResolveRemote,
      socketPath,
      "ssh-remote+myhost",
      1,
    ),
  );
  ok(error instanceof NotAvailable);
});

/** DevHub may simply not be up yet, so this is worth coming back for. */
test("a DevHub that cannot be reached is temporary", async () => {
  const error = await rejection(
    resolveRemote(
      api,
      requestResolveRemote,
      await nothingListening(),
      "ssh-remote+myhost",
      1,
    ),
  );
  ok(error instanceof TemporarilyNotAvailable);
});

test("a workbench outside DevHub has no DevHub to ask", async () => {
  const error = await rejection(
    resolveRemote(api, requestResolveRemote, null, "ssh-remote+myhost", 1),
  );
  ok(error instanceof NotAvailable);
});

/**
 * `ok` and `message` are on every control answer, so an `ok` one whose
 * `remote` is missing or malformed is a bug on main's side, not something to
 * retry into forever.
 */
test("an ok answer with no endpoint names the problem and does not retry", async () => {
  for (const remote of [
    undefined,
    { connectionToken: "token" } as unknown as {
      port: number;
      connectionToken: string;
    },
    { port: "41234", connectionToken: "token" } as unknown as {
      port: number;
      connectionToken: string;
    },
    { port: 41234 } as unknown as { port: number; connectionToken: string },
  ]) {
    const socketPath = await devhub({ ok: true, message: "connected", remote });
    const error = await rejection(
      resolveRemote(
        api,
        requestResolveRemote,
        socketPath,
        "ssh-remote+myhost",
        1,
      ),
    );
    ok(error instanceof NotAvailable);
    ok(error.message.includes("without an endpoint"));
    ok(error.message.includes("ssh:myhost"));
  }
});
