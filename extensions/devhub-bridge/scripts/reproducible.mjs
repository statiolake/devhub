import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const output = resolve(
  root,
  "build",
  `devhub-bridge-${packageJson.version}.vsix`,
);

async function run(script) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve(root, "scripts", script)], {
      cwd: root,
      stdio: "inherit",
    });
    child.on("error", rejectRun);
    child.on("close", (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${script} failed`)),
    );
  });
}

async function digest() {
  return createHash("sha256")
    .update(await readFile(output))
    .digest("hex");
}

const digests = [];
for (let index = 0; index < 2; index += 1) {
  await run("build.mjs");
  await run("package.mjs");
  digests.push(await digest());
}
if (digests[0] !== digests[1]) {
  throw new Error("VSIX rebuild is not deterministic");
}
console.log(`Deterministic VSIX SHA-256: ${digests[0]}`);
