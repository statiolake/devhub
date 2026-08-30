/**
 * A filesystem path on one line, truncated in the middle.
 *
 * The last segment is what identifies a folder, so it is the part that must
 * survive: `/Users/someone/dev/git…/devhub` tells you which workspace this is,
 * and `/Users/someone/dev/git…` does not. Truncating in the middle is what
 * AppKit does with a path too (`NSLineBreakByTruncatingMiddle`), and it is why
 * the separator stays with the tail: the ellipsis then sits between two path
 * components and reads as one path with a piece missing.
 *
 * This replaces a `direction: rtl` trick that moved the ellipsis to the
 * leading edge by reordering the line. Bidi reordering is not truncation: the
 * separators in a path are neutral characters, so `~/dev` — which fits, and
 * needs no truncation at all — was drawn as `dev/~`. Here the line is laid out
 * left to right and only the head is allowed to give way.
 */

export function splitPath(path: string): {
  readonly head: string;
  readonly tail: string;
} {
  const cut = path.lastIndexOf("/");
  // No separator, or the path *is* a root child: there is nothing to give way,
  // so the whole string is the part that has to be kept.
  if (cut <= 0) return { head: "", tail: path };
  return { head: path.slice(0, cut), tail: path.slice(cut) };
}

export function PathLabel({ path }: { readonly path: string }) {
  const { head, tail } = splitPath(path);
  return (
    // The whole path for a screen reader and for hover; the two halves are a
    // presentation of it and are hidden from the accessibility tree.
    <span className="mac-path" title={path} aria-label={path}>
      {head && (
        <span className="mac-path-head" aria-hidden="true">
          {head}
        </span>
      )}
      <span className="mac-path-tail" aria-hidden="true">
        {tail}
      </span>
    </span>
  );
}
