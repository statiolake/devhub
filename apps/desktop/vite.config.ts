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
});
