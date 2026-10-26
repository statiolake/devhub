/**
 * Terminal mode's tmux commands against a real tmux server, and the managed
 * Neovim's whole lifecycle against a real tmux and a real Neovim.
 *
 * The commands are the ones `TmuxTerminalRuntime.openEditorWindow` and
 * `activateEditorPane` build (`editorWindowArgs`, `activatePaneArgs`), run
 * here on a bare session of a server of this test's own, so what is checked
 * is what tmux does with exactly those words: a new window at the session's
 * next index running the program directly, the pane id printed, and a pane id
 * accepted as the target of `select-window`.
 *
 * The Neovim half is skipped where there is no Neovim; `DEVHUB_TEST_NVIM`
 * names one that is not on the PATH.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activatePaneArgs,
  editorWindowArgs,
} from "../../src/main/terminal/tmux";
import {
  ManagedNeovims,
  type EditorPanes,
} from "../../src/main/editor/managedNeovim";
import {
  connectThroughRelay,
  NEOVIM_RELAY_LUA,
  relayArgv,
  relayFileName,
  spawnRelayProcess,
} from "../../src/main/editor/neovimRelay";
import type { TerraformShell } from "../../src/main/editor/neovimTerraform";
import { remoteNeovimFiles } from "../../src/main/shell/neovimMachines";
import { makeScratchDir, makeSocketDir } from "../../src/model/testScratch";
import { TMUX, killTmuxServer } from "../tmuxSockets";

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
      const row = panes(tmux).find((pane) => pane.paneId === paneId);
      expect(row).toMatchObject({
        windowIndex: 1,
        windowActive: true,
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
      expect(
        panes(tmux).find((pane) => pane.paneId === paneId)?.command,
      ).toMatch(/sh|sleep/u);
    });

    it("brings a pane's window to the front by the pane's id alone", () => {
      const { tmux, session } = server();
      const paneId = tmux(
        editorWindowArgs(session, "/", ["sleep", "600"]),
      ).trim();
      tmux(["select-window", "-t", `${session}:0`]);
      expect(
        panes(tmux).find((pane) => pane.paneId === paneId)?.windowActive,
      ).toBe(false);
      tmux(activatePaneArgs(paneId));
      expect(
        panes(tmux).find((pane) => pane.paneId === paneId)?.windowActive,
      ).toBe(true);
    });
  },
);

function findNvim(): string | undefined {
  const named = process.env.DEVHUB_TEST_NVIM;
  if (named !== undefined && named.length > 0) return named;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "nvim");
    if (directory.length > 0 && existsSync(candidate)) return candidate;
  }
  return undefined;
}

const NVIM = findNvim();

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
    state: (_target, paneId) => {
      const row = panes(tmux).find((pane) => pane.paneId === paneId);
      return Promise.resolve(row === undefined ? "gone" : "alive");
    },
    activate: (_target, paneId) => {
      tmux(activatePaneArgs(paneId));
      return Promise.resolve();
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
        expect(
          panes(tmux).find((pane) => pane.paneId === first)?.windowActive,
        ).toBe(true);

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
        expect(existsSync(await again.socketPath(target.workspaceId))).toBe(
          false,
        );
      } finally {
        neovims.dispose();
      }
    }, 30_000);
  },
);

/**
 * `NeovimFiles` and the relay of a host, with the host played by this
 * machine: the ports `NeovimMachines` builds for an SSH host — the disk
 * through a shell, RPC through `nvim -l relay.lua` — around the same
 * lifecycle, so the death detector and the adoption are the relay's.
 */
describe.skipIf(TMUX === undefined || NVIM === undefined)(
  "the managed Neovim on a host, through the relay",
  () => {
    function hostShell(): TerraformShell {
      return {
        name: "this machine",
        sh: (script) => {
          const result = spawnSync("/bin/sh", ["-c", script]);
          return Promise.resolve({
            code: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        },
      };
    }

    it("starts, is reused, is noticed gone, is adopted again, and is closed", async () => {
      const { tmux, session } = server();
      const root = makeScratchDir("relayed-nvim");
      const socketDirectory = makeSocketDir("relayed-nvim");
      directories.push(root, socketDirectory);
      writeFileSync(join(root, "a.txt"), "one\ntwo\n");
      const relayPath = join(socketDirectory, relayFileName());
      writeFileSync(relayPath, NEOVIM_RELAY_LUA);
      const relayed = (): ManagedNeovims =>
        new ManagedNeovims({
          panes: barePanes(tmux, session),
          nvim: () => Promise.resolve(NVIM as string),
          socketDirectory: () => Promise.resolve(socketDirectory),
          files: remoteNeovimFiles(hostShell()),
          connect: (socketPath) => {
            const [file, ...args] = relayArgv(
              NVIM as string,
              relayPath,
              socketPath,
            );
            return connectThroughRelay(
              spawnRelayProcess({
                file: file as string,
                args,
                cwd: undefined,
                env: process.env,
              }),
              socketPath,
            );
          },
          startTimeoutMs: 10_000,
        });
      const neovims = relayed();
      const target = {
        machine: "ssh:build-box" as const,
        workspaceId: "6f1c2d3e-4a5b-4c6d-8e7f-001122334466",
        root,
      };
      try {
        expect(
          await neovims.open(target, { path: join(root, "a.txt"), line: 2 }),
        ).toEqual({ started: true });
        const first = neovims.paneOf(target.workspaceId);
        expect(
          await neovims.open(target, { path: join(root, "a.txt") }),
        ).toEqual({ started: false });

        tmux(["kill-pane", "-t", first as string]);
        for (
          let wait = 0;
          wait < 200 && neovims.paneOf(target.workspaceId);
          wait += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(neovims.paneOf(target.workspaceId)).toBeUndefined();
        expect(
          await neovims.open(target, { path: join(root, "a.txt") }),
        ).toEqual({ started: true });

        neovims.dispose();
        const again = relayed();
        expect(await again.open(target, { path: join(root, "a.txt") })).toEqual(
          { started: false },
        );
        await again.close(target);
        expect(panes(tmux)).toHaveLength(1);
        expect(existsSync(await again.socketPath(target.workspaceId))).toBe(
          false,
        );
      } finally {
        neovims.dispose();
      }
    }, 40_000);
  },
);
