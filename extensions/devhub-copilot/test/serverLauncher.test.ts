import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isSupportedNode,
  languageServerEntry,
  resolveLanguageServerLaunch,
} from "../src/serverLauncher";

async function stagedExtension(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devhub-copilot-"));
  await mkdir(join(root, "server"));
  await writeFile(languageServerEntry(root), "");
  return root;
}

test("the server's own minimum Node is the one checked", () => {
  assert.equal(isSupportedNode("22.12.9"), false);
  assert.equal(isSupportedNode("22.13.0"), true);
  assert.equal(isSupportedNode("24.1.0"), true);
  assert.equal(isSupportedNode("20.19.0"), false);
});

test("in Electron the server is run by the same binary in its Node mode", async () => {
  const root = await stagedExtension();
  try {
    const launch = resolveLanguageServerLaunch(root, {
      execPath: "/Applications/DevHub.app/Contents/MacOS/DevHub",
      versions: {
        node: "24.6.0",
        electron: "43.7.7",
      } as NodeJS.ProcessVersions,
      env: { HOME: "/Users/someone" },
    });
    assert.equal(
      launch.command,
      "/Applications/DevHub.app/Contents/MacOS/DevHub",
    );
    assert.deepEqual(launch.args, [languageServerEntry(root), "--stdio"]);
    assert.deepEqual(launch.env, {
      HOME: "/Users/someone",
      ELECTRON_RUN_AS_NODE: "1",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain Node needs no switch", async () => {
  const root = await stagedExtension();
  try {
    const launch = resolveLanguageServerLaunch(root, {
      execPath: "/usr/bin/node",
      versions: { node: "22.20.0" } as NodeJS.ProcessVersions,
      env: {},
    });
    assert.equal(launch.env, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unstaged server and an old Node are refused with the reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "devhub-copilot-"));
  try {
    assert.throws(
      () => resolveLanguageServerLaunch(root),
      /not staged.*pnpm --filter devhub-copilot build/u,
    );
    await mkdir(join(root, "server"));
    await writeFile(languageServerEntry(root), "");
    assert.throws(
      () =>
        resolveLanguageServerLaunch(root, {
          execPath: "/usr/bin/node",
          versions: { node: "20.19.0" } as NodeJS.ProcessVersions,
          env: {},
        }),
      /needs Node 22\.13/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
