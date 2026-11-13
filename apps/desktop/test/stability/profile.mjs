// The fixed world a stability run starts in: a throwaway HOME, the
// `stability` profile's settings (fixed fonts, a fixed theme), the Neovim
// config with the pinned plugins, and two sample Workspaces whose files are
// the same on every run.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const appDir = join(here, "..", "..");

export const PROFILE = "stability";
export const FONT = "DejaVu Sans Mono";
export const THEME_LIGHT = "DevHub Light";
export const THEME_DARK = "DevHub Dark";

export function configSchemaVersion() {
  const config = readFileSync(
    join(appDir, "out", "model", "config.js"),
    "utf8",
  );
  const match = /CONFIG_SCHEMA_VERSION = (\d+)/.exec(config);
  if (!match)
    throw new Error("no CONFIG_SCHEMA_VERSION in out/model/config.js");
  return Number(match[1]);
}

/** Where everything of a run lives, under `root`. */
export function profilePaths(root) {
  return {
    root,
    home: join(root, "home"),
    config: join(root, "config"),
    state: join(root, "state"),
    tmux: join(root, "tmux"),
    workspaceA: join(root, "home", "work", "alpha"),
    workspaceB: join(root, "home", "work", "beta"),
    settings: join(root, "config", `devhub-${PROFILE}`, "settings.toml"),
  };
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  // Whole, then renamed: the app's settings watcher never reads half a file.
  writeFileSync(`${path}.partial`, text);
  renameSync(`${path}.partial`, path);
}

export function writeSettings(paths, mode) {
  write(
    paths.settings,
    `version = ${configSchemaVersion()}\n\n` +
      "[appearance]\n" +
      `mode = "${mode}"\n` +
      `theme = "light:${THEME_LIGHT},dark:${THEME_DARK}"\n` +
      `terminal_font_family = "'${FONT}'"\n` +
      "terminal_font_size = 13\n\n" +
      // A conversation Agent that is never a model (fixture/fake-claude.mjs).
      "[[agent_profiles]]\n" +
      'id = "fake"\n' +
      'display_name = "Fake"\n' +
      'kind = "claude"\n' +
      `command = ${JSON.stringify(join(here, "fixture", "fake-claude.mjs"))}\n` +
      'presentation = "gui"\n',
  );
}

const SOURCE = (n) =>
  [
    `// module ${n}: a fixed file for the stability harness`,
    `export function value${n}(input: number): number {`,
    `  const doubled = input * 2;`,
    `  const shifted = doubled + ${n};`,
    `  return shifted;`,
    `}`,
    ``,
    ...Array.from(
      { length: 60 },
      (_, i) => `export const line${i} = value${n}(${i});`,
    ),
    ``,
  ].join("\n");

function sampleWorkspace(dir, name) {
  write(
    join(dir, "README.md"),
    `# ${name}\n\nThe stability harness's sample workspace.\n`,
  );
  write(join(dir, "package.json"), `{ "name": "${name}", "private": true }\n`);
  for (const folder of ["core", "ui", "util"]) {
    for (let i = 0; i < 6; i++)
      write(join(dir, "src", folder, `${folder}${i}.ts`), SOURCE(i));
  }
  // A folder long enough to scroll under the tree's sticky header.
  for (let i = 0; i < 80; i++) {
    write(
      join(dir, "many", `item${String(i).padStart(2, "0")}.txt`),
      `item ${i}\n`,
    );
  }
  write(join(dir, "docs", "guide.md"), "# Guide\n\nalpha beta gamma delta\n");
}

export function makeProfile(root, pluginDirs) {
  const paths = profilePaths(root);
  for (const dir of [paths.home, paths.config, paths.state, paths.tmux])
    mkdirSync(dir, { recursive: true });
  writeSettings(paths, "dark");
  const init = readFileSync(join(here, "fixture", "init.lua"), "utf8").replace(
    "local plugins = {} -- @PLUGINS@",
    `local plugins = ${luaList(Object.values(pluginDirs))}`,
  );
  write(join(paths.config, "nvim", "init.lua"), init);
  // No shell start-up files of the person's, and a fixed prompt.
  write(join(paths.home, ".bashrc"), "PS1='$ '\n");
  sampleWorkspace(paths.workspaceA, "alpha");
  sampleWorkspace(paths.workspaceB, "beta");
  return paths;
}

function luaList(items) {
  return `{ ${items.map((item) => JSON.stringify(item)).join(", ")} }`;
}
