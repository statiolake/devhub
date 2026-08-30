/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
  },
});
