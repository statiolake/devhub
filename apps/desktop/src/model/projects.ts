/**
 * What a repository URL is called on disk.
 *
 * Both sides need this answer and they must agree: the sheet shows the person
 * where the clone is going to land before they press the button, and main
 * clones into exactly that directory. Two implementations of "the name at the
 * end of a URL" would differ on the first URL neither author thought about,
 * and the sheet would then be a lie rather than a preview.
 *
 * Nothing here touches the filesystem: it is a rule about a string, so it runs
 * as happily in the window as in main.
 */

/**
 * The directory `git clone <url>` would create, or nothing when the URL says
 * no name at all — which is how the sheet knows there is nothing to preview
 * and nothing worth sending.
 */
export function cloneDirectoryName(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;
  // `scp`-style remotes (`git@host:owner/repo.git`) have no scheme to strip and
  // a colon where a URL would have a slash; both forms end in the same thing,
  // which is all this needs.
  const withoutQuery = trimmed.split(/[?#]/u)[0] ?? "";
  const withoutTrailingSlashes = withoutQuery.replace(/[/\\]+$/u, "");
  const last = withoutTrailingSlashes.split(/[/\\:]/u).at(-1) ?? "";
  const name = last.replace(/\.git$/iu, "");
  // A name that would escape the directory it is being put in is not a name.
  if (name.length === 0 || name === "." || name === "..") return undefined;
  return name;
}

/** `parent` and `name`, joined the way a path is, with no doubled separator. */
export function joinPath(parent: string, name: string): string {
  return `${parent.replace(/\/+$/u, "")}/${name}`;
}
