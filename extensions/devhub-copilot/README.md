# DevHub Copilot

DevHub's built-in GitHub Copilot: code completions and Next Edit Suggestions
(NES), drawn by the editor's own inline suggestion UI, from
[`@github/copilot-language-server`](https://www.npmjs.com/package/@github/copilot-language-server).
There is no chat. DevHub pins `chat.disableAIFeatures: true` and leaves the
`copilot` extension out of its built-in set (the packaged app by VS Code's own
build, a source run by `scripts/stage-builtin-extensions.sh`); this extension
takes the place of only the completion half of that extension.

## Off until turned on

Copilot is off in every window, and is turned on for one window at a time:
**Copilot: Enable in This Window**, or a click on the status item
(`$(copilot-unavailable)` while off). **Copilot: Disable in This Window**, or
Turn Off in the dashboard, turns it off again. Sign In, Sign Out, Restart and
Show Status turn it on first.

Off, the extension is `src/extension.ts` alone: the status item and the
commands. No language server process (about 1 GB, one per window's extension
host), no providers, no timers; `src/controller.ts`, everything else, is built
to its own `dist/controller.js` and not even loaded until Copilot is turned on.
Turning it off disposes of the controller, which shuts the server down (killed
if it has not exited within 2 s) and unregisters the providers.

Whether it is on is held in the extension host's memory only. A reload, a
restart or a workbench put to sleep comes back off.

It grew out of
[statiolake/vscode-copilot-lsp](https://github.com/statiolake/vscode-copilot-lsp),
a Marketplace extension that has to keep to the stable API. Being built in, this
one does not, and that is the difference you can see.

## Why NES looks like the official one here

The editor draws a suggestion as an inline edit (gutter indicator and menu,
side-by-side or word-replacement view, the jump hint, Tab to jump then Tab to
accept) only when the item says `isInlineEdit`. An item without it is ghost
text, and ghost text that is not a continuation at the cursor is never shown.
`isInlineEdit` is part of the proposed `inlineCompletionsAdditions` API, and
the extension host passes it through only for an extension that has been
granted that proposal. Nothing else controls that UI: not the extension id,
not whether the extension is built in, and not `chat.disableAIFeatures`.

So:

- `src/nextEditProvider.ts` sends `textDocument/copilotInlineEdit` on each
  edit and returns each answer as an item with `isInlineEdit` and
  `showInlineEditMenu` set;
- `scripts/product_metadata.py` grants `devhub.devhub-copilot`
  `inlineCompletionsAdditions` in DevHub's `product.json`;
- `src/completionProvider.ts` serves ghost text from
  `textDocument/inlineCompletion`, and also sends the `didShowCompletion` and
  `didPartiallyAcceptCompletion` notifications the server asks for, which also
  come from the proposal.

How an inline edit is drawn is up to the editor's own settings,
`editor.inlineSuggest.edits.*` (`renderSideBySide`, `allowCodeShifting`,
`showCollapsed`, …).

## The language server

`scripts/build.mjs` copies the pinned package's JavaScript distribution into
`server/`. It leaves out the Copilot agent SDK, which is only used for chat
sessions, and the other operating systems' ripgrep and native addons. The
result is about 50 MB. The extension host's own Electron runs it in Node mode,
so none of the ~100 MB per-platform executables are needed
(`pnpm-workspace.yaml` does not install them). To update the server, change
the version in `package.json`.

The extension is `extensionKind: ui`. In SSH and dev container windows it runs
on this Mac, next to its server, and gets the remote documents through the
editor. Nothing is installed on the remote host.

Signing in uses the server's own GitHub device flow (**Copilot: Sign In**). The
server keeps its credentials in its own store, which other clients of the same
server on this machine share.

## Settings

| Setting                                                      | Default |
| ------------------------------------------------------------ | ------- |
| `devhub.copilot.completions.enabled`                         | `true`  |
| `devhub.copilot.nextEditSuggestions.enabled`                 | `true`  |
| `devhub.copilot.nextEditSuggestions.extendedRange`           | `true`  |
| `devhub.copilot.nextEditSuggestions.renameSymbolSuggestions` | `true`  |
| `devhub.copilot.debug.logging`                               | `false` |

`devhub.copilot.completions.enabled` and
`devhub.copilot.nextEditSuggestions.enabled` can be set per language
(`"[markdown]": { "devhub.copilot.completions.enabled": false }`); the
dashboard's "for <language>" checkboxes write exactly that.

## The status bar dashboard

DevHub pins `chat.disableAIFeatures`, which hides the official Copilot status
item and its dashboard. While Copilot is on, this extension's item has a
dashboard of its own, drawn by the workbench with the same widgets and
stylesheet as the official one: hover over the item, or click it to pin it
open with keyboard focus inside (Tab between the controls, Space to toggle,
Escape to close). While it is off the item has only a tooltip.

- the header: the GitHub account and plan, and Show Output, Restart Language
  Server and Settings;
- the server: running, or a moving bar while it starts or while you sign in,
  or its error with Restart;
- the code completions quota as a meter of what is used, with its reset date,
  when the plan has a limit;
- Suggestions: Code completions and Next edit suggestions, everywhere and for
  the active editor's language (a three-state box: on, off, or as everywhere);
- Snooze 5 min (then +5 min or Resume) hides suggestions in this window;
- Sign In to GitHub or Sign Out, and Turn Off in This Window.

The icon is the official one for the same state: `copilot`, `copilot-snooze`,
`copilot-unavailable` (off, or both kinds off for this language),
`copilot-not-connected` (signed out), `copilot-warning` (error, quota used up),
and a spinner while the server starts, you sign in, or a request is in flight.

The dashboard is `StatusBarItem.hover`, the `devhubStatusBarHover` proposed
API that DevHub adds to the workbench (the hooks in
`patches/vscode/0009-devhub-status-bar-hover.patch`, the new files under
`patches/vscode-overlay/`): a generic, declarative hover of headers, text,
meters, checkboxes, buttons and sections, which any DevHub built-in can be
granted (`scripts/product_metadata.py`). Its declaration,
`patches/vscode-overlay/src/vscode-dts/vscode.proposed.devhubStatusBarHover.d.ts`,
is copied to `typings/` (checked against it by `pnpm run lint`). On a workbench
without it the item falls back to a plain tooltip and the **Copilot: Show Status**
menu.

If `statiolake.vscode-copilot-lsp` is installed as well, its completions are
excluded and you are asked to disable it. Left enabled, it would start a second
server and draw its own NES decorations beside the editor's.
