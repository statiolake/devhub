# DevHub Bridge

DevHub's own built-in VS Code extension. It is built in rather than installed
because a person must not be able to uninstall DevHub's integration and be left
with a broken window; `scripts/stage-builtin-extensions.sh` stages it alongside
VS Code's own built-ins.

It is a manifest and no code: the one thing a _product_ cannot say to VS Code
any other way.

**The workbench defaults.** `contributes.configurationDefaults` is the only
supported way to move a workbench default on the desktop — `product.json` has
no reader for it and `environmentService.options.configurationDefaults` is
web-only. `window.title`, `window.commandCenter` and
`workbench.layoutControl.enabled` are here because a workbench view is chrome
inside DevHub's own window and must not draw chrome of its own.
`workbench.startupEditor` is `none` because DevHub decides what a Workspace
opens with, and `chat.disableAIFeatures` is `true` because DevHub hosts its own
Agents — left on, a fresh profile opens every workbench behind Copilot's
sign-in dialog, which takes the keyboard and holds it until somebody dismisses
it. The defaults a person may still overrule live here; the ones that have to
be written into the settings file instead are in
`apps/desktop/src/main/workbenchDefaults.ts`, which says why for each.

The contributed defaults are read from the manifest and need no activation, so
there is no entry point and no activation event.

## What used to be here

**`devhub.installCli`**, the palette command "DevHub: Install 'devhub' command
in PATH", which asked the running DevHub over its control socket to write the
launcher. It is DevHub's own palette command now (`Cmd+Q :`, `install_cli`),
which writes the launcher itself: the launcher is DevHub's, and a Workspace
whose editor is Neovim has no workbench to run a command in. Two ways to the
same launcher would have been one too many, so this one is deleted.

A websocket transport to a DevHub-hosted Bridge endpoint — an RFC6455 frame
codec, a session ledger over a generated v1 contract, a reconnecting
controller, an owner-written surface registry, a URI-handler navigation
grammar, and a fault union to report all of it. That belonged to the web era,
when DevHub served a Web Workbench and injected `DEVHUB_BRIDGE_ENDPOINT`,
`DEVHUB_BRIDGE_TOKEN` and `DEVHUB_BRIDGE_SURFACE_REGISTRY` into it. The Electron
app injects none of them, so none of it ever ran. It is deleted rather than
kept as a branch that is always taken the same way.

## Checks

```sh
pnpm --filter @devhub/bridge check
```

runs the static checks, packages the VSIX and verifies the VSIX is
byte-for-byte reproducible.
