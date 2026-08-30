/**
 * Where the terminal tests put their scratch state.
 *
 * Inside the repository's gitignored `.spike/`, never the OS temp directory:
 * the tests run both under plain Node and under Electron-as-Node, and those two
 * do not agree on where the temp directory is.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const SCRATCH_ROOT = fileURLToPath(
	new URL("../../../../.spike/", import.meta.url),
);

export function scratchDirectory(label: string): string {
	mkdirSync(SCRATCH_ROOT, { recursive: true });
	return mkdtempSync(join(SCRATCH_ROOT, `devhub-${label}-`));
}
