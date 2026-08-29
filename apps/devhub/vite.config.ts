import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // The Workbench is shipped as a bundle and uses language features and
  // workers that predate no browser this app runs in.
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
  build: {
    target: "esnext",
    // Two documents: the App Shell, and the Workbench each Editor frame loads.
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        workbench: fileURLToPath(new URL("workbench.html", import.meta.url)),
      },
    },
  },
  worker: { format: "es" },
  server: {
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    globals: true,
  },
});
