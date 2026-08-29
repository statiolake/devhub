import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    {
      // VS Code ships its stylesheets as modules that expect to be strings.
      // Without this they are injected as documents' stylesheets and the
      // Workbench renders unstyled.
      name: "vscode-css-as-string",
      enforce: "pre" as const,
      async resolveId(
        source: string,
        importer: string | undefined,
        options: unknown,
      ) {
        const resolved = await (
          this as unknown as {
            resolve: (
              source: string,
              importer: string | undefined,
              options: unknown,
            ) => Promise<{ id: string } | null>;
          }
        ).resolve(source, importer, options);
        if (
          resolved?.id.match(
            /node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/,
          )
        ) {
          return { ...resolved, id: `${resolved.id}?inline` };
        }
        return undefined;
      },
    },
  ],
  clearScreen: false,
  // The Workbench is shipped as a bundle and uses language features and
  // workers that predate no browser this app runs in.
  optimizeDeps: {
    // The Workbench's extensions address their own files with
    // `new URL("./resources/…", import.meta.url)`. Pre-bundling rewrites the
    // module without moving what it points at, so every icon and theme
    // resolves to a 404 — which is why the file tree had no icons and the
    // default theme could not load. This plugin rewrites those URLs to what
    // the bundle actually serves.
    esbuildOptions: { target: "esnext", plugins: [importMetaUrlPlugin] },
  },
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
