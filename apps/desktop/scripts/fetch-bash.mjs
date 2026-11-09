/**
 * The bash inside DevHub, unpacked into `out/bash` (`bin/bash`,
 * `licenses/bash.txt`): every bash DevHub runs on this machine is this one,
 * never one found on the PATH (`docs/bundled-binaries.md`). See
 * `src/main/runtime/bundledBash.ts`.
 *
 * - **Linux** (`linux-x64`, `linux-arm64`): the static bash DevHub publishes
 *   and delivers to SSH hosts (`scripts/build_bash.py`), the release
 *   `product.json` pins (`bashVersion`, `bashDownloadSha256`) — the same
 *   bytes a host is given.
 * - **macOS** (`darwin-arm64`): no static libc exists there, so nothing is
 *   published; the same `scripts/build_bash.py` builds the same pinned source
 *   and patches here, linked against libSystem alone (a few minutes with the
 *   Xcode command line tools, which the app build needs anyway). Packaging
 *   signs it (`scripts/package-nightly.py`).
 *
 * The tarball is cached under `~/.cache/devhub/bash/` (`$XDG_CACHE_HOME`),
 * so a rebuild neither downloads, compiles nor unpacks again:
 * `out/bash/.devhub-bash` says which tarball the tree came from.
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

const root = fileURLToPath(new URL("..", import.meta.url));
const repository = join(root, "..", "..");
const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));
const version = product.bashVersion;

const arch = process.arch === "arm64" ? "arm64" : "x64";
const platform = `${process.platform}-${arch}`;
const [os, cpu] = platform.split("-");
const pin = product.bashDownloadSha256?.[platform];
if (pin === undefined && platform !== "darwin-arm64") {
  console.error(
    `fetch-bash: product.json pins no bash for ${platform} ` +
      `(pinned: ${Object.keys(product.bashDownloadSha256 ?? {}).join(", ")}; ` +
      `darwin-arm64 is built from source)`,
  );
  process.exit(1);
}

// `build_bash.py`'s `tarball_name` and `top_level_dir`.
const name = `devhub-bash-${os}-${cpu}-${version}.tar.gz`;
const top = `devhub-bash-${os}-${cpu}`;
const identity = pin ?? `built ${name}`;

const target = join(root, "out", "bash");
const stamp = join(target, ".devhub-bash");
if (
  existsSync(stamp) &&
  readFileSync(stamp, "utf8").trim() === identity &&
  existsSync(join(target, "bin", "bash"))
) {
  console.log(`fetch-bash: out/bash is bash ${version} already`);
  process.exit(0);
}

const cache = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "devhub",
  "bash",
);
const archive = join(cache, name);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (pin === undefined) {
  if (!existsSync(archive)) {
    console.log(`fetch-bash: building bash ${version} for ${platform}`);
    mkdirSync(cache, { recursive: true });
    execFileSync(
      "python3",
      [
        join(repository, "scripts", "build_bash.py"),
        platform,
        "--out-dir",
        cache,
        "--work-dir",
        join(cache, "work"),
      ],
      { stdio: "inherit" },
    );
  }
} else {
  let bytes = existsSync(archive) ? readFileSync(archive) : undefined;
  if (bytes === undefined || sha256(bytes) !== pin) {
    const url = product.bashDownloadUrlTemplate
      .replaceAll("${bashVersion}", version)
      .replaceAll("${os}", os)
      .replaceAll("${arch}", cpu);
    console.log(`fetch-bash: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      console.error(
        `fetch-bash: ${url} answered ${response.status} ${response.statusText}`,
      );
      process.exit(1);
    }
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== pin) {
      console.error(
        `fetch-bash: ${url} hashes to ${sha256(bytes)}; product.json pins ${pin}`,
      );
      process.exit(1);
    }
    mkdirSync(cache, { recursive: true });
    writeFileSync(`${archive}.part`, bytes);
    renameSync(`${archive}.part`, archive);
  }
}

// Unpacked beside the target and renamed into place, so an interrupted build
// leaves no half a bash behind the name.
const staging = `${target}.unpacking`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
rmSync(target, { recursive: true, force: true });
renameSync(join(staging, top), target);
rmSync(staging, { recursive: true, force: true });
writeFileSync(stamp, `${identity}\n`);
console.log(`fetch-bash: out/bash is bash ${version} (${platform})`);
