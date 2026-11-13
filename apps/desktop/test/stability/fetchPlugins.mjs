// Clone the plugins plugins.json pins, each at its commit, into a cache that
// outlives a run: ~/.cache/devhub/stability-plugins/<name>-<commit> (or
// $DEVHUB_STABILITY_PLUGINS). A directory already there is that commit, since
// the commit is in its name; one half-made by an interrupted run is not
// renamed into place, so it never counts.
//
//   node fetchPlugins.mjs      prints the directories, one per line
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export function pluginCache() {
  return (
    process.env.DEVHUB_STABILITY_PLUGINS ??
    join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
      "devhub",
      "stability-plugins",
    )
  );
}

export function fetchPlugins() {
  const { plugins } = JSON.parse(
    readFileSync(join(here, "plugins.json"), "utf8"),
  );
  const cache = pluginCache();
  mkdirSync(cache, { recursive: true });
  const dirs = {};
  for (const plugin of plugins) {
    const dir = join(cache, `${plugin.name}-${plugin.commit.slice(0, 12)}`);
    if (!existsSync(dir)) {
      const partial = `${dir}.partial-${process.pid}`;
      rmSync(partial, { recursive: true, force: true });
      const git = (...args) =>
        execFileSync("git", ["-C", partial, ...args], { stdio: "pipe" });
      mkdirSync(partial);
      git("init", "-q");
      git("remote", "add", "origin", plugin.url);
      git("fetch", "-q", "--depth", "1", "origin", plugin.commit);
      git("-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD");
      const head = git("rev-parse", "HEAD").toString().trim();
      if (head !== plugin.commit)
        throw new Error(
          `${plugin.name}: fetched ${head}, pinned ${plugin.commit}`,
        );
      renameSync(partial, dir);
    }
    dirs[plugin.name] = dir;
  }
  return dirs;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, dir] of Object.entries(fetchPlugins()))
    console.log(`${name}\t${dir}`);
}
