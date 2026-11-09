/**
 * The Neovim inside DevHub, unpacked into `out/nvim` (`bin/nvim`, `lib/`,
 * `share/nvim/runtime`): Neovim's own release archive for this machine, at
 * the version `product.json` pins (`nvimVersion`) and checked against its
 * `nvimDownloadSha256`. See `src/main/editor/bundledNeovim.ts`.
 *
 * The archive is cached under `~/.cache/devhub/nvim/` (`$XDG_CACHE_HOME`), so
 * a rebuild neither downloads nor unpacks again: `out/nvim/.devhub-sha256`
 * says which archive the tree came from. The packaged app carries `out/` as
 * it is (`scripts/package-nightly.py`, which signs `bin/nvim` and the
 * parsers).
 *
 * `--platform <os>-<arch>` fetches another machine's (`linux-x64`); the
 * default is this one's. DevHub runs on Apple Silicon, and is developed and
 * tested on Linux, so those are the platforms pinned.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { download } from "./download.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));

const flag = process.argv.indexOf("--platform");
const arch = process.arch === "arm64" ? "arm64" : "x64";
const platform =
  flag === -1 ? `${process.platform}-${arch}` : process.argv[flag + 1];
const pin = product.nvimDownloadSha256?.[platform];
if (pin === undefined) {
  console.error(
    `fetch-neovim: product.json pins no Neovim for ${platform} ` +
      `(pinned: ${Object.keys(product.nvimDownloadSha256 ?? {}).join(", ")})`,
  );
  process.exit(1);
}

// Neovim's own spelling of the platform (`toolDelivery.ts`'s
// `neovimReleasePlatform`).
const [os, cpu] = platform.split("-");
const release = `${os === "darwin" ? "macos" : os}-${cpu === "x64" ? "x86_64" : cpu}`;
const url = product.nvimDownloadUrlTemplate
  .replaceAll("${nvimVersion}", product.nvimVersion)
  .replaceAll("${nvimPlatform}", release);

const target = join(root, "out", "nvim");
const stamp = join(target, ".devhub-sha256");
if (
  existsSync(stamp) &&
  readFileSync(stamp, "utf8").trim() === pin &&
  existsSync(join(target, "bin", "nvim"))
) {
  console.log(
    `fetch-neovim: out/nvim is Neovim ${product.nvimVersion} already`,
  );
  process.exit(0);
}

const cache = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "devhub",
  "nvim",
);
const archive = join(cache, `nvim-${release}-${product.nvimVersion}.tar.gz`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let bytes = existsSync(archive) ? readFileSync(archive) : undefined;
if (bytes === undefined || sha256(bytes) !== pin) {
  console.log(`fetch-neovim: ${url}`);
  bytes = await download("fetch-neovim", url);
  if (sha256(bytes) !== pin) {
    console.error(
      `fetch-neovim: ${url} hashes to ${sha256(bytes)}; product.json pins ${pin}`,
    );
    process.exit(1);
  }
  mkdirSync(cache, { recursive: true });
  writeFileSync(`${archive}.part`, bytes);
  renameSync(`${archive}.part`, archive);
}

// Unpacked beside the target and renamed into place, so an interrupted build
// leaves no half a Neovim behind the name.
const staging = `${target}.unpacking`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
rmSync(target, { recursive: true, force: true });
renameSync(join(staging, `nvim-${release}`), target);
rmSync(staging, { recursive: true, force: true });
writeFileSync(stamp, `${pin}\n`);
console.log(
  `fetch-neovim: out/nvim is Neovim ${product.nvimVersion} (${release})`,
);
