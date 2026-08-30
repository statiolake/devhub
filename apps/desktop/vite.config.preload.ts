import { defineConfig } from "vite";

// The App Shell page's preload. VS Code enables the Chromium sandbox for every
// renderer, and a sandboxed preload is one CommonJS file with no module
// resolver behind it — so this is a bundle, not a tsc emit.
export default defineConfig({
  build: {
    outDir: "out/preload",
    emptyOutDir: true,
    lib: {
      entry: "src/preload/preload.ts",
      formats: ["cjs"],
      fileName: () => "preload.js",
    },
    rollupOptions: { external: ["electron"] },
    minify: false,
  },
});
