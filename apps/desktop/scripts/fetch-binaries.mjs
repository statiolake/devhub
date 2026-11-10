/**
 * Every binary DevHub bundles that it does not compile in this build: one
 * fetch, for every architecture the app carries (`docs/bundled-binaries.md`).
 *
 * `product.json` pins each asset by URL and sha256, one per `<os>-<arch>`:
 *
 * - `tools`: DevHub's own tools release (`scripts/build_tools.py`,
 *   `tools-<toolsVersion>`). Each tarball holds tmux and bash, the tools
 *   with no good upstream distribution, as their build scripts wrote them.
 * - `nvim`, `node`, `rg`, `fd`: upstream's own releases. Neovim's, Node's
 *   official LTS, and ripgrep's and fd's static musl builds.
 *
 * What it writes:
 *
 *     out/nvim, out/tmux, out/bash    this machine's, unpacked, where the app
 *                                     runs them from
 *     out/host-tools/<os>-<arch>/     each Linux host's tools, as tarballs,
 *                                     sent over SSH as they are
 *                                     (`src/main/runtime/toolDelivery.ts`)
 *     out/host-tools/manifest.json    what is there: per tool its version, and
 *                                     per platform the file, its sha256, its one
 *                                     directory and where the binary is in it
 *
 * Nothing is downloaded at runtime. An SSH host gets what this step put in
 * the app.
 *
 * Downloads are cached under `~/.cache/devhub/downloads/` (`$XDG_CACHE_HOME`)
 * and checked against the pin every time, so a build with a warm cache needs
 * no network.
 *
 * `DEVHUB_TOOLS_DIR=<dir>` takes the `tools` assets from a local
 * `scripts/build_tools.py` run instead of the release. The directory holds
 * `devhub-tools-<toolsVersion>-<os>-<arch>.tar.gz` and their `SHA256SUMS`,
 * and that file states their digests instead of `product.json`. This is for
 * testing a tools change before its release exists. A packaged build refuses
 * it (`scripts/package-nightly.py` checks the manifest).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { download } from "./download.mjs";

const LABEL = "fetch-binaries";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "out");
const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));

/** The Linux machines DevHub reaches over SSH. */
const HOSTS = ["linux-x64", "linux-arm64"];
/** The tools a host is given from the bundle, beside the `devhub` command. */
const HOST_TOOLS = ["tmux", "bash", "nvim", "node", "rg", "fd"];
/** The tools inside DevHub's own tools release. */
const RELEASE_TOOLS = ["tmux", "bash"];

const here = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
if (!["darwin-arm64", ...HOSTS].includes(here)) {
  fail(
    `DevHub bundles for darwin-arm64, linux-x64 and linux-arm64, not ${here}`,
  );
}

const cache = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "devhub",
  "downloads",
);
const localTools = process.env.DEVHUB_TOOLS_DIR || undefined;

function fail(message) {
  console.error(`${LABEL}: ${message}`);
  process.exit(1);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The path of one pinned asset, verified, from the cache or downloaded. */
async function asset(tool, platform) {
  if (tool === "tools" && localTools !== undefined) return localTool(platform);
  const url = product[`${tool}DownloadUrls`]?.[platform];
  const pin = product[`${tool}DownloadSha256`]?.[platform];
  if (url === undefined) fail(`product.json states no ${tool} for ${platform}`);
  if (!/^[0-9a-f]{64}$/u.test(pin ?? "")) {
    fail(
      `product.json pins no sha256 for ${tool} ${platform} (${url}). ` +
        (tool === "tools"
          ? `Copy toolsDownloadSha256 from the tools-${product.toolsVersion} ` +
            "release's SHA256SUMS, or build the tools with scripts/build_tools.py " +
            "and set DEVHUB_TOOLS_DIR to their directory."
          : "Pin the sha256 the upstream release states."),
    );
  }
  const version = product[`${tool}Version`];
  const path = join(cache, `${tool}-${version}-${platform}-${basename(url)}`);
  if (existsSync(path) && sha256(readFileSync(path)) === pin) return path;
  console.log(`${LABEL}: ${url}`);
  const bytes = await download(LABEL, url);
  if (sha256(bytes) !== pin) {
    fail(`${url} hashes to ${sha256(bytes)}; product.json pins ${pin}`);
  }
  mkdirSync(cache, { recursive: true });
  writeFileSync(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
  return path;
}

function localTool(platform) {
  const name = `devhub-tools-${product.toolsVersion}-${platform}.tar.gz`;
  const path = join(localTools, name);
  const sums = readFileSync(join(localTools, "SHA256SUMS"), "utf8");
  const stated = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+\*?/u))
    .find(([, file]) => file === name)?.[0];
  if (stated === undefined || !existsSync(path)) {
    fail(`DEVHUB_TOOLS_DIR=${localTools} has no ${name} in its SHA256SUMS`);
  }
  if (sha256(readFileSync(path)) !== stated) {
    fail(`${path} is not the sha256 its SHA256SUMS states`);
  }
  console.log(
    `${LABEL}: tools for ${platform} from ${path} (DEVHUB_TOOLS_DIR)`,
  );
  return path;
}

/** The one directory every entry of a tarball is under. */
function topLevel(archive, binary) {
  const names = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  const roots = new Set(names.map((name) => name.split("/")[0]));
  if (roots.size !== 1) {
    fail(`${archive} holds ${roots.size} top-level entries, not one directory`);
  }
  const [top] = roots;
  if (binary !== undefined && !names.includes(`${top}/${binary}`)) {
    fail(`${archive} has no ${top}/${binary}`);
  }
  return top;
}

/** Where the binary is in its tool's directory (`toolBinaryPath`). */
const binaryPath = (tool) =>
  tool === "rg" || tool === "fd" ? tool : `bin/${tool}`;

/** Unpacks `archive` into `out/<name>`, unless the stamp says it is there. */
function unpackInto(name, archive, identity) {
  const target = join(out, name);
  const stamp = join(target, ".devhub-source");
  if (
    existsSync(stamp) &&
    readFileSync(stamp, "utf8").trim() === identity &&
    existsSync(join(target, "bin", name))
  ) {
    return false;
  }
  const top = topLevel(archive, `bin/${name}`);
  // Beside the target and renamed into place, so an interrupted build
  // leaves no half a tool behind the name.
  const staging = `${target}.unpacking`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
  rmSync(target, { recursive: true, force: true });
  renameSync(join(staging, top), target);
  rmSync(staging, { recursive: true, force: true });
  writeFileSync(stamp, `${identity}\n`);
  return true;
}

/**
 * The tools release's tarball for one platform, opened: its `tools.json`,
 * checked against `product.json`, and each tool's tarball verified.
 */
function openTools(archive, platform) {
  const directory = join(
    cache,
    "tools-unpacked",
    `${platform}-${sha256(readFileSync(archive)).slice(0, 16)}`,
  );
  const top = `devhub-tools-${platform}`;
  if (!existsSync(join(directory, top, "tools.json"))) {
    rmSync(`${directory}.part`, { recursive: true, force: true });
    mkdirSync(`${directory}.part`, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", `${directory}.part`]);
    rmSync(directory, { recursive: true, force: true });
    renameSync(`${directory}.part`, directory);
  }
  const manifest = JSON.parse(
    readFileSync(join(directory, top, "tools.json"), "utf8"),
  );
  if (manifest.toolsVersion !== product.toolsVersion) {
    fail(
      `${archive} is tools ${manifest.toolsVersion}; product.json pins ${product.toolsVersion}`,
    );
  }
  const tools = {};
  for (const tool of RELEASE_TOOLS) {
    const entry = manifest.tools?.[tool];
    if (entry?.version !== product[`${tool}Version`]) {
      fail(
        `${archive} holds ${tool} ${entry?.version}; product.json pins ${product[`${tool}Version`]}`,
      );
    }
    const path = join(directory, top, entry.file);
    if (sha256(readFileSync(path)) !== entry.sha256) {
      fail(`${archive}: ${entry.file} is not the sha256 its tools.json states`);
    }
    tools[tool] = { path, sha256: entry.sha256 };
  }
  return tools;
}

/** This platform's tarball of each host tool, and its digest. */
async function toolArchives(platform, tools) {
  const archives = {};
  for (const tool of HOST_TOOLS) {
    if (RELEASE_TOOLS.includes(tool)) {
      archives[tool] = tools[tool];
    } else {
      const path = await asset(tool, platform);
      archives[tool] = {
        path,
        sha256: product[`${tool}DownloadSha256`][platform],
      };
    }
  }
  return archives;
}

// --- this machine's ---------------------------------------------------------

const release = {};
for (const platform of new Set([here, ...HOSTS])) {
  release[platform] = openTools(await asset("tools", platform), platform);
}

const nvim = await asset("nvim", here);
const unpacked = [
  unpackInto("nvim", nvim, product.nvimDownloadSha256[here]) && "nvim",
  unpackInto("tmux", release[here].tmux.path, release[here].tmux.sha256) &&
    "tmux",
  unpackInto("bash", release[here].bash.path, release[here].bash.sha256) &&
    "bash",
].filter(Boolean);
const reported = execFileSync(join(out, "tmux", "bin", "tmux"), ["-V"], {
  encoding: "utf8",
}).trim();
if (reported !== `tmux ${product.tmuxVersion}`) {
  fail(
    `out/tmux/bin/tmux says ${JSON.stringify(reported)}; product.json pins tmux ${product.tmuxVersion}`,
  );
}

// --- every host's -----------------------------------------------------------

const hostTools = join(out, "host-tools");
const manifest = { tools: {} };
for (const tool of HOST_TOOLS) {
  manifest.tools[tool] = {
    version: product[`${tool}Version`],
    binary: binaryPath(tool),
    platforms: {},
  };
}
let copied = 0;
for (const platform of HOSTS) {
  const archives = await toolArchives(platform, release[platform]);
  for (const tool of HOST_TOOLS) {
    const { path, sha256: digest } = archives[tool];
    const file = `${platform}/${tool}-${product[`${tool}Version`]}.tar.gz`;
    const target = join(hostTools, file);
    if (
      !existsSync(target) ||
      statSync(target).size !== statSync(path).size ||
      sha256(readFileSync(target)) !== digest
    ) {
      mkdirSync(join(hostTools, platform), { recursive: true });
      copyFileSync(path, `${target}.part`);
      renameSync(`${target}.part`, target);
      copied += 1;
    }
    manifest.tools[tool].platforms[platform] = {
      file,
      sha256: digest,
      topLevelDirectory: topLevel(path, binaryPath(tool)),
    };
  }
}
if (localTools !== undefined) manifest.localTools = localTools;
writeFileSync(
  join(hostTools, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(
  `${LABEL}: out/nvim, out/tmux, out/bash for ${here}` +
    (unpacked.length > 0
      ? ` (unpacked ${unpacked.join(", ")})`
      : " (as they were)") +
    `; out/host-tools for ${HOSTS.join(", ")} (${copied} copied)`,
);
