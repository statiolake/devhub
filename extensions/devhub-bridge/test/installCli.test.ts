import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
  controlSocketFromGlobalStorage,
  requestInstall,
} from "../src/installCli";

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
      "/data/editor/User/globalStorage/devhub.bridge",
    ),
    "/data/editor/devhub/control.sock",
  );
  strictEqual(
    controlSocketFromGlobalStorage(
      "/data/editor/User/profiles/abc/globalStorage/devhub.bridge",
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
  const directory = await mkdtemp(join(tmpdir(), "devhub-bridge-test-"));
  directories.push(directory);
  return directory;
}

test("the request is one line of JSON and the answer is DevHub's", async () => {
  const directory = await socketDirectory();
  const path = resolve(directory, "control.sock");
  const seen: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      seen.push(chunk);
      socket.end(`${JSON.stringify({ ok: true, message: "installed" })}\n`);
    });
  });
  await new Promise<void>((done) => server.listen(path, done));
  try {
    const answer = await requestInstall(path);
    deepStrictEqual(answer, { ok: true, message: "installed" });
    deepStrictEqual(seen, ['{"kind":"install-cli"}\n']);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

/**
 * The failure a person has to be told about: DevHub is not there. It must
 * reject rather than resolve to something that looks like an answer.
 */
test("a socket nobody is listening on rejects", async () => {
  const directory = await socketDirectory();
  await new Promise<void>((done, fail) => {
    requestInstall(resolve(directory, "control.sock")).then(
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
      requestInstall(path).then(
        () => fail(new Error("an empty answer must not resolve")),
        () => done(),
      );
    });
  } finally {
    server.close();
  }
});
