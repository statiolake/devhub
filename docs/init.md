# init.ts

`init.ts` is your own TypeScript file for DevHub's editor. It does one thing:
it defines commands. Keys stay in `keybindings.json`, `:` commands in
`devhub.vim.exCommands`; both name the commands init.ts defines by their id.
There are no keybindings, ex commands or event hooks in init.ts.

## Where

`<config directory>/init.ts`, beside `settings.toml`:

| DevHub | File |
| --- | --- |
| the default profile (every packaged run) | `~/.config/devhub/init.ts` |
| another profile (`DEVHUB_PROFILE=dev`, `pnpm dev`) | `~/.config/devhub-dev/init.ts` |
| `$XDG_CONFIG_HOME` set (absolute) | `$XDG_CONFIG_HOME/devhub[-profile]/init.ts` |

It is the directory `apps/desktop/src/model/profile.ts` derives
(`configDirectory`); DevHub's main process hands it to the extension host as
`DEVHUB_CONFIG_DIR`. **DevHub: Open init.ts** opens it (and writes a small
example when there is none).

## Writing it

```ts
import * as vscode from "vscode";
import { defineCommand } from "devhub";

defineCommand("user.copyFileName", async () => {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) {
    return;
  }
  await vscode.env.clipboard.writeText(doc.fileName);
  vscode.window.setStatusBarMessage(`Copied: ${doc.fileName}`, 2000);
}, { title: "Copy File Name" });

// arguments are a keybinding's "args" (or executeCommand's)
defineCommand("user.insert", (args: { text: string }) =>
  vscode.window.activeTextEditor?.insertSnippet(new vscode.SnippetString(args.text)));
```

```jsonc
// keybindings.json
{ "key": "ctrl+alt+c", "command": "user.copyFileName" },
{ "key": "ctrl+alt+d", "command": "user.insert", "args": { "text": "$CURRENT_YEAR-$CURRENT_MONTH-$CURRENT_DATE" } }
```

```jsonc
// settings.json: :CopyName
"devhub.vim.exCommands": { "CopyName": "user.copyFileName" }
```

* `defineCommand(id, handler, { title? })`. `id` is `user.<name>` (letters,
  digits, `_`, `.`, `-` after `user.`): a namespace of your own, so a command
  of init.ts never takes the place of VS Code's or an extension's (one that
  is taken already is reported and not registered). Another id is an error.
  Twice the same id is an error. `handler` gets the command's arguments; what
  it returns (or resolves to) is the command's value.
* `defineCommand` works while init.ts runs, not later (not in a callback).
* `import * as vscode from "vscode"` is the whole [VS Code
  API](https://code.visualstudio.com/api/references/vscode-api), in the local
  extension host — on your Mac in a remote window too, as `:js`. The file is
  CommonJS (TypeScript's `transpileModule`, ES2022): no top-level `await`
  (handlers can be async). Anything else imported is Node's `require` from the
  config directory: `import * as fs from "fs"` works, as does a `.js` file
  beside it; another `.ts` file does not.
* The VS Code API can do more than define commands, and it will — but only
  commands are supported: something init.ts registers through `vscode`
  itself (an event listener, a status bar item,
  `vscode.commands.registerCommand`) is not undone when init.ts is reloaded,
  so the second run finds the first one still there.

## When it runs

At startup (the built-in extension `devhub-init`, activation `*`), and again
whenever the file changes: saved in the editor, or changed on disk (it is
checked every second — your dotfiles' `configure.py update` is picked up as
well). **DevHub: Reload init.ts** runs it again by hand. No window reload.

A run is all or nothing. The commands it defines are registered when the whole
file has run; until then the previous run's commands stay, and a run that
fails (a syntax error, a throw, a wrong `defineCommand`) leaves them as they
are. Deleting init.ts removes its commands.

Errors show in a notification (**Show Output**, **Open init.ts**) and in the
**DevHub init.ts** output channel, with the stack in init.ts's own lines (the
source map of the compile). A command that throws is reported the same way,
and the error goes on to its caller (a `devhub.vim.exCommands` list stops
there). Type errors are not checked at run time: the editor shows them.

TypeScript is VS Code's own (`extensions/node_modules/typescript`); the
JavaScript of the last run is kept (by the file's hash), so a start with an
unchanged init.ts does not load TypeScript.

## The command palette

VS Code's Command Palette lists only the commands an extension declares in
its `package.json`, and init.ts's are defined at run time, so they are not in
it. **DevHub: Run init.ts Command…** is: it lists them by `title` (the id
when there is none) and runs the one picked. Keybindings, ex commands and
`executeCommand` reach them by id directly.

## IntelliSense

When init.ts is there, every start (and **DevHub: Open init.ts**) writes:

* `<config directory>/.types/vscode.d.ts` — the API's types, the
  `src/vscode-dts/vscode.d.ts` of this VS Code (the build copies it into the
  extension: `extensions/devhub-init/.esbuild.mts`)
* `<config directory>/.types/devhub.d.ts` — `defineCommand`

both DevHub's, rewritten when they differ, and `<config
directory>/tsconfig.json` only when there is none (yours from then on; it
lists init.ts and the two `.types` files, with `lib` ES2022 + DOM and no Node
types: `require` is declared untyped). Opening init.ts in DevHub then has
completion and type errors for both modules.

## Security

init.ts is read from DevHub's config directory only — never from a workspace,
a folder's `.vscode/`, or a remote machine — so opening a folder cannot add
or change code that runs. It runs with your rights, in a trusted and an
untrusted (Restricted Mode) workspace alike, as your keybindings do: what runs
is your file, not the workspace's. Keep it in your dotfiles.

## Where it lives in the tree

`patches/vscode-overlay/extensions/devhub-init/` (plain JavaScript, no build
step): `extension.js` (loading, reloading, registering, reporting),
`init.js` (the config directory, transpile, run, source maps; tested by
`node --test extensions/devhub-init/test/*.test.js`, which needs a
TypeScript: VS Code's, DevHub's pnpm one, or `DEVHUB_TEST_TYPESCRIPT`),
`types/devhub.d.ts`. `extensionKind` is `"ui"` (a string: the remote server
build skips UI extensions only when it is one), so the app has it and the
remote servers do not.
