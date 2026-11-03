/**
 * DevHub's two macOS helpers, built into `out/native`:
 *
 * - `devhub-footprint`, every process's physical footprint for the Task
 *   Manager (`src/main/native/footprint.c`, see
 *   `src/main/shell/taskManagerReading.ts`); without it the Task Manager
 *   shows the resident set.
 * - `devhub-input-source`, the helper that switches the macOS input source
 *   while a chord is armed (`src/main/native/inputSource.c`, see
 *   `src/main/shell/inputSourceHelper.ts`).
 *
 * Both are macOS APIs (Carbon, libproc), so there is nothing to build anywhere
 * but macOS. Elsewhere — the Linux containers DevHub is developed and tested
 * in (scripts/test-local.sh) — the build says so and leaves `out/native`
 * without them; a running app then fails the input source helper's requests
 * with `input_source_unavailable`, the same as a helper that cannot start,
 * and the Task Manager reads `ps`'s resident set, as it does on Linux.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

if (process.platform !== "darwin") {
  console.log(
    `build:native: devhub-input-source and devhub-footprint are macOS-only; not built on ${process.platform}`,
  );
  process.exit(0);
}

mkdirSync(`${root}/out/native`, { recursive: true });
const flags = [
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-mmacosx-version-min=12.0",
];
execFileSync(
  "clang",
  [
    ...flags,
    "-framework",
    "Carbon",
    "-o",
    "out/native/devhub-input-source",
    "src/main/native/inputSource.c",
  ],
  { cwd: root, stdio: "inherit" },
);
// `devhub-footprint`, the Task Manager's physical footprints
// (`src/main/native/footprint.c`): libproc, which is libSystem's.
execFileSync(
  "clang",
  [
    ...flags,
    "-o",
    "out/native/devhub-footprint",
    "src/main/native/footprint.c",
  ],
  { cwd: root, stdio: "inherit" },
);
