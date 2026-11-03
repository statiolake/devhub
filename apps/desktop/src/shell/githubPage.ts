/**
 * Whether a URL is a page on GitHub that a tooltip may lead to.
 *
 * The row's tooltip links three of its facts — the repository, the Issue, the
 * pull request — and every one of them is a `https://github.com/` page
 * (`main/shell/repositoryStatus.ts` reads only GitHub remotes). Anything else
 * arriving as an `href` is not one of those three, so it is not drawn as a
 * link and not followed: the composer checks it (`rowDescription.ts`) and the
 * tooltip page checks it again before it asks main to open it.
 */
export function isGitHubPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "github.com" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === ""
  );
}
