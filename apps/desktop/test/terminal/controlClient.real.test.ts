import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
import { TEST_NVIM } from "../../src/main/editor/testNeovim";
import { TEST_DEVHUB } from "../../src/main/cli/testDevhub";
import {
  NVIM_SHIM_FACTS_FILE,
  NVIM_SHIM_KEYS_FILE,
  neovimShimFacts,
  neovimShimKeys,
  paneTmuxScript,
} from "../../src/main/editor/terminalNeovimShim";
import type { PopupPty } from "../../src/main/ptyHost/control/popup";
import { printfEscaped } from "../../src/main/ptyHost/control/tmuxCommand";

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
    "set -g mode-keys vi",
    "set -s set-clipboard on",
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

/**
 * The page's view: the last layout and each pane's rows as text.
 *
 * It acks each pane frame once it has it, as the pane page does once it has
 * painted one (`ControlTerminalSurface`): the client keeps at most four
 * frames unacked in flight and posts none after that, so a page that never
 * acked saw the first four frames of a case and nothing more. A shell whose
 * output came in three frames rather than one, as it does on a loaded
 * machine, left the case no frame for the copy mode it then drew.
 */
function page() {
  let painter: ControlClient | undefined;
  const screens = new Map<number, string[]>();
  let layout: Extract<ControlToPage, { kind: "layout" }> | undefined;
  let ended: string | undefined;
  const notices: string[] = [];
  let prompt: Extract<ControlToPage, { kind: "prompt" }> | undefined;
  let menu: Extract<ControlToPage, { kind: "menu" }> | undefined;
  let chooser: Extract<ControlToPage, { kind: "chooser" }> | undefined;
  let copy: Extract<ControlToPage, { kind: "copy-mode" }> | undefined;
  const clipboard: string[] = [];
  /** Pane frames since the last copy-mode state: its rows come in the next. */
  let framesSinceCopy = 0;
  let numbers: Extract<ControlToPage, { kind: "display-panes" }> | undefined;
  const post = (message: ControlToPage) => {
    if (message.kind === "layout") layout = message;
    else if (message.kind === "prompt") prompt = message;
    else if (message.kind === "prompt-closed") prompt = undefined;
    else if (message.kind === "menu") menu = message;
    else if (message.kind === "menu-closed") menu = undefined;
    else if (message.kind === "chooser") chooser = message;
    else if (message.kind === "copy-mode") {
      copy = message;
      framesSinceCopy = 0;
    } else if (message.kind === "copy-mode-closed") copy = undefined;
    else if (message.kind === "clipboard") clipboard.push(message.text);
    else if (message.kind === "chooser-closed") chooser = undefined;
    else if (message.kind === "display-panes") numbers = message;
    else if (message.kind === "display-panes-closed") numbers = undefined;
    else if (message.kind === "ended") ended = message.reason;
    else if (message.kind === "notice") notices.push(message.text);
    else if (message.kind === "pane") {
      const seq = message.seq;
      queueMicrotask(() => painter?.receive({ kind: "ack", seq }));
      framesSinceCopy += 1;
      const rows = screens.get(message.pane) ?? [];
      for (const row of message.frame.dirty)
        rows[row.y] = row.cells.join("").trimEnd();
      rows.length = message.frame.rows;
      screens.set(message.pane, rows);
    }
  };
  return {
    post,
    /** The client whose frames this page acks. */
    paints(client: ControlClient) {
      painter = client;
    },
    screens,
    notices,
    get layout() {
      return layout;
    },
    get ended() {
      return ended;
    },
    get prompt() {
      return prompt;
    },
    get menu() {
      return menu;
    },
    get chooser() {
      return chooser;
    },
    get copy() {
      return copy;
    },
    get framesSinceCopy() {
      return framesSinceCopy;
    },
    clipboard,
    get numbers() {
      return numbers;
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
    view.paints(client);
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
  it("asks a command-prompt and a confirm-before, and tmux runs the answer", async () => {
    const socket = `devhub-prompt-${String(process.pid)}`;
    sockets.push(socket);
    tmux(socket, "new-session", "-d", "-s", "p", "-x", "80", "-y", "24", "sh");
    tmux(socket, "rename-window", "-t", "p", "before");
    const view = page();
    const client = new ControlClient({
      process: controlProcess(socket, "p"),
      vt: lib,
      cols: 80,
      rows: 24,
      post: view.post,
      ended: () => undefined,
    });
    view.paints(client);
    await until("the pane", () => view.layout?.panes[0]?.pane);
    // tmux's own `,`: the input is the window's name, expanded by tmux.
    client.receive({ kind: "keys", keys: ["C-q", ","] });
    const asked = await until("the prompt", () => view.prompt);
    expect(asked.input).toBe("before");
    expect(asked.prompt).toContain("rename-window");
    client.receive({
      kind: "keys",
      keys: ["C-u", "a", "#", "b", "Space", "%", "d", "Enter"],
    });
    await until("the rename", () =>
      view.layout?.windows[0]?.name === "a#b %d" ? true : undefined,
    );
    expect(view.prompt).toBeUndefined();
    // tmux kept it in its history, as typed.
    expect(tmux(socket, "show-prompt-history", "-T", "command")).toContain(
      "a#b %d",
    );
    // A confirm declined runs nothing; the keys are the pane's again.
    client.receive({ kind: "keys", keys: ["C-q", "W"] });
    expect((await until("the confirm", () => view.prompt)).prompt).toBe(
      "kill? (y/n) ",
    );
    client.receive({ kind: "keys", keys: ["n"] });
    await until("the confirm closed", () => view.prompt === undefined);
    // The bare `:` prompt runs what is typed.
    client.receive({ kind: "keys", keys: ["C-q", ":"] });
    await until("the command prompt", () => view.prompt?.prompt === ":");
    client.receive({
      kind: "bytes",
      bytes: new TextEncoder().encode("rename-window typed"),
    });
    client.receive({ kind: "keys", keys: ["Enter"] });
    await until("the typed command", () =>
      view.layout?.windows[0]?.name === "typed" ? true : undefined,
    );
    // An error is said, as tmux says it in the status line.
    client.receive({ kind: "keys", keys: ["C-q", ":"] });
    await until("the command prompt", () => view.prompt?.prompt === ":");
    client.receive({
      kind: "bytes",
      bytes: new TextEncoder().encode("no-such-command"),
    });
    client.receive({ kind: "keys", keys: ["Enter"] });
    await until("the error", () =>
      view.notices.find((n) => n.includes("no-such-command")),
    );
    expect(tmux(socket, "list-sessions", "-F", "#{session_name}").trim()).toBe(
      "p",
    );
    client.stop();
    await until("the end", () => view.ended);
  }, 20000);

  it("draws a popup and a prompt a pane's shell asks for, and the shell waits as tmux would", async () => {
    const socket = `devhub-shell-${String(process.pid)}`;
    sockets.push(socket);
    tmux(socket, "new-session", "-d", "-s", "h", "-x", "80", "-y", "24", "sh");
    tmux(socket, "rename-window", "-t", "h", "before");
    // A popup's pty, which the test ends.
    const ptys: { input: string; exit: (code?: number) => void }[] = [];
    const popup = (): PopupPty => {
      const pty = { input: "", exit: (_code?: number) => {} };
      ptys.push(pty);
      return {
        write: (bytes) => {
          pty.input += new TextDecoder().decode(bytes);
        },
        onData: () => {},
        onExit: (listener) => {
          pty.exit = listener;
        },
        kill: () => pty.exit(0),
      };
    };
    const view = page();
    const client = new ControlClient({
      process: controlProcess(socket, "h"),
      vt: lib,
      cols: 80,
      rows: 24,
      post: view.post,
      ended: () => undefined,
      popup,
    });
    view.paints(client);
    const first = await until("the pane", () => view.layout?.panes[0]?.pane);
    // A pane's `tmux` (`paneTmuxScript`), run as the pane's shell runs it.
    const bin = mkdtempSync(join(tmpdir(), "devhub-pane-tmux-"));
    const shim = join(bin, "tmux");
    writeFileSync(shim, paneTmuxScript(TMUX ?? "tmux"), { mode: 0o755 });
    const socketPath = tmux(socket, "display", "-p", "#{socket_path}").trim();
    const run = (...args: string[]) => {
      const child = spawn("/bin/sh", [shim, ...args], {
        stdio: "ignore",
        env: {
          ...process.env,
          LANG: "C.UTF-8",
          TMUX: `${socketPath},0,0`,
          TMUX_PANE: `%${String(first)}`,
        },
      });
      let code: number | null | undefined;
      child.on("exit", (status) => {
        code = status;
      });
      return { exited: () => code };
    };

    // A popup: opened on the pane it was asked from, with its words as
    // they were; the shell waits until it has closed.
    const opened = run("display-popup", "-E", "echo 'it''s'; printf %s 50%");
    const pty = await until("the popup's pty", () => ptys[0]);
    expect(pty.input).toContain(printfEscaped("echo 'it''s'; printf %s 50%"));
    expect(pty.input).toContain(`%${String(first)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(opened.exited()).toBeUndefined();
    pty.exit(0);
    expect(
      await until("the shell going on", () => opened.exited() ?? false),
    ).toBe(0);

    // A prompt: drawn, and what is typed is tmux's to run.
    const asked = run("command-prompt", "-p", "name:", "rename-window '%%'");
    expect((await until("the prompt", () => view.prompt)).prompt).toBe(
      "name: ",
    );
    await until("the shell going on", () => asked.exited() ?? false);
    client.receive({
      kind: "bytes",
      bytes: new TextEncoder().encode("from the shell"),
    });
    client.receive({ kind: "keys", keys: ["Enter"] });
    await until("the rename", () =>
      view.layout?.windows[0]?.name === "from the shell" ? true : undefined,
    );

    // Anything else is tmux's own.
    expect(
      await until("list-windows", () => {
        try {
          return execFileSync("/bin/sh", [shim, "list-windows", "-F", "#W"], {
            encoding: "utf8",
            env: { ...process.env, TMUX: `${socketPath},0,0` },
          }).trim();
        } catch {
          return undefined;
        }
      }),
    ).toBe("from the shell");
    client.stop();
    await until("the end", () => view.ended);
  }, 20000);

  it("asks tmux's menus, by key and by a right-click, and runs the item as tmux would", async () => {
    const socket = `devhub-menu-${String(process.pid)}`;
    sockets.push(socket);
    tmux(socket, "new-session", "-d", "-s", "m", "-x", "80", "-y", "24", "sh");
    tmux(socket, "split-window", "-t", "m", "sh");
    const view = page();
    const client = new ControlClient({
      process: controlProcess(socket, "m"),
      vt: lib,
      cols: 80,
      rows: 24,
      post: view.post,
      ended: () => undefined,
    });
    view.paints(client);
    await until("two panes", () => view.layout?.panes.length === 2);
    const [top, bottom] = view.layout?.panes ?? [];
    expect(bottom.active).toBe(true);
    // tmux's own `>`: the pane menu, its title expanded by tmux.
    client.receive({ kind: "keys", keys: ["C-q", ">"] });
    const menu = await until("the menu", () => view.menu);
    expect(menu.title).toBe(`1 (%${String(bottom.pane)})`);
    expect(menu.items.find((i) => i.key === "z")?.name).toBe("Zoom");
    client.receive({ kind: "keys", keys: ["Escape"] });
    await until("the menu closed", () => view.menu === undefined);
    // A right-click on the other pane: its menu, and its Zoom zooms it.
    client.receive({
      kind: "mouse",
      key: "MouseDown3Pane",
      pane: top.pane,
      x: 3,
      y: 2,
    });
    expect((await until("the pane's menu", () => view.menu)).title).toBe(
      `0 (%${String(top.pane)})`,
    );
    client.receive({ kind: "keys", keys: ["z"] });
    await until("the zoom", () =>
      view.layout?.windows[0]?.zoomed === true &&
      view.layout.panes[0]?.pane === top.pane
        ? true
        : undefined,
    );
    client.stop();
    await until("the end", () => view.ended);
  }, 20000);

  it("draws choose-tree and display-panes, and tmux runs the choice", async () => {
    const socket = `devhub-choose-${String(process.pid)}`;
    sockets.push(socket);
    // A pane's row names the program it runs, and a program called `sh`
    // is not named so everywhere: macOS's `/bin/sh` runs bash, which tmux
    // calls `bash`. `sleep` is `sleep` on every machine.
    tmux(
      socket,
      "new-session",
      "-d",
      "-s",
      "c",
      "-x",
      "80",
      "-y",
      "24",
      "sleep 600",
    );
    tmux(socket, "split-window", "-t", "c", "sleep 600");
    const view = page();
    const client = new ControlClient({
      process: controlProcess(socket, "c"),
      vt: lib,
      cols: 80,
      rows: 24,
      post: view.post,
      ended: () => undefined,
    });
    view.paints(client);
    await until("two panes", () => view.layout?.panes.length === 2);
    const [top] = view.layout?.panes ?? [];
    client.receive({ kind: "keys", keys: ["C-q", "w"] });
    const picker = await until("the picker", () => view.chooser);
    // The client's own pane, the second, is where the keys start.
    expect(picker.rows[picker.choice]?.text).toMatch(/^1: sleep\*/);
    client.receive({ kind: "keys", keys: ["Up", "Enter"] });
    await until("the first pane chosen", () =>
      view.layout?.panes.find((p) => p.active)?.pane === top.pane
        ? true
        : undefined,
    );
    expect(view.chooser).toBeUndefined();
    client.receive({ kind: "keys", keys: ["C-q", "q"] });
    expect((await until("the numbers", () => view.numbers)).panes).toHaveLength(
      2,
    );
    client.receive({ kind: "keys", keys: ["1"] });
    await until("the second pane chosen", () =>
      view.layout?.panes.find((p) => p.active)?.pane !== top.pane
        ? true
        : undefined,
    );
    client.stop();
    await until("the end", () => view.ended);
  }, 20000);

  it("draws copy mode as tmux keeps it, and a copy reaches the clipboard", async () => {
    const socket = `devhub-copy-${String(process.pid)}`;
    sockets.push(socket);
    tmux(socket, "new-session", "-d", "-s", "y", "-x", "80", "-y", "24", "sh");
    tmux(socket, "send-keys", "-t", "y", "PS1='$ '; clear; seq 1 60", "Enter");
    const view = page();
    const client = new ControlClient({
      process: controlProcess(socket, "y"),
      vt: lib,
      cols: 80,
      rows: 24,
      post: view.post,
      ended: () => undefined,
    });
    view.paints(client);
    const pane = await until("the pane", () => view.layout?.panes[0]?.pane);
    await until("the output", () =>
      view.screens.get(pane)?.some((row) => row === "60"),
    );
    client.receive({ kind: "keys", keys: ["C-q", "["] });
    expect((await until("copy mode", () => view.copy)).badge).toMatch(
      /\[0\/\d+\]/,
    );
    // The person's copy-mode-vi table, as tmux runs it: up 30, select a line.
    // The mode's state is posted at once, the rows it shows in the next frame.
    client.receive({ kind: "keys", keys: ["3", "0", "k", "V"] });
    await until("the selection, drawn", () =>
      view.copy?.selection.length === 1 &&
      view.copy.scroll > 0 &&
      view.framesSinceCopy > 0
        ? true
        : undefined,
    );
    // The rows shown are the mode's: the line the cursor is on is in them.
    const row = view.copy?.selection[0]?.y ?? -1;
    const text = view.screens.get(pane)?.[row];
    expect(Number(text)).toBeGreaterThan(0);
    client.receive({ kind: "keys", keys: ["Enter"] });
    await until("the clipboard", () =>
      view.clipboard.length > 0 ? true : undefined,
    );
    expect(view.clipboard[0]?.trim()).toBe(text);
    await until("copy mode closed", () => view.copy === undefined);
    client.stop();
    await until("the end", () => view.ended);
  }, 20000);

  it("scrolls a shell's history from the first wheel tick, a line a tick", async () => {
    const socket = `devhub-wheel-${String(process.pid)}`;
    sockets.push(socket);
    tmux(socket, "new-session", "-d", "-s", "w", "-x", "80", "-y", "24", "sh");
    // The usual wheel bindings: into copy mode by an if-shell arm aimed at
    // the mouse's pane, a line a turn in it.
    tmux(
      socket,
      "bind-key",
      "-T",
      "root",
      "WheelUpPane",
      "if",
      "-F",
      "-t",
      "=",
      "#{?pane_in_mode,1,#{alternate_on}}",
      "send-keys -M",
      "copy-mode -et=",
    );
    tmux(
      socket,
      "bind-key",
      "-T",
      "copy-mode-vi",
      "WheelUpPane",
      "send-keys",
      "-X",
      "-N",
      "1",
      "scroll-up",
    );
    tmux(socket, "send-keys", "-t", "w", "PS1='$ '; clear; seq 1 100", "Enter");
    const view = page();
    const client = new ControlClient({
      process: controlProcess(socket, "w"),
      vt: lib,
      cols: 80,
      rows: 24,
      post: view.post,
      ended: () => undefined,
    });
    view.paints(client);
    const pane = await until("the pane", () => view.layout?.panes[0]?.pane);
    await until("the output", () =>
      view.screens.get(pane)?.some((row) => row === "100"),
    );
    // The client has read the bindings (the prefix is said with them).
    await until("the bindings", () => view.layout?.prefixes.includes("C-q"));
    const wheel = () =>
      client.receive({ kind: "mouse", key: "WheelUpPane", pane, x: 5, y: 5 });
    // The tick that enters copy mode scrolls too.
    wheel();
    await until("a line up", () =>
      view.copy?.scroll === 1 ? true : undefined,
    );
    // Ticks that come while one is scrolled are each a line still.
    for (let i = 0; i < 5; i += 1) wheel();
    await until("six lines up", () =>
      view.copy?.scroll === 6 ? true : undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(view.copy?.scroll).toBe(6);
    client.stop();
    await until("the end", () => view.ended);
  }, 20000);

  it("scrolls copy mode by tmux's own wheel binding, `select-pane \\;` and all", async () => {
    const socket = `devhub-wheel-default-${String(process.pid)}`;
    sockets.push(socket);
    tmux(socket, "new-session", "-d", "-s", "w", "-x", "80", "-y", "24", "sh");
    // tmux's defaults, untouched: copy mode's WheelUpPane is
    // `select-pane \; send-keys -X -N 5 scroll-up`, which list-keys writes
    // with the `\;` a string tmux parses would take as an argument.
    tmux(socket, "send-keys", "-t", "w", "PS1='$ '; clear; seq 1 100", "Enter");
    const view = page();
    const client = new ControlClient({
      process: controlProcess(socket, "w"),
      vt: lib,
      cols: 80,
      rows: 24,
      post: view.post,
      ended: () => undefined,
    });
    view.paints(client);
    const pane = await until("the pane", () => view.layout?.panes[0]?.pane);
    await until("the output", () =>
      view.screens.get(pane)?.some((row) => row === "100"),
    );
    await until("the bindings", () =>
      (view.layout?.prefixes.length ?? 0) > 0 ? true : undefined,
    );
    const wheel = () =>
      client.receive({ kind: "mouse", key: "WheelUpPane", pane, x: 5, y: 5 });
    wheel();
    await until("five lines up", () =>
      view.copy?.scroll === 5 ? true : undefined,
    );
    wheel();
    await until("ten lines up", () =>
      view.copy?.scroll === 10 ? true : undefined,
    );
    client.stop();
    await until("the end", () => view.ended);
  }, 20000);

  it("says a new window is current only with its place among the windows", async () => {
    const socket = `devhub-neww-${String(process.pid)}`;
    sockets.push(socket);
    tmux(socket, "new-session", "-d", "-s", "n", "-x", "80", "-y", "24", "sh");
    const layouts: Extract<ControlToPage, { kind: "layout" }>[] = [];
    const view = page();
    const client = new ControlClient({
      process: controlProcess(socket, "n"),
      vt: lib,
      cols: 80,
      rows: 24,
      post: (message) => {
        if (message.kind === "layout") layouts.push(message);
        view.post(message);
      },
      ended: () => undefined,
    });
    view.paints(client);
    const home = await until("the window", () => view.layout?.window);
    // Before the current one (renumbering it), then after it.
    tmux(socket, "new-window", "-b", "-t", "n:", "sh");
    const left = await until("the new window", () =>
      view.layout !== undefined && view.layout.window !== home
        ? view.layout.window
        : undefined,
    );
    tmux(socket, "select-window", "-t", `@${String(home)}`);
    await until("back", () => view.layout?.window === home || undefined);
    tmux(socket, "new-window", "-a", "-t", `@${String(home)}`, "sh");
    const right = await until("the other new window", () =>
      view.layout !== undefined &&
      view.layout.window !== home &&
      view.layout.window !== left
        ? view.layout.window
        : undefined,
    );
    for (const layout of layouts)
      expect(layout.windows.map((w) => w.id)).toContain(layout.window);
    expect(view.layout?.windows.map((w) => w.id)).toEqual([left, home, right]);
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
    view.paints(client);
    const pane = await until("the pane", () => view.layout?.panes[0]?.pane);
    // A buffer chooser is said, not run, and so is a popup with no pty to
    // run it in (`ControlClientOptions.popup`): the client answers on.
    client.receive({ kind: "keys", keys: ["C-q", "m", "C-q", "="] });
    await until("two notices", () => view.notices.length === 2);
    expect(view.notices[0]).toContain("display-popup");
    expect(view.notices[1]).toContain("choose-buffer");
    client.receive({
      kind: "bytes",
      bytes: new TextEncoder().encode("echo still-here\r"),
    });
    await until("the client still answering", () =>
      view.screens.get(pane)?.some((row) => row === "still-here"),
    );
    // A binding that enters copy mode and leaves it is left alone.
    client.receive({ kind: "keys", keys: ["C-q", "y"] });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(view.notices).toHaveLength(2);
    client.stop();
    await until("the end", () => view.ended);
  }, 20000);

  // Neovim's TUI asks for modifyOtherKeys (`CSI > 4 ; 2 m`), and tmux drops an
  // unmodified key it gets with `send-keys -K` while that is on and
  // `extended-keys` is (the person's tmux.conf): only C-c and the like got
  // through, so a Neovim in a pane took no keys (`KeyRoute.pane`).
  it.skipIf(TEST_NVIM === undefined)(
    "gives a Neovim TUI its keys with extended-keys on",
    async () => {
      const socket = `devhub-tui-${String(process.pid)}`;
      sockets.push(socket);
      tmux(
        socket,
        "new-session",
        "-d",
        "-s",
        "t",
        "-x",
        "80",
        "-y",
        "24",
        "sh",
      );
      tmux(socket, "set-option", "-s", "extended-keys", "on");
      tmux(socket, "set-option", "-s", "extended-keys-format", "csi-u");
      tmux(socket, "send-keys", "-t", "t", "PS1='$ '; clear", "Enter");
      const view = page();
      const client = new ControlClient({
        process: controlProcess(socket, "t"),
        vt: lib,
        cols: 80,
        rows: 24,
        post: view.post,
        ended: () => undefined,
      });
      view.paints(client);
      await until("the pane", () => view.layout?.panes[0]?.pane);
      tmux(
        socket,
        "send-keys",
        "-t",
        "t",
        `${TEST_NVIM ?? ""} --clean -n -i NONE`,
        "Enter",
      );
      await until(
        "the TUI",
        () =>
          tmux(
            socket,
            "display-message",
            "-p",
            "-t",
            "t",
            "#{alternate_on}",
          ) === "1\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      client.receive({ kind: "keys", keys: ["i", "h", "i", "Escape", "A"] });
      client.receive({ kind: "keys", keys: ["!", "Escape"] });
      await until(
        "the keys typed",
        () =>
          tmux(socket, "capture-pane", "-p", "-t", "t").split("\n")[0] ===
          "hi!",
      );
      client.receive({ kind: "keys", keys: [":", "q", "!", "Enter"] });
      await until(
        "the shell again",
        () =>
          tmux(
            socket,
            "display-message",
            "-p",
            "-t",
            "t",
            "#{alternate_on}",
          ) === "0\n",
      );
      client.stop();
      await until("the end", () => view.ended);
    },
    20000,
  );

  // DevHub's `nvim` (`terminalNeovimShim.ts`, `cli/nvim.go`) in a DevHub
  // pane with no DevHub to draw its Neovim: after the wait it says so and
  // runs the TUI, which takes the keys typed in the terminal and ends with
  // the editor's status.
  it.skipIf(TEST_NVIM === undefined || TEST_DEVHUB === undefined)(
    "falls back to a Neovim TUI that takes the keys when no UI attaches",
    async () => {
      const socket = `devhub-shim-${String(process.pid)}`;
      sockets.push(socket);
      const directory = mkdtempSync(join(tmpdir(), "devhub-shim-"));
      const bin = join(directory, "bin");
      mkdirSync(bin);
      copyFileSync(TEST_DEVHUB ?? "", join(bin, "nvim"));
      chmodSync(join(bin, "nvim"), 0o755);
      writeFileSync(join(bin, NVIM_SHIM_KEYS_FILE), neovimShimKeys());
      writeFileSync(
        join(bin, NVIM_SHIM_FACTS_FILE),
        neovimShimFacts(
          {
            nvim: TEST_NVIM ?? "",
            tmux: TMUX ?? "tmux",
            sessionPrefixes: ["ws-"],
            uiWaitTenths: 5,
          },
          bin,
        ),
      );
      const file = join(directory, "note.txt");
      tmux(
        socket,
        "new-session",
        "-d",
        "-s",
        "ws-fallback",
        "-x",
        "100",
        "-y",
        "24",
        `env PATH=${bin}:/usr/bin:/bin sh`,
      );
      tmux(socket, "set-option", "-g", "@devhub-nvim-overlay", "1");
      tmux(socket, "set-option", "-s", "extended-keys", "on");
      tmux(
        socket,
        "send-keys",
        "-t",
        "ws-fallback",
        "PS1='$ '; clear",
        "Enter",
      );
      const view = page();
      const named: string[] = [];
      const client = new ControlClient({
        process: controlProcess(socket, "ws-fallback"),
        vt: lib,
        cols: 100,
        rows: 24,
        post: view.post,
        // What it read of the pane's socket, as the pty host tells main.
        socket: (_pane, said) => {
          if (said !== "") named.push(said);
        },
        ended: () => undefined,
      });
      view.paints(client);
      const pane = await until("the pane", () => view.layout?.panes[0]?.pane);
      await until("the prompt", () =>
        view.screens.get(pane)?.some((row) => row === "$"),
      );
      const type = (text: string) =>
        client.receive({
          kind: "bytes",
          bytes: new TextEncoder().encode(text),
        });
      // What tmux has in the pane (the page's view is the client's).
      const screen = () =>
        tmux(socket, "capture-pane", "-p", "-S", "-100", "-t", "ws-fallback");
      for (const [keys, status] of [
        [[":", "w", "q", "Enter"], "0"],
        [[":", "c", "q", "Enter"], "1"],
      ] as const) {
        // The scrollback is emptied too (`\e[3J`), so what is counted below
        // is this round's: Linux's `clear` sends it, macOS's does not.
        type(
          `clear; printf '\\033[3J'; nvim --clean -n -i NONE ${file}; echo "status=$?"\r`,
        );
        // While it waits for DevHub's UI the pane's program is `nvim`: the
        // window is named after it.
        await until(
          "the socket named",
          () =>
            tmux(socket, "show-options", "-p", "-t", "ws-fallback").includes(
              "@devhub-nvim ",
            ),
          4000,
        );
        expect(
          tmux(
            socket,
            "display-message",
            "-p",
            "-t",
            "ws-fallback",
            "#{pane_current_command}",
          ),
        ).toBe("nvim\n");
        // The control client read it from tmux, on the OSC the `nvim` wrote.
        await until("the socket told", () => named.length > 0, 4000);
        named.length = 0;
        await until(
          "the TUI",
          () =>
            tmux(
              socket,
              "display-message",
              "-p",
              "-t",
              "ws-fallback",
              "#{alternate_on}",
            ) === "1\n",
          8000,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        client.receive({
          kind: "keys",
          keys: ["G", "o", ...status.split(""), "Escape", ...keys],
        });
        await until(
          "the status",
          () => screen().split("\n").includes(`status=${status}`),
          8000,
        );
        // Said once, above the TUI, and left in the scrollback.
        const said = screen().split("DevHub did not draw it within 0.5 s");
        expect(said).toHaveLength(2);
        // No option is left naming a socket.
        expect(
          tmux(socket, "show-options", "-p", "-t", "ws-fallback"),
        ).not.toContain("@devhub-nvim");
        type("clear\r");
      }
      // :wq wrote the line; :cq did not.
      expect(readFileSync(file, "utf8")).toBe("\n0\n");
      client.stop();
      await until("the end", () => view.ended);
    },
    30000,
  );
});
