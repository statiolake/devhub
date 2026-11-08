import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TMUX, killTmuxServer } from "../tmuxSockets";
import { LibGhosttyVt } from "../../src/main/ptyHost/vt/libghosttyVt";
import {
  ControlClient,
  type ControlProcess,
  type ControlToPage,
} from "../../src/main/ptyHost/control/controlClient";

const WASM = fileURLToPath(
  new URL("../../vendor/libghostty-vt/ghostty-vt.wasm", import.meta.url),
);

let lib: LibGhosttyVt;
beforeAll(async () => {
  lib = await LibGhosttyVt.load(readFileSync(WASM));
});

/** The person's prefix, and bindings tmux does not draw for a control client. */
const CONF = join(mkdtempSync(join(tmpdir(), "devhub-control-")), "tmux.conf");
writeFileSync(
  CONF,
  [
    "unbind C-b",
    "set -g prefix C-q",
    "bind C-q send-prefix",
    'bind m display-popup -E "sleep 30"',
    'bind W confirm-before -p "kill? (y/n)" kill-session',
    "bind y copy-mode \\; send-keys -X cancel",
    "",
  ].join("\n"),
);

const sockets: string[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) killTmuxServer(socket);
});

function tmux(socket: string, ...args: string[]): string {
  return execFileSync(TMUX ?? "tmux", ["-L", socket, "-f", CONF, ...args], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C.UTF-8" },
  });
}

function controlProcess(socket: string, session: string): ControlProcess {
  const child = spawn(
    TMUX ?? "tmux",
    ["-L", socket, "-f", "/dev/null", "-C", "attach-session", "-t", session],
    {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, LANG: "C.UTF-8" },
    },
  );
  return {
    write: (text) => child.stdin.write(text),
    onData: (listener) =>
      child.stdout.on("data", (chunk: Buffer) =>
        listener(new Uint8Array(chunk)),
      ),
    onExit: (listener) =>
      child.on("exit", (code) => listener(code ?? undefined)),
    kill: () => child.kill(),
  };
}

/** The page's view: the last layout and each pane's rows as text. */
function page() {
  const screens = new Map<number, string[]>();
  let layout: Extract<ControlToPage, { kind: "layout" }> | undefined;
  let ended: string | undefined;
  const notices: string[] = [];
  const post = (message: ControlToPage) => {
    if (message.kind === "layout") layout = message;
    else if (message.kind === "ended") ended = message.reason;
    else if (message.kind === "notice") notices.push(message.text);
    else if (message.kind === "pane") {
      const rows = screens.get(message.pane) ?? [];
      for (const row of message.frame.dirty)
        rows[row.y] = row.cells.join("").trimEnd();
      rows.length = message.frame.rows;
      screens.set(message.pane, rows);
    }
  };
  return {
    post,
    screens,
    notices,
    get layout() {
      return layout;
    },
    get ended() {
      return ended;
    },
  };
}

async function until<T>(
  what: string,
  check: () => T | undefined | false,
  ms = 5000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(TMUX === undefined)("a tmux control client", () => {
  it("shows the session's panes, takes keys, follows splits, resizes and detaches", async () => {
    const socket = `devhub-control-${String(process.pid)}`;
    sockets.push(socket);
    tmux(socket, "new-session", "-d", "-s", "s1", "-x", "80", "-y", "24", "sh");
    tmux(
      socket,
      "send-keys",
      "-t",
      "s1",
      "PS1='$ '; clear; echo before-attach",
      "Enter",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const view = page();
    const client = new ControlClient({
      process: controlProcess(socket, "s1"),
      vt: lib,
      cols: 100,
      rows: 30,
      post: view.post,
      ended: () => undefined,
    });
    // What was on screen before the client attached is read by capture-pane.
    const first = await until(
      "the first pane",
      () => view.layout?.panes[0]?.pane,
    );
    await until("the captured screen", () =>
      view.screens.get(first)?.some((row) => row === "before-attach"),
    );
    expect(view.layout).toMatchObject({ cols: 100, rows: 30, session: "s1" });

    // Keys go through the client's key tables; the echo comes back as output.
    client.receive({
      kind: "bytes",
      bytes: new TextEncoder().encode("echo 日本👍🏽\r"),
    });
    await until("the echo", () =>
      view.screens.get(first)?.some((row) => row === "日本👍🏽"),
    );

    // A split is a new pane, read and shown; both rectangles are tmux's.
    tmux(socket, "split-window", "-h", "-t", "s1", "sh");
    await until("two panes", () => view.layout?.panes.length === 2);
    const [left, right] = view.layout?.panes ?? [];
    expect(left.x).toBe(0);
    expect(right.x).toBe(left.width + 1);
    expect(left.width + 1 + right.width).toBe(100);

    // The client's size is the window's.
    client.receive({ kind: "resize", cols: 60, rows: 20 });
    await until(
      "the new size",
      () =>
        view.layout?.cols === 60 &&
        view.layout.panes.reduce((w, p) => w + p.width, 0) === 59,
    );

    // Prefix and a binding, through send-keys -K: C-q z zooms the pane.
    client.receive({ kind: "keys", keys: ["C-q", "z"] });
    await until(
      "the zoom",
      () => view.layout?.panes.length === 1 && view.layout.windows[0]?.zoomed,
    );

    client.stop();
    await until("the end", () => view.ended);
  }, 20000);
  it("refuses the bindings that would wait on it, and is never held by them", async () => {
    const socket = `devhub-guard-${String(process.pid)}`;
    sockets.push(socket);
    tmux(socket, "new-session", "-d", "-s", "g", "-x", "80", "-y", "24", "sh");
    tmux(socket, "send-keys", "-t", "g", "PS1='$ '; clear", "Enter");
    const view = page();
    const client = new ControlClient({
      process: controlProcess(socket, "g"),
      vt: lib,
      cols: 80,
      rows: 24,
      post: view.post,
      ended: () => undefined,
    });
    const pane = await until("the pane", () => view.layout?.panes[0]?.pane);
    // A confirm is said, not run, and so is a popup with no pty to run it
    // in (`ControlClientOptions.popup`): the client answers on.
    client.receive({ kind: "keys", keys: ["C-q", "m", "C-q", "W"] });
    await until("two notices", () => view.notices.length === 2);
    expect(view.notices[0]).toContain("display-popup");
    expect(view.notices[1]).toContain("confirm-before");
    client.receive({
      kind: "bytes",
      bytes: new TextEncoder().encode("echo still-here\r"),
    });
    await until("the client still answering", () =>
      view.screens.get(pane)?.some((row) => row === "still-here"),
    );
    // Copy mode left behind is left; one a binding leaves by itself is not said.
    client.receive({ kind: "keys", keys: ["C-q", "y"] });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(view.notices).toHaveLength(2);
    client.receive({ kind: "keys", keys: ["C-q", "["] });
    await until("the copy-mode notice", () => view.notices.length === 3);
    expect(view.notices[2]).toContain("copy-mode");
    expect(
      tmux(
        socket,
        "display-message",
        "-p",
        "-t",
        "g",
        "#{pane_in_mode}",
      ).trim(),
    ).toBe("0");
    client.stop();
    await until("the end", () => view.ended);
  }, 20000);
});
