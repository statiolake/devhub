/**
 * One preload bundle per page.
 *
 * A preload is one CommonJS file with no module resolver behind it (a
 * sandboxed one has none at all) — so each of these is a bundle, not a tsc emit, and each has to be *whole*. That is why
 * this is one build per page rather than one build with an entry each: a multi-entry
 * build hoists what the entries share into a chunk, and a chunk is a `require`
 * a sandboxed preload cannot answer. The pages share `preload/bridge.ts` as
 * source and never as a file.
 *
 * Which preload a page is loaded with is what decides what that page can
 * spell — see `ipc/contract.ts` and `main/shell/bootstrapShell.ts`.
 */

import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { build } from "vite";

const PAGES = [
  "shell",
  "sidebar",
  "agents",
  "pane",
  "toasts",
  "tooltip",
  "picker",
  "settings",
  "taskManager",
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

// The bundles are CommonJS, and `apps/desktop/package.json` says `"type":
// "module"`: without a `package.json` of their own beside them, a renderer
// that loads its preload with Node's `require` (an unsandboxed one) reads
// them as ES modules and fails on the first `require`.
writeFileSync(
  `${root}/out/preload/package.json`,
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);
