/**
 * DevHub's native helpers, built into `out/native`:
 *
 * - `devhub-footprint`, every process's physical footprint for the Task
 *   Manager (`src/main/native/footprint.c`, see
 *   `src/main/shell/taskManagerReading.ts`); without it the Task Manager
 *   shows the resident set.
 * - `devhub-input-source`, the helper that switches the macOS input source
 *   while a chord is armed (`src/main/native/inputSource.c`, see
 *   `src/main/shell/inputSourceHelper.ts`).
 *
 * - `devhub-exec-clean`, which starts a child with only its stdio open
 *   (`src/main/native/execClean.c`, see `src/main/terminal/cleanSpawn.ts`).
 *   Linux only: macOS's `posix_spawn` already inherits nothing else.
 *
 * The first two are macOS APIs (Carbon, libproc), so there is nothing to build anywhere
 * but macOS. Elsewhere — the Linux containers DevHub is developed and tested
 * in (scripts/test-local.sh) — the build says so and leaves `out/native`
 * without them; a running app then fails the input source helper's requests
 * with `input_source_unavailable`, the same as a helper that cannot start,
 * and the Task Manager reads `ps`'s resident set, as it does on Linux.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

mkdirSync(`${root}/out/native`, { recursive: true });

// libghostty-vt, the control-mode terminal's engine (`vendor/libghostty-vt/`,
// `src/main/ptyHost/vt/libghosttyVt.ts`): not native code, but a build input
// that lives outside `src` and has to be in `out`, which is what the packaged
// app carries. Copied on every platform.
mkdirSync(`${root}/out/vt`, { recursive: true });
copyFileSync(
  `${root}/vendor/libghostty-vt/ghostty-vt.wasm`,
  `${root}/out/vt/ghostty-vt.wasm`,
);

// `devhub-exec-clean`, which starts a program with nothing of its parent's
// open but stdio (`src/main/native/execClean.c`, see
// `src/main/terminal/cleanSpawn.ts`). Only Linux needs it — libuv starts
// children with `posix_spawn` and close-on-exec by default on macOS — and
// without it children are started directly, as before.
if (process.platform === "linux") {
  try {
    execFileSync(
      "cc",
      [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-o",
        "out/native/devhub-exec-clean",
        "src/main/native/execClean.c",
      ],
      { cwd: root, stdio: "inherit" },
    );
  } catch (error) {
    console.log(
      `build:native: devhub-exec-clean not built (${error.message}); children inherit what their parent has open`,
    );
  }
}

if (process.platform !== "darwin") {
  console.log(
    `build:native: devhub-input-source and devhub-footprint are macOS-only; not built on ${process.platform}`,
  );
  process.exit(0);
}

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
