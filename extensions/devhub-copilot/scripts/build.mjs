/**
 * Builds the extension: `dist/extension.js`, `dist/controller.js`, which it
 * requires only when Copilot is turned on (src/extension.ts), and the Copilot
 * language server staged beside them in `server/`.
 *
 * The server is `@github/copilot-language-server`'s JavaScript distribution,
 * the `dist/` of the pinned npm package, run by the extension host's own
 * Electron in its Node mode (src/serverLauncher.ts). It is copied rather than
 * resolved out of node_modules at runtime because the packaged app ships no
 * extension's node_modules (scripts/package-nightly.py drops them), and the
 * staged copy is what both a source run and the package read.
 *
 * Some parts of that distribution are left behind:
 *
 * - `dist/node_modules/@github/copilot`, the Copilot agent SDK (115 MB). The
 *   server imports it lazily, for its background agent sessions, which are
 *   chat; completions and next edits never load it.
 * - `bin/<os>` and `compiled/<os>` for the other operating systems: ripgrep
 *   and the server's native addons, for each OS and both architectures. Only
 *   this OS's are kept — both of its architectures, so a macOS build serves
 *   Apple silicon and Intel alike.
 * - `crypt32*.node`, Windows' certificate store reader, off Windows.
 *
 * Nothing else is touched, so a server bump is a version bump in package.json.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "dist");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ["src/extension.ts", "src/controller.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  plugins: [
    {
      // The entry point's require of the controller stays a require of
      // dist/controller.js, not a copy of it.
      name: "lazy-controller",
      setup(build) {
        build.onResolve({ filter: /^\.\/controller$/ }, (args) =>
          args.importer.endsWith(`${sep}extension.ts`)
            ? { path: "./controller.js", external: true }
            : undefined,
        );
      },
    },
  ],
  outdir: "dist",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
});

const require = createRequire(resolve(root, "package.json"));
const serverPackage = resolve(
  dirname(require.resolve("@github/copilot-language-server/package.json")),
);
const { version } = JSON.parse(
  await readFile(resolve(serverPackage, "package.json"), "utf8"),
);
const source = resolve(serverPackage, "dist");
const server = resolve(root, "server");
const others = ["darwin", "linux", "win32"].filter(
  (os) => os !== process.platform,
);
const dropped = [
  ["node_modules"],
  ...others.flatMap((os) => [
    ["bin", os],
    ["compiled", os],
  ]),
];

await rm(server, { recursive: true, force: true });
await cp(source, server, {
  recursive: true,
  filter: (path) => {
    const parts = relative(source, path).split(sep);
    // Windows' certificate store reader, beside the entry point.
    if (process.platform !== "win32" && /^crypt32.*\.node$/u.test(parts[0])) {
      return false;
    }
    return !dropped.some((prefix) =>
      prefix.every((part, index) => parts[index] === part),
    );
  },
});
await cp(resolve(serverPackage, "LICENSE"), resolve(server, "LICENSE"));

console.log(
  `DevHub Copilot extension built, with @github/copilot-language-server ${version}`,
);
