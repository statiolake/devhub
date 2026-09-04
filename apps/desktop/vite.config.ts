/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// What `import 'electron'` means to a test. There is no Electron under vitest,
// and up to 1.131.0 nobody had to say so: VS Code listed Electron among its
// devDependencies, so a VS Code module imported from a test resolved it against
// `vscode/node_modules`. 1.136.1 dropped it, and the import began reaching
// whichever nested `node_modules` a walk up the tree found first — a bare
// extension copy with no binary, which throws at load. The stub says what the
// answer has always been in these tests; see the file for why it is not
// DevHub's own `electron` package.
const electronStub = fileURLToPath(
  new URL("./test/stubs/electron.cjs", import.meta.url),
);

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
    alias: { electron: electronStub },
  },
});
