/**
 * The tmux inside DevHub, unpacked into `out/tmux` (`bin/tmux`, `terminfo/`,
 * `licenses/`): the tmux 3.x `product.json` pins (`tmuxVersion`), built by
 * `scripts/build_tmux.py` — the same build, the same pins and the same
 * tarball layout a host is given under `~/.devhub-server/tmux/<version>/`.
 * See `src/main/terminal/bundledTmux.ts`.
 *
 * Linux (`linux-x64`, `linux-arm64`): the static tarball published on the
 * `tmux-<version>` release, checked against `product.json`'s
 * `tmuxDownloadSha256` — byte for byte the one a host gets.
 *
 * macOS (`darwin-arm64`): there is no published tarball (hosts are Linux), so
 * `build_tmux.py darwin-arm64` builds it here: libevent and ncurses linked in,
 * libSystem the only library it loads. A few minutes the first time; the
 * tarball is kept, keyed by the build script's own digest, so a rebuild of
 * DevHub neither compiles nor unpacks again until the script (and with it a
 * pin) changes.
 *
 * Both are cached under `~/.cache/devhub/tmux/` (`$XDG_CACHE_HOME`);
 * `out/tmux/.devhub-source` says which tarball the tree came from. The
 * packaged app carries `out/` as it is (`scripts/package-nightly.py`, which
 * signs `bin/tmux`).
 *
 * `--platform <os>-<arch>` fetches another Linux's (`linux-arm64`); the
 * default is this machine's.
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
const repo = join(root, "..", "..");
const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));
const version = product.tmuxVersion;

const flag = process.argv.indexOf("--platform");
const arch = process.arch === "arm64" ? "arm64" : "x64";
const platform =
  flag === -1 ? `${process.platform}-${arch}` : process.argv[flag + 1];
const [os, cpu] = platform.split("-");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cache = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "devhub",
  "tmux",
);
// `build_tmux.py`'s names for the tarball and its one directory.
const tarballName = `devhub-tmux-${platform}-${version}.tar.gz`;

/** The verified tarball for this platform, and what it is (the stamp). */
async function tarball() {
  if (os === "linux") return published();
  if (platform === "darwin-arm64") return built();
  console.error(
    `fetch-tmux: DevHub bundles tmux for darwin-arm64, linux-x64 and linux-arm64, not ${platform}`,
  );
  process.exit(1);
}

async function published() {
  const pin = product.tmuxDownloadSha256?.[platform];
  if (pin === undefined) {
    console.error(
      `fetch-tmux: product.json pins no tmux for ${platform} ` +
        `(pinned: ${Object.keys(product.tmuxDownloadSha256 ?? {}).join(", ")})`,
    );
    process.exit(1);
  }
  const archive = join(cache, tarballName);
  let bytes = existsSync(archive) ? readFileSync(archive) : undefined;
  if (bytes === undefined || sha256(bytes) !== pin) {
    const url = product.tmuxDownloadUrlTemplate
      .replaceAll("${tmuxVersion}", version)
      .replaceAll("${os}", os)
      .replaceAll("${arch}", cpu);
    console.log(`fetch-tmux: ${url}`);
    bytes = await download("fetch-tmux", url);
    if (sha256(bytes) !== pin) {
      console.error(
        `fetch-tmux: ${url} hashes to ${sha256(bytes)}; product.json pins ${pin}`,
      );
      process.exit(1);
    }
    mkdirSync(cache, { recursive: true });
    writeFileSync(`${archive}.part`, bytes);
    renameSync(`${archive}.part`, archive);
  }
  return { archive, stamp: `${platform} ${version} sha256:${pin}` };
}

function built() {
  if (`${process.platform}-${arch}` !== platform) {
    console.error(
      `fetch-tmux: the darwin-arm64 tmux is built on a Mac with Apple Silicon, not on ${process.platform}-${arch}`,
    );
    process.exit(1);
  }
  const script = join(repo, "scripts", "build_tmux.py");
  const key = sha256(readFileSync(script)).slice(0, 16);
  const directory = join(cache, `${platform}-${version}-${key}`);
  const archive = join(directory, tarballName);
  if (!existsSync(archive)) {
    console.log(
      `fetch-tmux: building tmux ${version} for ${platform} (scripts/build_tmux.py, a few minutes once)`,
    );
    const work = join(cache, "build");
    rmSync(`${directory}.part`, { recursive: true, force: true });
    execFileSync(
      "python3",
      [script, platform, "--out-dir", `${directory}.part`, "--work-dir", work],
      { stdio: "inherit" },
    );
    rmSync(directory, { recursive: true, force: true });
    renameSync(`${directory}.part`, directory);
    // The sources and objects are hundreds of megabytes; the tarball is kept.
    rmSync(work, { recursive: true, force: true });
  }
  return { archive, stamp: `${platform} ${version} build_tmux.py:${key}` };
}

const target = join(root, "out", "tmux");
const stampFile = join(target, ".devhub-source");
const { archive, stamp } = await tarball();
if (
  existsSync(stampFile) &&
  readFileSync(stampFile, "utf8").trim() === stamp &&
  existsSync(join(target, "bin", "tmux"))
) {
  console.log(`fetch-tmux: out/tmux is tmux ${version} already`);
  process.exit(0);
}

// Unpacked beside the target and renamed into place, so an interrupted build
// leaves no half a tmux behind the name.
const staging = `${target}.unpacking`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
rmSync(target, { recursive: true, force: true });
renameSync(join(staging, `devhub-tmux-${platform}`), target);
rmSync(staging, { recursive: true, force: true });
const reported = execFileSync(join(target, "bin", "tmux"), ["-V"], {
  encoding: "utf8",
}).trim();
if (reported !== `tmux ${version}`) {
  console.error(
    `fetch-tmux: out/tmux/bin/tmux says ${JSON.stringify(reported)}; product.json pins tmux ${version}`,
  );
  process.exit(1);
}
writeFileSync(stampFile, `${stamp}\n`);
console.log(`fetch-tmux: out/tmux is ${reported} (${platform})`);
