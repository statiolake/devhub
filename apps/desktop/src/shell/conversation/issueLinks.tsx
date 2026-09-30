/**
 * GitHub Issue and pull request references in the conversation, drawn as
 * links to them on GitHub.
 *
 * `owner/repo#12` names its repository and is a link as it stands. A bare
 * `#12` is a number in the repository the Agent's Workspace numbers its Issues
 * and pull requests in — the one DevHub already reads the Workspace's pull
 * request from (`WorkspaceRepositoryWire.issueRepository`: `upstream` in a
 * fork, else `origin`) — and is plain text when the Workspace has no GitHub
 * repository: a number with nowhere to be looked up names nothing.
 *
 * The link is `https://github.com/owner/repo/issues/12`, which GitHub sends on
 * to the pull request when 12 is one, opened in the default browser through
 * the page's `openExternalUrl`. Nothing is asked of GitHub to draw it: a title
 * is shown on hover only for the numbers DevHub already knows the title of —
 * the Workspace's own Issue and pull request.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceRepositoryWire } from "../../ipc/contract";
import { useConversationActions } from "./ConversationContext";
import type { IssueReference } from "./textLinks";

/** Where a bare `#12` is numbered, and the titles already known there. */
export interface IssueRepository {
  readonly owner: string;
  readonly repository: string;
  /** By number: the Workspace's Issue and pull request, as last read. */
  readonly titles: ReadonlyMap<number, string>;
}

/** The Workspace's row of the repository status, as a bare `#12` reads it. */
export function issueRepositoryOf(
  row: WorkspaceRepositoryWire | undefined,
): IssueRepository | undefined {
  const where = row?.issueRepository;
  if (where === undefined) return undefined;
  const titles = new Map<number, string>();
  if (row?.issue) titles.set(row.issue.number, row.issue.title);
  if (row?.pullRequest) {
    titles.set(row.pullRequest.number, row.pullRequest.title);
  }
  return { owner: where.owner, repository: where.repository, titles };
}

const IssueRepositoryContext = createContext<IssueRepository | undefined>(
  undefined,
);

export const IssueRepositoryProvider = IssueRepositoryContext.Provider;

/** Where `reference` is on GitHub, or `undefined` for a bare one with no repository. */
export function issueUrl(
  reference: IssueReference,
  here: IssueRepository | undefined,
): string | undefined {
  const where = reference.repository ?? here;
  if (where === undefined) return undefined;
  return `https://github.com/${where.owner}/${where.repository}/issues/${reference.number}`;
}

function titleOf(
  reference: IssueReference,
  here: IssueRepository | undefined,
): string | undefined {
  if (here === undefined) return undefined;
  const named = reference.repository;
  const same =
    named === undefined ||
    (named.owner.toLowerCase() === here.owner.toLowerCase() &&
      named.repository.toLowerCase() === here.repository.toLowerCase());
  return same ? here.titles.get(reference.number) : undefined;
}

/**
 * `children` as a link to the Issue or pull request `reference` names; as
 * themselves when it is a bare number and the Workspace has no GitHub
 * repository.
 */
export function IssueLink({
  reference,
  children,
}: {
  readonly reference: IssueReference;
  readonly children: ReactNode;
}) {
  const here = useContext(IssueRepositoryContext);
  const { openExternalUrl, reportFailure } = useConversationActions();
  const url = issueUrl(reference, here);
  if (url === undefined) return <>{children}</>;
  const title = titleOf(reference, here);
  return (
    <a
      href={url}
      className="conversation-issue-link"
      title={title === undefined ? url : `#${reference.number} ${title}`}
      onClick={(event) => {
        // The view is the Agents page, and a tool call's row stays as it
        // was: the link is followed outside DevHub and nothing else happens.
        event.preventDefault();
        event.stopPropagation();
        void openExternalUrl(url).catch(reportFailure);
      }}
    >
      {children}
    </a>
  );
}
