/* The lint config gives Node's globals to `.ts`/`.tsx` only, and this file is
   plain JavaScript because its interpreter has no TypeScript. */
/* global Buffer, URL, TextEncoder, process, setTimeout, clearTimeout */

/**
 * The whole terminal, end to end, on the real native module and a real tmux.
 *
 * This is the one terminal test that cannot run under plain Node: `node-pty` is
 * a native module built for VS Code's Electron, so the test runs under that
 * binary as Node (`run-under-electron.sh`). Everything else about the terminal
 * — the ledger, the control client against a real tmux, the marker protocol,
 * the socket transitions — is tested under vitest.
 *
 * Ported from the Rust `real_tmux_pty_roundtrip_resize_detach_and_replacement_preserve_session`.
 * What it proves is the property the tmux runtime exists for: the shell lives in
 * the session, so detaching the client leaves it running, and the next attach
 * finds the same session.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import {
  nodePty,
  openPty,
  terminalEnvironment,
} from "../../out/test-terminal/main/terminal/pty.js";
import { AttachmentManager } from "../../out/test-terminal/main/terminal/attachments.js";
import { TerminalSurfaces } from "../../out/test-terminal/main/terminal/surfaces.js";
import { TmuxTerminalRuntime } from "../../out/test-terminal/main/terminal/tmux.js";
import {
  CancellationToken,
  SCRATCH_TARGET,
} from "../../out/test-terminal/main/terminal/ports.js";
import { OperationDeadline } from "../../out/test-terminal/main/terminal/command.js";
import { PtyHost } from "../../out/test-terminal/main/ptyHost/host.js";
import { LibGhosttyVt } from "../../out/test-terminal/main/ptyHost/vt/libghosttyVt.js";

/** Scratch lives inside the repository, never in the OS temp directory. */
const SCRATCH_ROOT = fileURLToPath(
  new URL("../../../../.spike/", import.meta.url),
);
// The tmux DevHub runs, inside the app (out/tmux), as in test/tmuxSockets.ts.
const TMUX = [
  fileURLToPath(new URL("../../out/tmux/bin/tmux", import.meta.url)),
].find((path) => existsSync(path));
// On CI (`CI` set, as scripts/test-local.sh sets it too) a missing one fails,
// as in test/tmuxSockets.ts, rather than skipping the tmux tests.
if (TMUX === undefined && (process.env.CI ?? "") !== "") {
  throw new Error(
    "CI is set and there is no bundled tmux at out/tmux/bin/tmux for the PTY tests: `pnpm --filter @devhub/desktop build:binaries` builds it",
  );
}

function scratchDirectory(label) {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return realpathSync(mkdtempSync(join(SCRATCH_ROOT, `devhub-${label}-`)));
}

/**
 * Stop the server on one of this run's sockets, and take the socket with it.
 *
 * tmux never unlinks a socket file — not when the server is killed, and not
 * when it exits through `kill-server` either — so removing it is this test's
 * job. That is safe here only because `run-under-electron.sh` gave the run its
 * own `TMUX_TMPDIR`; without it these files would pile up for ever in the
 * shared directory beside the developer's own live sockets. The vitest side
 * says the same thing at more length in `test/tmuxSockets.ts`; this copy exists
 * because that file is TypeScript and this interpreter has none.
 */
function killTmuxServer(socket) {
  try {
    execFileSync(TMUX, ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // Not a swallow: no server on that socket is the state this wants.
  }
  rmSync(join(process.env.TMUX_TMPDIR, `tmux-${process.getuid()}`, socket), {
    force: true,
  });
}

// Set by `run-under-electron.sh`, and checked rather than defaulted: unset, the
// tmux servers these tests start would put their sockets in the shared
// /tmp/tmux-<uid>/ and leave them there for ever.
assert.ok(
  process.env.TMUX_TMPDIR,
  "TMUX_TMPDIR is unset — run these tests through test/terminal/run-under-electron.sh, which gives the run its own tmux socket directory",
);

function deadline(promise, milliseconds, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${what}`)),
        milliseconds,
      );
      // Deliberately *not* unref'd. This timer is the test's only defence
      // against waiting for something that will never arrive — a shell
      // whose server was killed under it, say. An unref'd one lets the
      // process go idle instead, and the runner then reports "cancelled"
      // with no message at all rather than the timeout that explains it.
      // It is cleared in `finally`, so it never outlives its own wait.
    }),
  ]).finally(() => clearTimeout(timer));
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Whether the server this test started is still there. */
function serverIsAlive(socket) {
  try {
    execFileSync(TMUX, ["-L", socket, "has-session", "-t", "scratch"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    // Not a swallow: absence is the answer this function exists to give.
    return false;
  }
}

/**
 * Run the body, and if it fails, say whether the ground moved underneath it.
 *
 * This test owns its socket and starts and stops its own server, so the only
 * way that server can vanish mid-run is something outside the test — a global
 * `pkill`, or a cleanup script matching more than it created. That is a
 * different fact from the runtime misbehaving, and a failure that cannot tell
 * them apart is the one that "passes on retry" and sends the next person
 * looking in the wrong place.
 */
async function withSocketGuard(socket, body) {
  try {
    await body();
  } catch (failure) {
    if (!serverIsAlive(socket)) {
      throw new Error(
        `the tmux server this test started on socket "${socket}" was gone before the test finished — something outside the test killed it (a global pkill, or a cleanup script matching more than it created). The failure underneath was: ${String(failure)}`,
        { cause: failure },
      );
    }
    throw failure;
  }
}

test("node-pty, DevHub's own dependency, drives a real child", async (t) => {
  assert.equal(typeof nodePty().spawn, "function");
  const cwd = scratchDirectory("pty");
  // Registered before anything can fail, so a scratch directory is never
  // left behind by a failing run.
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const pty = openPty({
    file: "/bin/sh",
    args: [],
    cwd,
    cols: 80,
    rows: 24,
    pixelWidth: 0,
    pixelHeight: 0,
    env: terminalEnvironment(process.env),
  });
  assert.ok(pty.pid > 0);
  let text = "";
  const sawMarker = new Promise((resolve) => {
    pty.onData((bytes) => {
      text += Buffer.from(bytes).toString("utf8");
      if (text.includes("devhub-pty-ok")) resolve();
    });
  });
  pty.write(new TextEncoder().encode("printf 'devhub''-pty-ok\\n'\n"));
  await deadline(sawMarker, 15_000, "the child to echo its marker");
  pty.kill();
});

/** A port pair whose ends deliver a task later, as `MessagePortMain` does. */
function portPair() {
  const make = () => {
    const listeners = { message: [], close: [] };
    const port = {
      peer: undefined,
      closed: false,
      postMessage(data) {
        const peer = port.peer;
        if (port.closed || peer.closed) return;
        setTimeout(() => {
          if (!peer.closed)
            for (const listener of peer.listeners.message) listener({ data });
        }, 0);
      },
      on(event, listener) {
        listeners[event].push(listener);
      },
      start() {},
      close() {
        port.closed = true;
        for (const listener of listeners.close) listener();
      },
      listeners,
    };
    return port;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** A tmux control client on pipes, as the pty host's entry starts one. */
function spawnPipes(launch) {
  const child = spawn(launch.file, [...launch.args], {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => undefined);
  return {
    write: (text) => child.stdin.write(text),
    onData: (listener) =>
      child.stdout.on("data", (chunk) => listener(new Uint8Array(chunk))),
    onExit: (listener) =>
      child.on("exit", (code) => listener(code ?? undefined)),
    kill: () => child.kill(),
  };
}

const VT_WASM = new URL(
  "../../vendor/libghostty-vt/ghostty-vt.wasm",
  import.meta.url,
);

test(
  "a terminal surface is a control client in the pty host, and detaching it keeps the session",
  { skip: TMUX === undefined ? "tmux is not installed" : false },
  async (t) => {
    const home = scratchDirectory("tmux-pty");
    const socket = `dhpty${process.pid}`;
    t.after(() => {
      killTmuxServer(socket);
      rmSync(home, { recursive: true, force: true });
    });

    await withSocketGuard(socket, async () => {
      const runtime = new TmuxTerminalRuntime({
        context: { home, environment: { ...process.env } },
        tmux: { kind: "resolved", value: { path: TMUX, basename: "tmux" } },
        shell: { path: "/bin/sh", basename: "sh" },
        tmuxArgs: [],
        effectiveSocketName: socket,
        timeoutMs: 15_000,
        bootstrapDirectory: home,
      });
      // The pty host, in this process, with its real children: the control
      // client on pipes, its popups on node-pty, its panes' engine.
      const fromHost = [];
      const host = new PtyHost({
        post: (message) => fromHost.push(message),
        spawn: openPty,
        spawnPipes,
        loadVt: async () => LibGhosttyVt.load(readFileSync(VT_WASM)),
      });
      const [hostEnd, pageEnd] = portPair();
      host.receive({ type: "page", page: 1, viewLabel: "real-pty-window" }, [
        hostEnd,
      ]);
      const news = [];
      const replies = new Map();
      let nextRid = 1;
      const toHost = (request) =>
        new Promise((resolve) => {
          const rid = nextRid++;
          replies.set(rid, resolve);
          pageEnd.postMessage({ type: "control", rid, request });
        });
      let identity;
      pageEnd.on("message", ({ data }) => {
        if (data.type === "reply") {
          replies.get(data.rid)?.(data.result);
          return;
        }
        news.push(data.message);
        // The page acks each pane frame once it has it, as the surface does
        // once it has painted one.
        if (data.message.kind === "pane" && identity !== undefined)
          void toHost({ ...identity, message: { kind: "ack", seq: data.message.seq } });
      });
      // Main's side of the host, reduced to what the ledger asks of it.
      let rid = 1;
      const hosted = {
        available: true,
        async open(spec) {
          const mine = rid++;
          const { route, ...rest } = spec;
          host.receive({
            type: "open",
            rid: mine,
            spec: { ...rest, page: 1, channelId: route.channelId },
          });
          const end = Date.now() + 15_000;
          while (Date.now() < end) {
            const answer = fromHost.find((m) => m.rid === mine);
            if (answer?.type === "opened") return 1;
            if (answer?.type === "open-failed") throw new Error(answer.message);
            await sleep(10);
          }
          throw new Error("the pty host did not answer the open");
        },
        stop(id, reason) {
          host.receive({ type: "stop", id, reason });
        },
      };
      const surfaces = new TerminalSurfaces({
        // One real tmux, on this machine. The lookup asserts the machine it
        // is asked for rather than ignoring it: a target naming another one
        // and being answered with this server would be a green test about
        // nothing.
        runtimeFor: (machine) => {
          assert.equal(machine, "local");
          return Promise.resolve(runtime);
        },
        attachments: new AttachmentManager({
          randomBytes: (count) => new Uint8Array(randomBytes(count)),
          hosted,
        }),
      });
      const SURFACE = "workspace-terminal:00000000-0000-4000-8000-00000000005c";
      const attach = () =>
        surfaces.attach({
          target: SCRATCH_TARGET,
          surfaceKey: SURFACE,
          viewLabel: "real-pty-window",
          size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
          route: { page: {}, channelId: "c" },
        });
      const receipt = await attach();
      identity = {
        surfaceKey: SURFACE,
        attachmentId: receipt.attachmentId,
        targetGeneration: receipt.targetGeneration,
      };

      // The pane's rows, as the page would paint them.
      const screen = () => {
        const rows = [];
        for (const message of news) {
          if (message.kind !== "pane") continue;
          for (const row of message.frame.dirty)
            rows[row.y] = row.cells.join("").trimEnd();
        }
        return rows.join("\n");
      };
      const waitFor = async (check, what) => {
        const end = Date.now() + 20_000;
        while (Date.now() < end) {
          if (check()) return;
          await sleep(20);
        }
        assert.fail(`timed out waiting for ${what}\n${screen()}`);
      };
      await waitFor(
        () => news.some((message) => message.kind === "layout"),
        "the session's layout",
      );

      // The quotes split the marker in the command the shell echoes back, so
      // waiting for it cannot match the echo of the keystrokes themselves.
      const typed = await toHost({
        ...identity,
        message: {
          kind: "bytes",
          bytes: new TextEncoder().encode("printf 'DEVHUB_PTY_''ROUNDTRIP\\n'\r"),
        },
      });
      assert.deepEqual(typed, { ok: true, value: undefined });
      await waitFor(
        () => screen().includes("DEVHUB_PTY_ROUNDTRIP"),
        "the pane to echo the marker",
      );

      surfaces.detach({ ...identity, viewLabel: "real-pty-window" });
      assert.equal(surfaces.attachmentCount, 0);
      await waitFor(
        () => news.some((message) => message.kind === "ended"),
        "the client's end",
      );
      assert.deepEqual(news.at(-1), { kind: "ended", reason: "detached" });
      const survivors = await runtime.listSessions(
        socket,
        new CancellationToken(),
        OperationDeadline.in(15_000),
      );
      // The whole point: the client is gone and the session is not.
      assert.ok(
        survivors.some((session) => session.name === "scratch"),
        "the tmux session must survive its client",
      );

      // Attaching again replaces the view's client only. The stale handle is
      // refused by identity, and the session underneath is untouched.
      const replacement = await attach();
      const latest = await attach();
      assert.notEqual(replacement.attachmentId, latest.attachmentId);
      const stale = await toHost({
        surfaceKey: SURFACE,
        attachmentId: replacement.attachmentId,
        targetGeneration: replacement.targetGeneration,
        message: { kind: "visible", visible: true },
      });
      assert.equal(stale.ok, false);
      assert.equal(stale.error.code, "wrong_attachment");
      surfaces.detach({
        surfaceKey: SURFACE,
        attachmentId: latest.attachmentId,
        targetGeneration: latest.targetGeneration,
        viewLabel: "real-pty-window",
      });
      assert.equal(surfaces.attachmentCount, 0);
      hostEnd.close();
      await sleep(50);
      assert.equal(host.clientCount, 0);
    });
  },
);

/**
 * The child of the test below, Electron run as Node like the utility
 * processes: Node marks what it inherited close-on-exec when it starts, but
 * Electron opens descriptors of its own after that which are not (as
 * /proc/self/fdinfo says). It starts a plain child, a PTY and a bounded
 * command, and says which of those descriptors each of them has.
 */
const FD_PROBE = (modules, helper) => `
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { openPty } from ${JSON.stringify(`${modules}/main/terminal/pty.js`)};
import { runChildHere } from ${JSON.stringify(`${modules}/main/terminal/childRun.js`)};
import { setExecCleanHelper } from ${JSON.stringify(`${modules}/main/terminal/cleanSpawn.js`)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const leaky = readdirSync("/proc/self/fd").filter((fd) => {
  if (Number(fd) <= 2) return false;
  try {
    const flags = /flags:\\s*([0-7]+)/.exec(readFileSync("/proc/self/fdinfo/" + fd, "utf8"))[1];
    return (parseInt(flags, 8) & 0o2000000) === 0;
  } catch { return false; }
});
const hasLeaky = (pid) => readdirSync("/proc/" + pid + "/fd").some((fd) => leaky.includes(fd));
const result = { leaky };
const plain = spawn("sleep", ["5"], { stdio: "ignore" });
await sleep(150);
result.plain = hasLeaky(plain.pid);
plain.kill("SIGKILL");
const pty = openPty({ file: "/bin/sleep", args: ["5"], cwd: "/", cols: 80, rows: 24,
  pixelWidth: 0, pixelHeight: 0, env: { PATH: process.env.PATH } });
await sleep(150);
result.pty = hasLeaky(pty.pid);
result.ptyFds = readdirSync("/proc/" + pty.pid + "/fd").sort();
pty.kill();
setExecCleanHelper(${JSON.stringify(helper)});
const run = runChildHere({ file: "sleep", args: ["5"], cwd: undefined, env: process.env,
  stdin: undefined, stdoutBytes: 1024, stderrBytes: 1024, overflow: "truncate", streamOutput: false });
await sleep(150);
const mine = readdirSync("/proc").filter((e) => {
  if (!/^\\d+$/.test(e)) return false;
  try { const st = readFileSync("/proc/" + e + "/stat", "utf8");
    return st.includes("(sleep)") && st.slice(st.lastIndexOf(")") + 2).split(" ")[1] === String(process.pid);
  } catch { return false; } });
result.bounded = mine.map(hasLeaky);
run.kill();
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

/**
 * A descriptor a process holds without close-on-exec is not held by what it
 * starts: node-pty's PTYs close them in the child, and children through
 * `childRun` (the process host's) go through `devhub-exec-clean`. Read from
 * /proc/<child>/fd, so Linux only.
 */
test(
  "what the pty host and the process host start holds nothing of theirs",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = scratchDirectory("exec-clean");
    const helper = join(directory, "devhub-exec-clean");
    execFileSync("cc", [
      "-O2",
      "-o",
      helper,
      fileURLToPath(
        new URL("../../src/main/native/execClean.c", import.meta.url),
      ),
    ]);
    const probe = join(directory, "probe.mjs");
    writeFileSync(
      probe,
      FD_PROBE(
        new URL("../../out/test-terminal", import.meta.url).href,
        helper,
      ),
    );
    try {
      const output = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [probe], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve(out) : reject(new Error(`probe exited ${code}`)),
        );
      });
      const result = JSON.parse(output);
      // The premise: there are such descriptors, and a child started with
      // nothing in the way has them.
      assert.ok(result.leaky.length > 0, "Electron has no descriptor to leak");
      assert.equal(result.plain, true);
      assert.equal(result.pty, false);
      assert.deepEqual(result.ptyFds, ["0", "1", "2"]);
      assert.deepEqual(result.bounded, [false]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
