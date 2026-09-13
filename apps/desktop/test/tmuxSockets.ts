/**
 * Where a test run's tmux sockets live, and the proof that none survive it.
 *
 * tmux never unlinks a socket file. Not when the server is killed, and — this
 * is the part that is easy to get wrong — not when it exits through
 * `kill-server` either: the file is still there afterwards, and only the next
 * server on the same name reuses it. `tmux -L <name>` puts that file in the
 * shared `/tmp/tmux-<uid>/`, so every suite here that started a real server
 * added one dead file to the directory holding the developer's own live
 * `devhub` and `default` sockets, where nothing could safely sweep them up.
 * They reached sixteen thousand.
 *
 * Two things follow, and both live here so that no test has to remember
 * either. A run owns its socket *directory*: `TMUX_TMPDIR` moves every socket
 * any test can create — the ones its runtime creates, and the ones it creates
 * from outside with a bare `tmux -L` — under one directory this file makes,
 * and it travels in `process.env`, so every child inherits it. And killing a
 * server means deleting its file, because tmux will not; that is only safe
 * because of the first point, and it is why the two are not separable.
 *
 * Deleting the directory would hide a leak as effectively as it cleans one up,
 * so teardown reads it before it removes it and fails the run over anything
 * still there. A test that leaks a socket now says so.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The gitignored scratch root; never the OS temp directory. */
const SCRATCH_ROOT = fileURLToPath(
  new URL("../../../.spike/", import.meta.url),
);

const TMUX_CANDIDATES = [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/usr/bin/tmux",
];

/** The tmux these tests run, or nothing on a machine that has none. */
export const TMUX = TMUX_CANDIDATES.find((path) => existsSync(path));

/**
 * The `TMUX_TMPDIR` for one run.
 *
 * Kept short on purpose: a Unix socket path is capped just past a hundred
 * bytes, and tmux appends `tmux-<uid>/<name>` of its own underneath this.
 */
function tmuxTmpdir(pid: number): string {
  return join(SCRATCH_ROOT, `tmux-${pid}`);
}

/**
 * The directory tmux actually puts the sockets in, under `TMUX_TMPDIR`.
 *
 * An unset variable is not a case to work around. It means this process would
 * quietly write into the shared directory instead, which is the whole of what
 * this file exists to prevent, so it stops here rather than at the next
 * cleanup nobody runs.
 */
export function tmuxSocketDirectory(): string {
  const root = process.env.TMUX_TMPDIR;
  if (root === undefined || root.length === 0) {
    throw new Error(
      "TMUX_TMPDIR is unset, so tmux would put this test's sockets in the shared /tmp/tmux-<uid> directory and leave them there. It is set by the vitest global setup in test/tmuxSockets.ts and by test/terminal/run-under-electron.sh; if it is missing here, the environment is not reaching this process.",
    );
  }
  return join(root, `tmux-${process.getuid?.() ?? 0}`);
}

/** The socket files that exist in this run's socket directory right now. */
export function tmuxSocketFiles(): readonly string[] {
  const directory = tmuxSocketDirectory();
  return existsSync(directory) ? [...readdirSync(directory)].sort() : [];
}

/**
 * Stop the server on one of this run's sockets, and take the socket with it.
 *
 * The unlink is not belt and braces: tmux leaves the file whatever way the
 * server ends, so this is the only thing that removes it. Doing it here rather
 * than in each caller is what makes "the directory is empty" a statement about
 * servers instead of a statement about which cleanup path a test happened to
 * take — and it is safe only because the directory belongs to this run.
 */
export function killTmuxServer(socket: string): void {
  if (TMUX !== undefined) {
    try {
      execFileSync(TMUX, ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // Not a swallow: no server on that socket is the state this wants.
    }
  }
  rmSync(join(tmuxSocketDirectory(), socket), { force: true });
}

/** Vitest's global setup: give this run its own socket directory. */
export function setup(): void {
  const directory = tmuxTmpdir(process.pid);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  process.env.TMUX_TMPDIR = directory;
}

/** Vitest's global teardown: take it away, and report anything left in it. */
export function teardown(): void {
  const root = process.env.TMUX_TMPDIR as string;
  const leaked = tmuxSocketFiles();
  for (const socket of leaked) killTmuxServer(socket);
  rmSync(root, { recursive: true, force: true });
  if (leaked.length > 0) {
    throw new Error(
      `the tmux tests left ${leaked.length} socket(s) behind: ${leaked.join(", ")}. Every test that starts a tmux server has to end it through killTmuxServer, which is the only thing that removes the file tmux leaves.`,
    );
  }
}
