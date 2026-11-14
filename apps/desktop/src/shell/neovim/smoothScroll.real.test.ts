/**
 * The settling request of pixel scrolling (`SCROLL_LUA`, exact) in a real
 * Neovim: over a wrapped line, Neovim can only go by whole lines, and the
 * line it lands on must not make the display go back against the way it
 * was going.
 *
 * DevHub's own Neovim (`testNeovim.ts`).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCROLL_LUA } from "./smoothScroll";
import { TEST_NVIM } from "../../main/editor/testNeovim";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The topline after a settling request of `n` rows, going `toward`. */
function settle(n: number, toward: number): number {
  const directory = mkdtempSync(join(tmpdir(), "devhub-sms-"));
  directories.push(directory);
  const chunk = join(directory, "scroll.lua");
  writeFileSync(chunk, SCROLL_LUA);
  const script = join(directory, "run.lua");
  // Line 20 wraps over two rows (the window is 80 columns); the view's top
  // is line 21, under it.
  writeFileSync(
    script,
    `
vim.o.columns = 80
vim.o.lines = 24
vim.o.mouse = 'a'
local lines = {}
for i = 1, 100 do lines[i] = 'line ' .. i end
lines[20] = string.rep('x', 120)
vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
vim.wo.wrap = true
vim.fn.winrestview({ topline = 21, lnum = 30 })
local f = assert(loadfile(${JSON.stringify(chunk)}))
f(vim.api.nvim_get_current_win(), ${String(n)}, 1, 0, 0, true, 0, 0, ${String(toward)})
io.stdout:write(tostring(vim.fn.line('w0')))
`,
  );
  return Number(
    execFileSync(TEST_NVIM as string, ["--clean", "--headless", "-l", script])
      .toString()
      .trim(),
  );
}

describe.skipIf(TEST_NVIM === undefined)("settling over a wrapped line", () => {
  it("asked one row back while going down, stays: two rows back is past the display", () => {
    expect(settle(-1, 1)).toBe(21);
  });

  it("asked one row back while going up, goes the whole line back", () => {
    expect(settle(-1, -1)).toBe(20);
  });
});
