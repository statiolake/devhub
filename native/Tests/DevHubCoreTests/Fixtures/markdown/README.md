# Markdown fixtures

What the TS app's Markdown parser makes of a source, as the native parser
(`Sources/DevHubCore/Markdown`) must make it too.

- `commonmark-gfm-spec.json`: every example of the CommonMark spec
  (commonmark/commonmark-spec `spec.txt`) and of GitHub's GFM spec
  (github/cmark-gfm `test/spec.txt`), duplicates dropped.
- `extra.json`: what answers are written in — Japanese prose, tables, task
  lists, footnotes, math, literal autolinks — and the edge cases the parser
  was checked against while it was written.

Each entry is `{"markdown": …, "mdast": …}`. `mdast` is the tree
`react-markdown` builds for that source in the TS app (micromark's
`mdast-util-from-markdown` with `micromark-extension-gfm` /
`mdast-util-gfm` and `micromark-extension-math` / `mdast-util-math`, the
versions in the repository's lockfile), spelled the way
`MarkdownSpelling` spells the native tree: one parenthesized node per mdast
node, `(p …)`, `(text "…")`, `(list bullet tight (item [x] …))`, and so on.
It was produced once, outside `native/`, by running that parser over the
sources; it is data, and nothing in `native/` runs JavaScript.
