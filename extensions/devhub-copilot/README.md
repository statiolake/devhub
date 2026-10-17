# DevHub Copilot

DevHub's built-in GitHub Copilot: code completions and Next Edit Suggestions
(NES), drawn by the editor's own inline suggestion UI, from
[`@github/copilot-language-server`](https://www.npmjs.com/package/@github/copilot-language-server).
There is no chat. DevHub pins `chat.disableAIFeatures: true` and leaves the
`copilot` extension out of its built-in set; this extension takes the place of
only the completion half of that extension.

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
| `devhub.copilot.enable`                                      | `true`  |
| `devhub.copilot.completions.enabled`                         | `true`  |
| `devhub.copilot.nextEditSuggestions.enabled`                 | `true`  |
| `devhub.copilot.nextEditSuggestions.extendedRange`           | `true`  |
| `devhub.copilot.nextEditSuggestions.renameSymbolSuggestions` | `true`  |
| `devhub.copilot.debug.logging`                               | `false` |

Click the status bar item to see the server's status and the remaining usage,
or to turn Copilot off, sign in or out, or restart the server.

If `statiolake.vscode-copilot-lsp` is installed as well, its completions are
excluded and you are asked to disable it. Left enabled, it would start a second
server and draw its own NES decorations beside the editor's.
