/* The lint config gives Node's globals to `.ts`/`.tsx` only, and this file is
   plain JavaScript because its interpreter has no TypeScript. */
/* global Buffer, URL, TextDecoder, TextEncoder, process, setTimeout, clearTimeout */

/**
 * The whole terminal, end to end, on the real native module and a real tmux.
 *
 * This is the one terminal test that cannot run under plain Node: `node-pty` is
 * a native module built for VS Code's Electron, so the test runs under that
 * binary as Node (`run-under-electron.sh`). Everything else about the terminal
 * — framing, the ack window, the input ledger, the marker protocol, the socket
 * transitions — is tested under vitest.
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
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
} from "../../out/test-terminal/ipc/terminal.js";
import { PtyHost } from "../../out/test-terminal/main/ptyHost/host.js";

/** Scratch lives inside the repository, never in the OS temp directory. */
const SCRATCH_ROOT = fileURLToPath(
  new URL("../../../../.spike/", import.meta.url),
);
// DEVHUB_TEST_TMUX first, as in test/tmuxSockets.ts.
const TMUX = [
  ...(process.env.DEVHUB_TEST_TMUX ? [process.env.DEVHUB_TEST_TMUX] : []),
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/usr/bin/tmux",
].find((path) => existsSync(path));

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

test(
  "a terminal surface is a tmux client, and detaching it keeps the session",
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
          environment: () => terminalEnvironment(process.env),
        }),
      });

      const frames = [];
      let onFrame = () => undefined;
      const sink = (frame) => {
        // Encode and decode exactly as the wire does, so the test only ever
        // sees frames the page could have parsed.
        const decoded = decodeTerminalFrame(encodeTerminalFrame(frame));
        frames.push(decoded);
        onFrame(decoded);
        return true;
      };

      const receipt = await surfaces.attach({
        target: SCRATCH_TARGET,
        surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
        viewLabel: "real-pty-window",
        size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
        sink,
      });
      const identity = {
        surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
        attachmentId: receipt.attachmentId,
        targetGeneration: receipt.targetGeneration,
        viewLabel: "real-pty-window",
      };
      assert.equal(frames.length, 1);
      assert.equal(frames[0].type, "started");
      assert.equal(frames[0].sequence, 0);

      const text = () =>
        frames
          .filter((frame) => frame.type === "output")
          .map((frame) => Buffer.from(frame.bytes).toString("utf8"))
          .join("");

      const waitForText = (needle, what) =>
        deadline(
          new Promise((resolve) => {
            const check = () => {
              if (text().includes(needle)) resolve();
            };
            onFrame = (frame) => {
              // Acknowledging is what keeps the output window open; a
              // view that never acknowledges is disconnected by design.
              if (frame.type === "output") {
                surfaces.acknowledge(identity, frame.sequence);
              }
              check();
            };
            check();
          }),
          20_000,
          what,
        );

      let sequence = 0;
      const type = (line) => {
        sequence += 1;
        surfaces.input(identity, sequence, new TextEncoder().encode(line));
      };

      // The quotes split the marker in the command the shell echoes back, so
      // waiting for it cannot match the echo of the keystrokes themselves.
      type("printf 'DEVHUB_PTY_''ROUNDTRIP\\n'\r");
      await waitForText("DEVHUB_PTY_ROUNDTRIP", "the pane to echo the marker");

      await surfaces.resize(identity, {
        cols: 100,
        rows: 30,
        pixelWidth: 0,
        pixelHeight: 0,
      });

      /**
       * The pane must fill the client exactly — no more.
       *
       * A window is the client minus the rows tmux draws itself in, so on a
       * session with a status bar a 30-row client gives a 29-row window. The
       * pane may never be told it is taller than that: the extra row would be
       * where the status bar is, and a full-screen TUI's bottom line would be
       * drawn there and never seen. DevHub used to force exactly that by
       * calling `resize-window` with the client's own rows.
       *
       * The expectation is computed from tmux's own chrome rather than
       * written as a number, so this holds for a status bar that is there and
       * one that is not.
       */
      const geometry = async () => {
        const message = await runtime.runTmux(
          socket,
          [
            "display-message",
            "-p",
            "-t",
            "scratch:0.0",
            "#{pane_width} #{pane_height} #{client_height} #{status} #{window-size}",
          ],
          home,
          new CancellationToken(),
          OperationDeadline.in(15_000),
        );
        const [width, height, client, status, mode] = message.stdout
          .toString("utf8")
          .trim()
          .split(/\s+/);
        // tmux spells the status bar as off, on, or a count of lines.
        const lines =
          status === "off" ? 0 : status === "on" ? 1 : Number(status);
        assert.ok(
          Number.isInteger(lines),
          `tmux reported a status bar this test cannot read: ${status}`,
        );
        return {
          width: Number(width),
          height: Number(height),
          client: Number(client),
          status: lines,
          mode,
        };
      };

      const resizeDeadline = Date.now() + 15_000;
      let pane = await geometry();
      while (
        Date.now() < resizeDeadline &&
        !(pane.width === 100 && pane.client === 30)
      ) {
        await sleep(20);
        pane = await geometry();
      }
      assert.equal(
        pane.width,
        100,
        "the pane must observe the requested width",
      );
      assert.equal(
        pane.client,
        30,
        "the client must observe the requested rows",
      );
      assert.equal(
        pane.height,
        30 - pane.status,
        "the pane must be the client's rows minus tmux's own status lines",
      );
      // Left at its default, the window keeps following the client. An
      // explicit `resize-window` latches it to `manual` for good, and tmux
      // then ignores every later resize.
      assert.equal(
        pane.mode,
        "latest",
        "the window must keep following the client",
      );

      await sleep(250);
      type("printf 'DEVHUB_PTY_''SIZE:'; stty size; printf '\\n'\r");
      await waitForText(
        `${30 - pane.status} 100`,
        "the shell to observe the size it can actually draw in",
      );

      surfaces.detach(identity);
      assert.equal(surfaces.attachmentCount, 0);
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

      // Attaching again replaces the view's client only. The stale receipt is
      // refused by identity, and the session underneath is untouched.
      const replacement = await surfaces.attach({
        target: SCRATCH_TARGET,
        surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
        viewLabel: "real-pty-window",
        size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
        sink: () => true,
      });
      const latest = await surfaces.attach({
        target: SCRATCH_TARGET,
        surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
        viewLabel: "real-pty-window",
        size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
        sink: () => true,
      });
      assert.notEqual(replacement.attachmentId, latest.attachmentId);
      assert.throws(
        () =>
          surfaces.input(
            {
              surfaceKey:
                "workspace-terminal:00000000-0000-4000-8000-00000000005c",
              attachmentId: replacement.attachmentId,
              targetGeneration: replacement.targetGeneration,
              viewLabel: "real-pty-window",
            },
            1,
            new TextEncoder().encode("stale\r"),
          ),
        (error) => error.code === "wrong_attachment",
      );

      surfaces.detach({
        surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
        attachmentId: latest.attachmentId,
        targetGeneration: latest.targetGeneration,
        viewLabel: "real-pty-window",
      });
      assert.equal(surfaces.attachmentCount, 0);
    });
  },
);

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

test("the pty host runs a real PTY's client with its page over a port", async () => {
  const toMain = [];
  const host = new PtyHost({
    post: (message) => toMain.push(message),
    spawn: openPty,
  });
  const [hostEnd, pageEnd] = portPair();
  const frames = [];
  const replies = new Map();
  pageEnd.on("message", ({ data }) => {
    if (data.type === "frame") frames.push(decodeTerminalFrame(data.frame));
    else replies.get(data.rid)?.(data.result);
  });
  host.receive({ type: "page", page: 1, viewLabel: "9" }, [hostEnd]);
  host.receive({
    type: "open",
    rid: 1,
    spec: {
      id: "a".repeat(32),
      surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
      viewLabel: "9",
      targetGeneration: 5,
      size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
      page: 1,
      channelId: "c",
      launch: {
        file: "/bin/sh",
        args: [],
        cwd: "/",
        cols: 80,
        rows: 24,
        pixelWidth: 0,
        pixelHeight: 0,
        env: terminalEnvironment({ PATH: process.env.PATH, PS1: "$ " }),
      },
    },
  });
  assert.deepEqual(toMain, [{ type: "opened", rid: 1 }]);
  const text = () =>
    frames
      .filter((frame) => frame.type === "output")
      .map((frame) => new TextDecoder().decode(frame.bytes))
      .join("");
  const reply = await new Promise((resolve) => {
    replies.set(1, resolve);
    pageEnd.postMessage({
      type: "input",
      rid: 1,
      request: {
        schemaVersion: 1,
        surfaceKey: "workspace-terminal:00000000-0000-4000-8000-00000000005c",
        attachmentId: "a".repeat(32),
        targetGeneration: 5,
        inputSequence: 1,
        bytes: [...new TextEncoder().encode("echo pty-host-$((40+2))\r")],
      },
    });
  });
  assert.deepEqual(reply, { ok: true, value: undefined });
  const end = Date.now() + 5_000;
  while (!text().includes("pty-host-42") && Date.now() < end) await sleep(20);
  assert.match(text(), /pty-host-42/);
  assert.equal(frames[0].type, "started");
  // The page going takes its client with it.
  hostEnd.close();
  await sleep(50);
  assert.equal(host.clientCount, 0);
  assert.deepEqual(toMain.at(-1), {
    type: "ended",
    id: "a".repeat(32),
    reason: "detached",
  });
});

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
