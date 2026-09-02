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
