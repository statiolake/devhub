/**
 * What DevHub reads out of GitHub, as rules about strings.
 *
 * Three questions live here, and all three are asked on both sides of the IPC
 * seam — which is why they are rules rather than requests. The page validates
 * an Issue URL as it is typed, and main parses the same URL to know what to
 * clone. The sidebar decides a workspace looks like it belongs to an Issue, and
 * the poller decides which Issue to ask about. Two implementations of any of
 * these would disagree on the first URL neither author thought about.
 *
 * Nothing here talks to the network.
 */

/** An Issue, as GitHub names one. */
export interface IssueReference {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

const OWNER = "[A-Za-z0-9._-]+";

/**
 * Which of GitHub's two numbered things a reference names.
 *
 * They share one sequence per repository — #128 is an Issue or a pull request
 * and never both — so the number alone cannot say, and every reference that
 * travels has to carry which it was.
 */
export type GitHubItemKind = "issue" | "pull";

/**
 * An Issue or a pull request: the two things DevHub can be pointed at.
 *
 * The flow that assigns work takes either. They differ in exactly one way that
 * matters to it — an Issue has no branch yet and a pull request is a branch
 * that already exists — and that difference is what `kind` is for. Everything
 * else about them is the same three fields, which is why this extends the
 * reference rather than being a second kind of thing beside it.
 */
export interface GitHubItem extends IssueReference {
  readonly kind: GitHubItemKind;
}

/**
 * `https://github.com/owner/repo/issues/128`, or `.../pull/128`.
 *
 * The shape of the URL is the whole of the evidence. GitHub numbers Issues and
 * pull requests together, so `/issues/128` and `/pull/128` are different things
 * with the same number, and nothing but the path can tell them apart.
 */
export function parseGitHubItemUrl(url: string): GitHubItem | undefined {
  const match = new RegExp(
    `^https?://(?:www\\.)?github\\.com/(${OWNER})/(${OWNER})/(issues|pull)/(\\d+)(?:[/?#].*)?$`,
    "u",
  ).exec(url.trim());
  if (!match) return undefined;
  const [, owner, repository, section, number] = match;
  if (!owner || !repository || !section || !number) return undefined;
  return {
    owner,
    repository,
    number: Number(number),
    kind: section === "pull" ? "pull" : "issue",
  };
}

/**
 * `https://github.com/owner/repo/issues/128`, and nothing else.
 *
 * A pull request URL is deliberately not an Issue URL *here*: this is what the
 * poller and the sidebar read, and both ask Issue questions of what they get.
 * The flow that assigns work uses `parseGitHubItemUrl` instead, which takes
 * either and says which it was. One pattern underneath, so the two can never
 * come to disagree about what a GitHub URL looks like.
 */
export function parseIssueUrl(url: string): IssueReference | undefined {
  const item = parseGitHubItemUrl(url);
  if (item?.kind !== "issue") return undefined;
  return {
    owner: item.owner,
    repository: item.repository,
    number: item.number,
  };
}

/** The URL an Issue is read at, from the reference DevHub kept. */
export function issueUrl(issue: IssueReference): string {
  return `https://github.com/${issue.owner}/${issue.repository}/issues/${String(issue.number)}`;
}

/** The URL an Issue or a pull request is read at. */
export function gitHubItemUrl(item: GitHubItem): string {
  const section = item.kind === "pull" ? "pull" : "issues";
  return `https://github.com/${item.owner}/${item.repository}/${section}/${String(item.number)}`;
}

/**
 * The Issue a branch name says it is for, by DevHub's own naming convention.
 *
 * This is the fallback, not the record. A worktree DevHub started for an Issue
 * has the Issue written down against its workspace; this is how a branch made
 * outside DevHub — by hand, by an agent, on another machine — can still be
 * recognised. It is a guess, and it is only ever consulted when there is no
 * record to read instead.
 *
 * Two ways of writing it, because there are two things to tell apart and only
 * one of them is ambiguous.
 *
 * `#128` is read wherever it appears. In a branch name `#` means an Issue and
 * means nothing else — no other convention puts one there — so the sigil is the
 * whole of the evidence and nothing about the surroundings has to agree with
 * anything. `feature/#128`, `step/feature/#128-body` and `feature/fix-#128-crash`
 * are all Issue 128, and so is a name that puts it somewhere this file did not
 * think of.
 *
 * A bare `128` has to look like the name DevHub itself would have made:
 * `feature/128-…`, the number first in its path segment and a dash after it.
 * Both halves are load-bearing, because a bare number in a branch name is
 * usually not an Issue — dropping the slash makes `v2-rewrite` an Issue, and
 * dropping the dash makes `release/2024` one. The prefix stays deliberately
 * loose: several segments deep (`alice/fix/128-…`) is how a shared remote is
 * usually laid out, and a segment may be empty, so a name that starts at the
 * slash reads the same as one that does not.
 *
 * The sigil used to be optional decoration on the strict shape — `#?` inside
 * the one pattern — which meant writing the number the clearest way a person
 * can still had to satisfy every rule the ambiguous way needs. `feature/#1234`
 * named an Issue as plainly as a branch can and was read as naming none, in
 * silence, while `release/2024-q1` was read as Issue 2024. That is backwards,
 * and it is what splitting them fixes.
 */
export function issueNumberFromBranch(branch: string): number | undefined {
  const sigil = /#(\d+)/u.exec(branch)?.[1];
  if (sigil !== undefined) return Number(sigil);
  const bare = /^(?:[^/]*\/)+(\d+)-/u.exec(branch)?.[1];
  return bare === undefined ? undefined : Number(bare);
}

/**
 * The branch DevHub starts an Issue on, before anybody knows what to call it.
 *
 * `feature/128-wip`. The flow does not ask for a branch name, because the good
 * name is the one you have *after* reading the Issue and this is the moment
 * before: asking produced either a considered answer nobody could give yet or
 * a placeholder typed to get past the question. So DevHub types the
 * placeholder, work starts immediately, and the agent is asked to rename it —
 * which is a sentence in a template the person owns, not a rule in here.
 *
 * It matches `issueNumberFromBranch`, so a workspace on it is linked to its
 * Issue from the first second, and stays linked through the rename as long as
 * the new name keeps the number.
 */
export function wipBranchForIssue(issueNumber: number): string {
  return `feature/${String(issueNumber)}-wip`;
}
