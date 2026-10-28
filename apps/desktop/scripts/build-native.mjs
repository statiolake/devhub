/**
 * `devhub-input-source`, the helper that switches the macOS input source while
 * a chord is armed (`src/main/native/inputSource.c`, see
 * `src/main/shell/inputSourceHelper.ts`).
 *
 * It is Carbon's Text Input Sources API, so there is nothing to build anywhere
 * but macOS. Elsewhere — the Linux containers DevHub is developed and tested
 * in (scripts/test-local.sh) — the build says so and leaves `out/native`
 * without it; a running app then fails the helper's requests with
 * `input_source_unavailable`, the same as a helper that cannot start.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

if (process.platform !== "darwin") {
  console.log(
    `build:native: devhub-input-source is macOS-only (Carbon); not built on ${process.platform}`,
  );
  process.exit(0);
}

mkdirSync(`${root}/out/native`, { recursive: true });
execFileSync(
  "clang",
  [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-mmacosx-version-min=12.0",
    "-framework",
    "Carbon",
    "-o",
    "out/native/devhub-input-source",
    "src/main/native/inputSource.c",
  ],
  { cwd: root, stdio: "inherit" },
);
