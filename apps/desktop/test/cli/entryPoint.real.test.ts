/**
 * The bundles run when they are run, including through a symlink.
 *
 * This is defect (A), and it is a test with a real Node in it because nothing
 * smaller reproduces it: the fault was in how Node's ESM loader names a module
 * (`import.meta.url` is realpathed) against how a shell names it
 * (`process.argv[1]` is not), and a fake of either one would have been written
 * by the same person who got the rule wrong. The host it was found on has
 * `/home` as a symlink to `/volume1/home`, so every path DevHub wrote there
 * went through one.
 *
 * What is asserted is the shape of the failure and not only the fix: a bundle
 * that decides not to run must not be able to exit 0 having printed nothing,
 * because that is indistinguishable from a bundle that did its job — and it is
 * exactly what every DevHub terminal tab on that host did.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "devhub-entry-"));

afterAll(() => {
  // Left behind deliberately only when a test failed and someone will look.
});

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: "/usr/bin:/bin", HOME: scratch, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * The bundle the build produces, built here so the test does not depend on
 * whether anybody ran the build first — same esbuild, same flags.
 */
async function bundle(entry: string, name: string): Promise<string> {
  const real = join(scratch, "real");
  const outfile = join(real, name);
  await build({
    entryPoints: [join(APP_ROOT, "src", "main", entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile,
  });
  writeFileSync(join(real, "package.json"), '{"type":"module"}\n');
  return outfile;
}

describe("the bundled entry points", () => {
  it("runs through a symlinked directory instead of exiting 0 in silence", async () => {
    const real = await bundle(
      "terminal/devhubTerminalEntry.ts",
      "devhub-terminal.bundle.js",
    );
    // The host's shape: the path the script is called by goes through a
    // symlink, so `import.meta.url` and `process.argv[1]` name one file with
    // two strings.
    const linked = join(scratch, "linked");
    symlinkSync(join(scratch, "real"), linked);
    const viaLink = join(linked, "devhub-terminal.bundle.js");

    const answer = await run(viaLink, [], {
      DEVHUB_CONTROL_SOCKET: join(scratch, "nothing-is-here.sock"),
      DEVHUB_TERMINAL_MACHINE: "local",
    });

    expect({ code: answer.code, silent: answer.stderr === "" }).toEqual({
      code: 1,
      silent: false,
    });
    expect(answer.stderr).toContain("devhub-terminal:");
    expect(answer.stderr).toContain("DevHub is not listening on");
    expect(answer.stdout).toBe("");
    // And the same file called by its own name behaves identically, which is
    // what "one rule" means here.
    const direct = await run(real, [], {
      DEVHUB_CONTROL_SOCKET: join(scratch, "nothing-is-here.sock"),
      DEVHUB_TERMINAL_MACHINE: "local",
    });
    expect(direct.code).toBe(1);
    expect(direct.stderr).toBe(answer.stderr);
  }, 30_000);

  it("gives the CLI's usage through a symlinked directory too", async () => {
    await bundle("cli/devhubCliEntry.ts", "devhub-cli.bundle.js");
    const viaLink = join(scratch, "linked", "devhub-cli.bundle.js");
    const answer = await run(viaLink, ["--help"], {});
    expect(answer.code).toBe(0);
    expect(answer.stdout).toContain("devhub — drive the running DevHub");
  }, 30_000);
});
