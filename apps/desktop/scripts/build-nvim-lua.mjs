/**
 * DevHub's setup Lua as bytecode, for Neovim to load at each attach without
 * compiling it (`src/main/editor/neovimBytecode.ts`): `out/nvim-lua/setup.json`,
 * compiled by the Neovim `build:binaries` unpacked (`out/nvim`) from the chunks
 * `build:main` emitted (`SETUP_CHUNKS`). Both run before this in `build`.
 *
 * The packaged app carries it inside `out/` (`scripts/package-nightly.py`).
 * Without it, or for a source edited since, DevHub sends the source.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const editor = join(root, "out", "main", "editor");
const { SETUP_CHUNKS } = await import(
  pathToFileURL(join(editor, "neovimUi.js")).href
);
const { compileLua, compiledLuaPath } = await import(
  pathToFileURL(join(editor, "neovimBytecode.js")).href
);

const nvim = join(root, "out", "nvim", "bin", "nvim");
const compiled = compileLua(nvim, SETUP_CHUNKS);
const target = compiledLuaPath(root);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(`${target}.part`, `${JSON.stringify(compiled)}\n`);
renameSync(`${target}.part`, target);
console.log(
  `build-nvim-lua: ${SETUP_CHUNKS.length} chunks for Neovim ${compiled.nvimVersion}`,
);
