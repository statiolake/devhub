# Vendored: the `codex app-server` protocol types

Everything in this directory except this README is upstream's, not DevHub's.

- **Source**: <https://github.com/openai/codex>, directory
  `codex-rs/app-server-protocol/schema/typescript`, the types
  `codex app-server generate-ts` prints, as upstream checks them in.
- **Version**: tag `rust-v0.156.1` (commit
  `b412ff32c417f855c2b2d1581b77058eed87c84b`), the release npm's
  `@openai/codex` shipped as `latest` when this was vendored (2026-09-25).
- **Licence**: Apache License 2.0 — `LICENSE` and `NOTICE` here are upstream's,
  copied unchanged. See also `distribution/THIRD-PARTY-NOTICES.txt`.
- **What is here**: not the whole directory, only the import closure of the
  types DevHub's Codex adapter reads (the roots are listed in
  `apps/desktop/scripts/vendor-codex-protocol.mjs`). `ServerNotification` and
  `ServerRequest` are roots whole, so every method the server can send is here
  and the adapter's method tables have to place each one.
- **What changed**: one thing. A relative import specifier gains `.js`
  (`"./ThreadItem"` → `"./ThreadItem.js"`), because DevHub's main process
  resolves modules the way Node does (`nodenext`). Nothing else is edited, and
  the files are excluded from DevHub's formatter and linter so they stay
  diffable against upstream.
- **What ships**: nothing. These are types; the adapter imports them with
  `import type`, and they are erased at compile time.

## Regenerating

From `apps/desktop`, with an openai/codex checkout at the tag to pin:

```sh
git clone --depth 1 --branch rust-v0.156.1 https://github.com/openai/codex.git <checkout>
node scripts/vendor-codex-protocol.mjs <checkout>
```

The script replaces every `.ts` file here and copies `LICENSE` and `NOTICE`
again; this README it leaves alone, so update the version above by hand. Then
`pnpm run typecheck`: a method or item type the new version adds is a compile
error in `../adapter.ts` or `../decode.ts` until it is placed.

The same types can come from a working `codex` instead of a checkout —
`codex app-server generate-ts --out <dir>` prints this directory's contents for
that binary's version — but the script reads a checkout, so that the version it
vendors is a tag anyone can fetch.
