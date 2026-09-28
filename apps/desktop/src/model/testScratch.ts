/**
 * A throwaway directory for tests that touch the filesystem.
 *
 * It lives in the repository rather than the OS temp directory on purpose: a
 * sandboxed and an unsandboxed process disagree about where `$TMPDIR` is, and a
 * test that writes to one and reads from the other fails in a way that has
 * nothing to do with the code under test. `.test-scratch/` is gitignored.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../.test-scratch/", import.meta.url));

export function makeScratchDir(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  return mkdtempSync(join(ROOT, `${prefix}-`));
}

/**
 * A throwaway directory for a test's Unix sockets, and whatever sits beside them.
 *
 * Not under `.test-scratch/`. A socket's path has to fit in `sun_path`, 104
 * bytes on macOS with its NUL, and a directory inside the checkout is as deep
 * as wherever the checkout happens to be: a worktree a few directories further
 * down put every such socket past the limit, and the tests failed on where the
 * repository was rather than on the code. `/tmp` is short on every machine
 * these tests run on — named literally, because macOS puts `$TMPDIR` fifty
 * bytes deep — so the length of a socket's path is this directory's plus a
 * name the test chose.
 */
export function makeSocketDir(prefix: string): string {
  return mkdtempSync(join("/tmp", `dh-${prefix}-`));
}

export function removeScratchDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
