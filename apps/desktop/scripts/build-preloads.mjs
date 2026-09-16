/**
 * One preload bundle per page.
 *
 * VS Code enables the Chromium sandbox for every renderer, and a sandboxed
 * preload is one CommonJS file with no module resolver behind it — so each of
 * these is a bundle, not a tsc emit, and each has to be *whole*. That is why
 * this is seven builds rather than one build with seven entries: a multi-entry
 * build hoists what the entries share into a chunk, and a chunk is a `require`
 * a sandboxed preload cannot answer. The pages share `preload/bridge.ts` as
 * source and never as a file.
 *
 * Which preload a page is loaded with is what decides what that page can
 * spell — see `ipc/contract.ts` and `main/shell/bootstrapShell.ts`.
 */

import { fileURLToPath } from "node:url";
import { build } from "vite";

const PAGES = [
  "shell",
  "sidebar",
  "agents",
  "toasts",
  "tooltip",
  "picker",
  "settings",
];
const root = fileURLToPath(new URL("..", import.meta.url));

for (const [index, page] of PAGES.entries()) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: "out/preload",
      // Cleared once, by the first build; the rest add to it.
      emptyOutDir: index === 0,
      lib: {
        entry: `src/preload/${page}.ts`,
        formats: ["cjs"],
        fileName: () => `${page}.js`,
      },
      rollupOptions: { external: ["electron"] },
      minify: false,
    },
  });
}
