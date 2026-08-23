import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "dist");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ["src/extension.ts", "src/session.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  outdir: "dist",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
});

console.log("DevHub Bridge extension built");
