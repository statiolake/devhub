/// <reference types="vitest/config" />
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The one Electron. DevHub declares it in this package's own devDependencies,
// and it is the version the submodule's .npmrc builds VS Code's native modules
// against.
//
// The tests need it named here because a suite that reaches into the submodule
// pulls VS Code's own modules in, and those `import 'electron'` from inside
// `vscode/`, where Node resolves it against `vscode/node_modules`. Up to
// 1.131.0 that happened to hold a copy, because VS Code listed Electron among
// its devDependencies; 1.136.1 dropped it, leaving the import to be answered by
// whichever nested `node_modules` a walk up the tree reached first — in
// practice a bare extension copy with no downloaded binary, which throws
// "Electron failed to install correctly" at load. Resolving from this file
// makes the answer DevHub's declared one, from wherever the import is written.
const electronEntry = createRequire(import.meta.url).resolve("electron");

// The App Shell page is loaded from disk by the shell BrowserWindow, so the
// build has to be relative: there is no server root to be absolute against.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/shell",
    emptyOutDir: true,
  },
  test: {
    // `out/` is the main process's compiled output. Vitest's default include
    // finds the compiled copy of every test as well as its source, which runs
    // each suite twice — against code that is only as fresh as the last build.
    // The sources are the tests; the build output is not.
    exclude: ["**/node_modules/**", "out/**", "dist/**"],
    alias: { electron: electronEntry },
  },
});
