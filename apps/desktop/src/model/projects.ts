/**
 * What a person means when they name a repository, and what it is called on
 * disk once it is cloned.
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

/**
 * What a folder is called: the last segment of its path.
 *
 * The name is what a person recognises a checkout by — `128-wip` rather than
 * the eight directories above it — so it is what a list of them is labelled
 * with. A path that is all separators has no name and answers with itself,
 * because a blank row would be worse than a long one.
 */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const cut = trimmed.lastIndexOf("/");
  const name = cut < 0 ? trimmed : trimmed.slice(cut + 1);
  return name.length > 0 ? name : path;
}

/**
 * `parent` and `name`, joined the way a path is, with no doubled separator.
 *
 * A name that is already a path from the root *is* the answer, and joining it
 * onto anything would be nonsense — `/projects//tmp/thing` names nowhere. This
 * is the rule every path library has, and it is here because somebody who
 * types an absolute path into the workspace picker and then asks for a new
 * project has said exactly where they want it.
 */
export function joinPath(parent: string, name: string): string {
  if (name.startsWith("/") || name.startsWith("~")) return name;
  return `${parent.replace(/\/+$/u, "")}/${name}`;
}

/**
 * Who this machine is signed in to GitHub as, or why DevHub cannot say.
 *
 * Three states, not two, for the same reason the token has three: "not signed
 * in" and "DevHub has not asked yet" lead to different sentences, and a person
 * told the wrong one goes looking for the wrong problem.
 */
export type GitHubLogin =
  | { readonly kind: "known"; readonly login: string }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "pending" };

/**
 * What is going to be cloned, or why that cannot be said yet.
 *
 * There is no third answer. The line under the field and the call that does the
 * cloning read the same value, so the preview cannot describe one thing while
 * the button does another — which is the whole reason this is a value rather
 * than two functions that happen to agree today.
 */
export type CloneTarget =
  | { readonly kind: "clone"; readonly url: string; readonly name: string }
  | { readonly kind: "unreadable"; readonly reason: string };

/** GitHub's own alphabet for an owner or a repository name. */
const GITHUB_NAME = /^[A-Za-z0-9._-]+$/u;
/** `https://`, `ssh://`, `git://` — anything that names its own transport. */
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
/** `git@github.com:owner/repo.git`: scp's shape, which git takes as a remote. */
const SCP_REMOTE = /^[^/\s@]+@[^/\s:]+:/u;

/** The repository half of `owner/repo.git`, without git's suffix. */
function withoutGitSuffix(segment: string): string {
  return segment.replace(/\.git$/iu, "");
}

/** A segment that is a name, and not a way back up out of a folder. */
function isName(segment: string): boolean {
  return GITHUB_NAME.test(segment) && segment !== "." && segment !== "..";
}

/**
 * A repository on GitHub, by its owner and name.
 *
 * Exported because the Issue wizard clones a repository it already knows the
 * owner and name of, and it must build the same URL as a person who typed
 * `owner/name` into the Clone sheet. Two places composing a github.com URL by
 * hand is exactly how the two would come to disagree about the `.git` suffix.
 */
export function githubCloneTarget(
  owner: string,
  repository: string,
): CloneTarget {
  const name = withoutGitSuffix(repository);
  if (!isName(owner) || !isName(name)) {
    return {
      kind: "unreadable",
      reason:
        "A GitHub owner and repository may only use letters, digits, dots, dashes and underscores.",
    };
  }
  return {
    kind: "clone",
    url: `https://github.com/${owner}/${name}.git`,
    name,
  };
}

/**
 * What `git clone` is going to be handed, read the way `gh repo clone` reads
 * it: a bare name is the person's own repository, one slash is `owner/name` on
 * GitHub, and anything that names its own transport is taken as written.
 *
 * The three rules are here, once, because both places that clone — the Clone
 * Project sheet and the Issue wizard — must agree about what a person typed,
 * and because the rule is about a string and belongs nowhere near a process.
 *
 * A bare name is the one form that needs something DevHub has to go and ask
 * for, so it is also the one form that can fail to be readable through no fault
 * of the typing. That failure is answered here, in words, rather than by
 * quietly cloning `github.com/undefined/name`.
 */
export function cloneTarget(typed: string, login: GitHubLogin): CloneTarget {
  const trimmed = typed.trim();
  if (trimmed.length === 0) {
    return {
      kind: "unreadable",
      reason: "Enter a repository: a name, owner/name, or a clone URL.",
    };
  }

  if (HAS_SCHEME.test(trimmed) || SCP_REMOTE.test(trimmed)) {
    const name = cloneDirectoryName(trimmed);
    return name === undefined
      ? { kind: "unreadable", reason: "That URL names no repository." }
      : { kind: "clone", url: trimmed, name };
  }

  const segments = trimmed.replace(/\/+$/u, "").split("/");
  if (segments.length === 2) {
    return githubCloneTarget(segments[0] ?? "", segments[1] ?? "");
  }
  if (segments.length > 2) {
    return {
      kind: "unreadable",
      reason:
        "That is neither a repository name nor a URL. Try owner/name, or paste the whole clone URL.",
    };
  }

  // A bare name: this person's own repository, which means knowing who they
  // are. Saying so beats cloning something they did not name.
  const repository = segments[0] ?? "";
  switch (login.kind) {
    case "pending":
      return {
        kind: "unreadable",
        reason: `Finding out which GitHub account you are signed in as, to clone your ${withoutGitSuffix(repository)}…`,
      };
    case "unknown":
      return {
        kind: "unreadable",
        reason: `A name on its own means your own repository, and DevHub does not know which GitHub account you are signed in as: ${login.reason}. Type owner/${withoutGitSuffix(repository)} instead.`,
      };
    case "known":
      return githubCloneTarget(login.login, repository);
  }
}
