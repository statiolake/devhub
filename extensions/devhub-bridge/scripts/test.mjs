import { build } from "esbuild";
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const temp = resolve(root, ".test-build");
await rm(temp, { recursive: true, force: true });
await mkdir(temp, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: [
    "test/session.test.ts",
    "test/registry.test.ts",
    "test/controller.test.ts",
    "test/navigation.test.ts",
    "test/transport.test.ts",
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: temp,
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
});
const child = spawn(
  process.execPath,
  [
    "--test",
    ...(await readdir(temp))
      .filter((entry) => entry.endsWith(".mjs"))
      .map((entry) => resolve(temp, entry)),
  ],
  {
    cwd: resolve(root, "../.."),
    stdio: "inherit",
  },
);
const exitCode = await new Promise((resolveExit) =>
  child.on("exit", (code) => resolveExit(code ?? 1)),
);
await rm(temp, { recursive: true, force: true });
if (exitCode !== 0) process.exit(exitCode);
