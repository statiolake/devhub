import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
  controlSocketFromGlobalStorage,
  requestResolveRemote,
} from "../src/control";

/**
 * The derivation mirrors `userDataPathFromGlobalStorage` and
 * `controlSocketPath` in `apps/desktop/src/main/cli/protocol.ts`. Both layouts
 * VS Code uses for global storage have to land on the same user-data
 * directory, because a person on a non-default profile is not a different
 * DevHub.
 */
test("the control socket is derived from either global-storage layout", () => {
  strictEqual(
    controlSocketFromGlobalStorage(
      "/data/editor/User/globalStorage/devhub.remote",
    ),
    "/data/editor/devhub/control.sock",
  );
  strictEqual(
    controlSocketFromGlobalStorage(
      "/data/editor/User/profiles/abc/globalStorage/devhub.remote",
    ),
    "/data/editor/devhub/control.sock",
  );
});

test("a path with no User segment names no DevHub", () => {
  strictEqual(
    controlSocketFromGlobalStorage("/data/editor/globalStorage"),
    null,
  );
  strictEqual(controlSocketFromGlobalStorage("/User/globalStorage"), null);
});

const directories: string[] = [];
after(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});

async function socketDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "devhub-remote-test-"));
  directories.push(directory);
  return directory;
}

/**
 * The request line is a contract with `apps/desktop/src/main/cli/protocol.ts`:
 * main reads exactly this, so the test asserts the bytes and not a parse of
 * them.
 */
test("the request is one line of JSON naming the machine and the attempt", async () => {
  const directory = await socketDirectory();
  const path = resolve(directory, "control.sock");
  const seen: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      seen.push(chunk);
      socket.end(
        `${JSON.stringify({
          ok: true,
          message: "connected",
          remote: { port: 41234, connectionToken: "token" },
        })}\n`,
      );
    });
  });
  await new Promise<void>((done) => server.listen(path, done));
  try {
    const answer = await requestResolveRemote(path, "ssh:myhost", 2);
    deepStrictEqual(seen, [
      '{"kind":"resolve-remote","machine":"ssh:myhost","attempt":2}\n',
    ]);
    strictEqual(answer.remote?.port, 41234);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("a socket nobody is listening on rejects", async () => {
  const directory = await socketDirectory();
  await new Promise<void>((done, fail) => {
    requestResolveRemote(
      resolve(directory, "control.sock"),
      "ssh:myhost",
      1,
    ).then(
      () => fail(new Error("a missing DevHub must not answer")),
      () => done(),
    );
  });
});

test("a connection closed without an answer rejects", async () => {
  const directory = await socketDirectory();
  const path = resolve(directory, "control.sock");
  const server = createServer((socket) => {
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(path, done));
  try {
    await new Promise<void>((done, fail) => {
      requestResolveRemote(path, "ssh:myhost", 1).then(
        () => fail(new Error("an empty answer must not resolve")),
        () => done(),
      );
    });
  } finally {
    server.close();
  }
});
