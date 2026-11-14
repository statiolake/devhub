/**
 * Terminal mode's tmux commands against a real tmux server, and the managed
 * Neovim's whole lifecycle against a real tmux and a real Neovim.
 *
 * The command is the one `TmuxTerminalRuntime.openEditorWindow` builds
 * (`editorWindowArgs`), run here on a bare session of a server of this
 * test's own, so what is checked is what tmux does with exactly those words:
 * a new window at the session's next index running the program directly, not
 * selected, and the pane id printed.
 *
 * The Neovim half runs DevHub's own Neovim (`testNeovim.ts`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  editorWindowArgs,
  showEditorPaneArgs,
} from "../../src/main/terminal/tmux";
import {
  ManagedNeovims,
  type EditorPanes,
} from "../../src/main/editor/managedNeovim";
import { makeScratchDir, makeSocketDir } from "../../src/model/testScratch";
import { TMUX, killTmuxServer } from "../tmuxSockets";
import { TEST_NVIM } from "../../src/main/editor/testNeovim";

let sequence = 0;
const sockets: string[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) killTmuxServer(socket);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function server(): {
  tmux: (args: readonly string[]) => string;
  session: string;
} {
  sequence += 1;
  const socket = `dhedit${String(process.pid)}${String(sequence)}`;
  sockets.push(socket);
  const tmux = (args: readonly string[]) =>
    execFileSync(TMUX as string, ["-L", socket, "-f", "/dev/null", ...args], {
      encoding: "utf8",
    });
  const session = "ws-0123456789abcdef";
  tmux(["new-session", "-d", "-s", session, "-c", "/", "--", "sleep", "600"]);
  return { tmux, session };
}

interface PaneRow {
  readonly paneId: string;
  readonly windowIndex: number;
  readonly windowActive: boolean;
  readonly command: string;
  readonly path: string;
}

function panes(tmux: (args: readonly string[]) => string): PaneRow[] {
  return tmux([
    "list-panes",
    "-a",
    "-F",
    // Not a tab: a tmux in the C locale prints a control character as `_`.
    "#{pane_id}|#{window_index}|#{window_active}|#{pane_current_command}|#{pane_current_path}",
  ])
    .trim()
    .split("\n")
    .map((line) => {
      const [paneId, index, active, command, path] = line.split("|");
      return {
        paneId: paneId!,
        windowIndex: Number(index),
        windowActive: active === "1",
        command: command!,
        path: path!,
      };
    });
}

/**
 * The pane's row once it runs its program. Straight after `new-window` its
 * process can still be tmux's own fork, not yet the program (on macOS it
 * often is, and `pane_current_command` says `tmux`), so it is read until it
 * is something else, for up to five seconds.
 */
function started(
  tmux: (args: readonly string[]) => string,
  paneId: string,
): PaneRow | undefined {
  const until = Date.now() + 5_000;
  for (;;) {
    const row = panes(tmux).find((pane) => pane.paneId === paneId);
    if (row?.command !== "tmux" || Date.now() > until) return row;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

describe.skipIf(TMUX === undefined)(
  "terminal mode's tmux commands, for real",
  () => {
    it("opens a new window at the session's next index, running the program, and prints its pane", () => {
      const { tmux, session } = server();
      const root = makeScratchDir("editor-window");
      directories.push(root);
      const paneId = tmux(
        editorWindowArgs(session, root, ["sleep", "600"]),
      ).trim();
      expect(paneId).toMatch(/^%[0-9]+$/u);
      const row = started(tmux, paneId);
      expect(row).toMatchObject({
        windowIndex: 1,
        windowActive: false,
        command: "sleep",
      });
      expect(row?.path).toBe(root);
      // The window the person had is still there, untouched.
      expect(panes(tmux).filter((pane) => pane.windowIndex === 0)).toHaveLength(
        1,
      );
    });

    it("runs a program whose arguments look like options as the program", () => {
      const { tmux, session } = server();
      const paneId = tmux(
        editorWindowArgs(session, "/", ["sh", "-c", "sleep 600", "--listen"]),
      ).trim();
      expect(started(tmux, paneId)?.command).toMatch(/sh|sleep/u);
    });
  },
);

const NVIM = TEST_NVIM;

/** `EditorPanes` over a bare tmux server: the runtime's commands, unmarked. */
function barePanes(
  tmux: (args: readonly string[]) => string,
  session: string,
): EditorPanes {
  return {
    open: (target, argv) =>
      Promise.resolve(
        // No configuration of the developer's: an empty XDG config
        // home, and everything tmux puts in a pane's environment kept —
        // `$TMUX_PANE` is how a server is adopted.
        tmux(
          editorWindowArgs(session, target.root, [
            "env",
            `XDG_CONFIG_HOME=${target.root}`,
            ...argv,
          ]),
        ).trim(),
      ),
    show: (_target, paneId, socketPath) => {
      if (!panes(tmux).some((pane) => pane.paneId === paneId)) {
        return Promise.resolve("gone");
      }
      tmux(showEditorPaneArgs(paneId, socketPath));
      return Promise.resolve("alive");
    },
    state: (_target, paneId) => {
      const row = panes(tmux).find((pane) => pane.paneId === paneId);
      return Promise.resolve(row === undefined ? "gone" : "alive");
    },
    kill: (_target, paneId) => {
      try {
        tmux(["kill-pane", "-t", paneId]);
      } catch {
        // Already gone.
      }
      return Promise.resolve();
    },
  };
}

describe.skipIf(TMUX === undefined || NVIM === undefined)(
  "the managed Neovim in a real tmux session",
  () => {
    it("starts in a new window, is reused while alive, and is started again once it has quit", async () => {
      const { tmux, session } = server();
      const root = makeScratchDir("managed-nvim");
      const socketDirectory = makeSocketDir("managed-nvim");
      directories.push(root, socketDirectory);
      writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
      writeFileSync(join(root, "b.txt"), "alpha\nbeta\n");
      const neovims = new ManagedNeovims({
        panes: barePanes(tmux, session),
        nvim: () => Promise.resolve(NVIM as string),
        socketDirectory,
        startTimeoutMs: 10_000,
      });
      const target = {
        machine: "local" as const,
        workspaceId: "6f1c2d3e-4a5b-4c6d-8e7f-001122334455",
        root,
      };
      try {
        expect(
          await neovims.open(target, { path: join(root, "a.txt"), line: 2 }),
        ).toEqual({ started: true });
        const first = neovims.paneOf(target.workspaceId);
        expect(first).toMatch(/^%[0-9]+$/u);
        expect(panes(tmux)).toHaveLength(2);

        tmux(["select-window", "-t", `${session}:0`]);
        expect(
          await neovims.open(target, { path: join(root, "b.txt") }),
        ).toEqual({ started: false });
        expect(neovims.paneOf(target.workspaceId)).toBe(first);
        // Brought forward, its pane naming the socket the overlay attaches to.
        expect(
          panes(tmux).find((pane) => pane.paneId === first)?.windowActive,
        ).toBe(true);
        expect(
          tmux([
            "display-message",
            "-p",
            "-t",
            first as string,
            "#{@devhub-nvim}",
          ]).trim(),
        ).toBe(neovims.socketPath(target.workspaceId));

        // The person closes it.
        tmux(["kill-pane", "-t", first as string]);
        for (
          let wait = 0;
          wait < 100 && neovims.paneOf(target.workspaceId);
          wait += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(neovims.paneOf(target.workspaceId)).toBeUndefined();
        expect(
          await neovims.open(target, { path: join(root, "a.txt") }),
        ).toEqual({ started: true });
        expect(neovims.paneOf(target.workspaceId)).not.toBe(first);
        expect(panes(tmux)).toHaveLength(2);

        // A DevHub that quit and came back adopts it rather than starting another.
        neovims.dispose();
        const again = new ManagedNeovims({
          panes: barePanes(tmux, session),
          nvim: () => Promise.resolve(NVIM as string),
          socketDirectory,
        });
        expect(await again.open(target, { path: join(root, "b.txt") })).toEqual(
          { started: false },
        );
        await again.close(target);
        expect(panes(tmux)).toHaveLength(1);
        expect(existsSync(again.socketPath(target.workspaceId))).toBe(false);
      } finally {
        neovims.dispose();
      }
    }, 30_000);

    it("says in its window, with Neovim's stderr, why Neovim could not start", async () => {
      const { tmux, session } = server();
      const root = makeScratchDir("managed-nvim-fail");
      const socketDirectory = makeSocketDir("managed-nvim-fail");
      directories.push(root, socketDirectory);
      // A Neovim whose config fails before it listens.
      const broken = join(root, "nvim");
      writeFileSync(
        broken,
        "#!/bin/sh\necho 'E5113: boom in init.lua' >&2\nexit 1\n",
        { mode: 0o755 },
      );
      const neovims = new ManagedNeovims({
        panes: barePanes(tmux, session),
        nvim: () => Promise.resolve(broken),
        socketDirectory,
        startTimeoutMs: 10_000,
      });
      const target = {
        machine: "local" as const,
        workspaceId: "6f1c2d3e-4a5b-4c6d-8e7f-001122334477",
        root,
      };
      try {
        await expect(
          neovims.open(target, { path: join(root, "a.txt") }),
        ).rejects.toThrow("exited before it opened its socket");
        const shown = panes(tmux).find(
          (row) => row.windowActive && row.windowIndex > 0,
        );
        expect(shown).toBeDefined();
        let screen = "";
        for (let wait = 0; wait < 100; wait += 1) {
          screen = tmux(["capture-pane", "-p", "-t", shown!.paneId]);
          if (screen.includes("Enter")) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(screen).toContain("Neovim が起動の途中で終了しました");
        expect(screen).toContain("E5113: boom in init.lua");
        expect(screen).toContain("Enter でこのウィンドウを閉じます。");
        // Enter closes it.
        tmux(["send-keys", "-t", shown!.paneId, "Enter"]);
        for (
          let wait = 0;
          wait < 100 && panes(tmux).some((row) => row.paneId === shown!.paneId);
          wait += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(panes(tmux).map((row) => row.paneId)).not.toContain(
          shown!.paneId,
        );
      } finally {
        neovims.dispose();
      }
    }, 30_000);

    it("opens the file in a Neovim, whatever the last one was doing as the jump came", async () => {
      // `:q`, `:qa!` over an unsaved buffer, a crash, the window killed:
      // each followed at once by the next jump, as in the app.
      const { tmux, session } = server();
      const root = makeScratchDir("managed-nvim-race");
      const socketDirectory = makeSocketDir("managed-nvim-race");
      directories.push(root, socketDirectory);
      writeFileSync(join(root, "a.txt"), "one\n");
      writeFileSync(join(root, "b.txt"), "two\n");
      const neovims = new ManagedNeovims({
        panes: barePanes(tmux, session),
        nvim: () => Promise.resolve(NVIM as string),
        socketDirectory,
        startTimeoutMs: 10_000,
      });
      const target = {
        machine: "local" as const,
        workspaceId: "6f1c2d3e-4a5b-4c6d-8e7f-001122334466",
        root,
      };
      const socket = neovims.socketPath(target.workspaceId);
      const nvim = (args: readonly string[]) =>
        execFileSync(NVIM as string, ["--server", socket, ...args], {
          encoding: "utf8",
          timeout: 5_000,
        }).trim();
      const ends: readonly (() => void)[] = [
        () => nvim(["--remote-send", "<Esc>:q!<CR>"]),
        () => nvim(["--remote-send", "<Esc>:enew<CR>ix<Esc>:qa!<CR>"]),
        () =>
          process.kill(Number(nvim(["--remote-expr", "getpid()"])), "SIGKILL"),
        () => {
          tmux([
            "kill-window",
            "-t",
            neovims.paneOf(target.workspaceId) as string,
          ]);
        },
      ];
      try {
        await neovims.open(target, { path: join(root, "a.txt") });
        for (let round = 0; round < 12; round += 1) {
          ends[round % ends.length]!();
          const file = join(root, round % 2 === 0 ? "b.txt" : "a.txt");
          await neovims.open(target, { path: file });
          const pane = neovims.paneOf(target.workspaceId) as string;
          // The Neovim it went to is the one alive in the shown window,
          // naming the socket, and it has the file.
          expect(
            panes(tmux).find((row) => row.paneId === pane)?.windowActive,
          ).toBe(true);
          expect(
            tmux([
              "display-message",
              "-p",
              "-t",
              pane,
              "#{@devhub-nvim}",
            ]).trim(),
          ).toBe(socket);
          expect(nvim(["--remote-expr", "expand('%:p')"])).toBe(file);
          expect(nvim(["--remote-expr", "$TMUX_PANE"])).toBe(pane);
        }
      } finally {
        neovims.dispose();
      }
    }, 60_000);
  },
);
