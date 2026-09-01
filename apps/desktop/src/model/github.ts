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
 * `https://github.com/owner/repo/issues/128`, and nothing else.
 *
 * A pull request URL is deliberately not an Issue URL here even though GitHub
 * numbers them together: the flow assigns work from an Issue, and quietly
 * accepting a PR would start a branch for something that already has one.
 */
export function parseIssueUrl(url: string): IssueReference | undefined {
  const match = new RegExp(
    `^https?://(?:www\\.)?github\\.com/(${OWNER})/(${OWNER})/issues/(\\d+)(?:[/?#].*)?$`,
    "u",
  ).exec(url.trim());
  if (!match) return undefined;
  const [, owner, repository, number] = match;
  if (!owner || !repository || !number) return undefined;
  return { owner, repository, number: Number(number) };
}

/** The URL an Issue is read at, from the reference DevHub kept. */
export function issueUrl(issue: IssueReference): string {
  return `https://github.com/${issue.owner}/${issue.repository}/issues/${String(issue.number)}`;
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
 * The shape is a prefix, then the number, then a dash: `feature/128-…`. Three
 * things about the prefix are deliberately loose, because a branch made outside
 * DevHub was named by a person and not by this file. The prefix may be several
 * segments deep (`alice/fix/128-…`), since that is how a shared remote is
 * usually laid out. The number may be written `#128`, since that is how a
 * person writing about an Issue writes one. And a segment may be empty, so a
 * name that starts at the slash is read the same way as one that does not.
 *
 * What stays fixed is the rest: there is a slash before the number, and a dash
 * after it. Those are what separate "this branch is for Issue 128" from a
 * branch that merely has a number in its name, and dropping either would make
 * `v2-rewrite` an Issue.
 */
export function issueNumberFromBranch(branch: string): number | undefined {
  const match = /^(?:[^/]*\/)+#?(\d+)-/u.exec(branch);
  const digits = match?.[1];
  return digits === undefined ? undefined : Number(digits);
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

/**
 * Does this pull request body say it closes that Issue?
 *
 * GitHub's own `closingIssuesReferences` answers a narrower question — what
 * would close on a merge into the *default* branch — so a PR onto a release
 * branch, or a repository whose default branch is not where work lands, reads
 * as having no Issue at all. The keywords in the body are what the person
 * actually wrote, so that is what is read.
 *
 * The keyword list is GitHub's own, and so is the shape: a keyword, optional
 * whitespace and colon, then `#<number>`.
 */
export function bodyClosesIssue(body: string, issueNumber: number): boolean {
  return new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b\\s*:?\\s*#${String(issueNumber)}\\b`,
    "iu",
  ).test(body);
}
