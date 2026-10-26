import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COLOR_DEFAULTS } from "./colorDefaults.generated.js";
import { colorIdList } from "./colorIds.js";

const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VSCODE = join(APP_ROOT, "..", "..", "vscode");
const REGISTRY = join(
  VSCODE,
  "src",
  "vs",
  "platform",
  "theme",
  "common",
  "colorRegistry.ts",
);

describe("the generated colour defaults", () => {
  it("have every colour DevHub reads", () => {
    for (const id of colorIdList()) {
      expect(COLOR_DEFAULTS[id], id).toBeDefined();
    }
  });

  // Only where the submodule is checked out: the table is what makes the app
  // and these tests independent of it. Where it is, a VS Code bump that moved
  // a default fails here until the table is generated again.
  it.skipIf(!existsSync(REGISTRY))(
    "are what the pinned VS Code registers",
    () => {
      expect(() =>
        execFileSync(
          process.execPath,
          [
            join(APP_ROOT, "scripts", "generate-color-defaults.mjs"),
            "--check",
            "--vscode",
            VSCODE,
          ],
          { stdio: "pipe" },
        ),
      ).not.toThrow();
    },
    60_000,
  );
});
