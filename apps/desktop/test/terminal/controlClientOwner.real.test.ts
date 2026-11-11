/**
 * A tmux control client ends with the process that started it, however that
 * process ends: real processes, a real (bundled) tmux, the real helper.
 *
 * The pty host starts every `tmux -C attach-session` on pipes, and its stdin
 * closing was what was to end it. tmux does not always let it go: a client
 * the server still has output queued for when its reader goes away is never
 * told to exit (`server_client_check_exit` waits for `control_all_done`), and
 * such clients stayed attached, at their size, after the pty host was gone.
 * So the clients are started through `devhub-exec-clean --die-with`
 * (`ownedSpawnArgs`), and the kernel ends them with their owner.
 *
 * The owner here is a Node process that starts the client the way the pty
 * host does (`ptyHost/entry.ts`), on pipes, and never reads its stdout, so
 * the server has output queued for it — the case tmux gets wrong — before
 * the owner is SIGKILLed: nothing of the owner's runs at its end.
 */

import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TMUX, killTmuxServer } from "../tmuxSockets";
import {
  ownedSpawnArgs,
  setExecCleanHelper,
} from "../../src/main/terminal/cleanSpawn";

const SOURCE = fileURLToPath(
  new URL("../../src/main/native/execClean.c", import.meta.url),
);
const supported = process.platform === "linux" || process.platform === "darwin";
const compiler = supported && spawnSync("cc", ["--version"]).status === 0;

/** How long a client may outlive its owner. */
const BOUND_MS = 3_000;

/**
 * The owner: told what to run on its stdin (one JSON line), it starts that on
 * pipes, says the child's pid, and then holds the pipes without reading.
 */
const OWNER = `
const { spawn } = require("node:child_process");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  const end = input.indexOf("\\n");
  if (end < 0) return;
  const { file, args } = JSON.parse(input.slice(0, end));
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.pause();
  child.stdin.write("refresh-client -C 120x40\\n");
  process.stdout.write(String(child.pid) + "\\n");
});
setInterval(() => undefined, 60_000);
`;

function alive(pid: number): boolean {
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  // A zombie has ended; only its parent's reaping is left.
  return state !== "" && !state.startsWith("Z");
}

async function until(
  test: () => boolean,
  ms: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(TMUX === undefined || !compiler)(
  "a tmux control client and the process that started it",
  () => {
    let directory: string;
    const socket = `owner-${String(process.pid)}`;
    const owners: ChildProcess[] = [];
    const clients: number[] = [];

    const tmux = (...args: string[]): string =>
      execFileSync(TMUX as string, ["-L", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, LANG: "C.UTF-8" },
      });

    beforeAll(() => {
      directory = mkdtempSync(join(tmpdir(), "devhub-owner-"));
      const helper = join(directory, "devhub-exec-clean");
      const built = spawnSync("cc", [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-o",
        helper,
        SOURCE,
      ]);
      expect(built.status, built.stderr.toString()).toBe(0);
      setExecCleanHelper(helper);
    });

    afterEach(() => {
      for (const owner of owners.splice(0)) owner.kill("SIGKILL");
      for (const pid of clients.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone, as it should be.
        }
      }
      killTmuxServer(socket);
    });

    afterAll(() => {
      setExecCleanHelper(undefined);
      rmSync(directory, { recursive: true, force: true });
    });

    /** An owner with one attached control client; the client's pid. */
    async function ownerWithClient(): Promise<{
      owner: ChildProcess;
      client: number;
    }> {
      const owner = spawn(process.execPath, ["-e", OWNER], {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, LANG: "C.UTF-8" },
      });
      owners.push(owner);
      const owned = ownedSpawnArgs(
        TMUX as string,
        ["-L", socket, "-f", "/dev/null", "-C", "attach-session", "-t", "busy"],
        undefined,
        process.env,
        owner.pid,
      );
      expect(owned.args.slice(0, 2)).toEqual(["--die-with", String(owner.pid)]);
      const said = new Promise<number>((resolve) => {
        let out = "";
        owner.stdout?.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes("\n")) resolve(Number(out.trim()));
        });
      });
      owner.stdin?.write(`${JSON.stringify(owned)}\n`);
      const client = await said;
      clients.push(client);
      await until(
        () =>
          tmux("list-clients", "-F", "#{client_pid}")
            .split("\n")
            .includes(String(client)),
        5_000,
        "the client attached",
      );
      return { owner, client };
    }

    it("ends within the bound when its owner is SIGKILLed with output queued for it", async () => {
      // A pane that never stops writing: the server always has output for
      // a client that has stopped reading.
      tmux(
        "new-session",
        "-d",
        "-s",
        "busy",
        "-x",
        "120",
        "-y",
        "40",
        "while :; do seq 1 300; sleep 0.005; done",
      );
      const started = await Promise.all(
        [0, 1, 2, 3].map(() => ownerWithClient()),
      );
      // Long enough for the unread pipe to fill and the server to queue.
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const { owner } of started) owner.kill("SIGKILL");
      await until(
        () => started.every(({ client }) => !alive(client)),
        BOUND_MS,
        `a control client outlived its owner by ${String(BOUND_MS)} ms: ${started
          .filter(({ client }) => alive(client))
          .map(({ client }) => String(client))
          .join(", ")}`,
      );
      expect(tmux("list-clients", "-F", "#{client_pid}").trim()).toBe("");
    }, 20_000);

    it("is not started at all for an owner that is already gone", () => {
      const owned = ownedSpawnArgs(
        "/bin/sh",
        ["-c", "echo started"],
        undefined,
        process.env,
        // Not this process's pid, so not the helper's parent.
        process.pid + 1_000_000,
      );
      const run = spawnSync(owned.file, [...owned.args], { encoding: "utf8" });
      expect(run.stdout).toBe("");
      expect(run.status).toBe(125);
    });
  },
);
