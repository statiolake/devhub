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

export function removeScratchDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
