# Identity and lifecycle rules

## Workspace Root canonicalization

Opening a candidate expands a leading `~`, makes the path absolute, lexically normalizes it, requires an existing directory, and resolves symbolic links with the operating system canonicalization call. When both paths exist, filesystem same-file identity is the final duplicate check. Two aliases of the same directory cannot be open as separate Workspaces.

StateStore persists the Workspace ID, selected display path, and last canonical path as one record. A restored path that no longer exists keeps all three values in the `Unavailable` state. Locate retains the Workspace ID and replaces both paths only after the chosen directory passes duplicate checks.

A Workspace ID is a generated UUID persisted for the lifetime of that open Workspace. Explicit Close ends that identity; reopening the same root creates a new Workspace ID.

## Workspace labels

The label starts with the canonical root basename. When open Workspaces share a basename, each label appends the shortest unique parent suffix, for example `devhub — github` and `devhub — work`. Labels recompute as the open set changes and are not user-renamable in the MVP. Full paths remain available as accessibility descriptions and tooltips.

## Repository association

Git discovery uses the configured Git executable and obtains the top-level root and common Git directory. A normal checkout and linked worktrees are distinct Workspace Roots but associate with the same Repository when they expose the same normalized remote.

Remote precedence is:

1. `origin`;
2. `upstream`;
3. remaining remote names in lexical order.

All remotes are retained as aliases for future URL lookup. HTTPS and SSH forms normalize to lower-case host plus repository path with credentials, leading slash, and trailing `.git` removed. GitHub owner/repository identity is compared case-insensitively. A repository with no remote has no Repository association; DevHub does not invent a local Repository identity.

## tmux ownership

DevHub enforces one application instance and uses the configured tmux socket name, default `devhub`. On creating its server it sets global option `@devhub-protocol=1`. An existing socket without that exact marker is a conflict and is never adopted, modified, or killed.

StateStore also persists the last effective tmux socket name and any socket-transition state. If configuration requests a different name on a later launch, DevHub first probes the previous socket. While any marked Scratch or Workspace session remains there, DevHub continues using the previous effective name and exposes a pending change.

Before showing the destructive confirmation, `Apply socket change…` preflights the requested target. An absent socket is valid. An existing socket is valid only when it has the exact DevHub protocol marker and contains no marked DevHub session; unknown unmarked sessions do not block or become owned. A missing/wrong marker or marked target session is a conflict and returns to `pending` without changing either server.

After preflight, the transition is persisted and resumed as `pending → cleaning-old → old-cleaned → new-effective/recreation-pending → stable`. `cleaning-old` terminates only the confirmed, verified old sessions and records each completion. “Old-cleaned” means zero marked DevHub sessions; unknown sessions remain untouched and the old server need not be killed. Cleanup failure keeps the old name effective and exposes idempotent Retry. Once old-cleaned, DevHub prepares the validated target server, atomically commits the new effective name with the complete recreation list, and creates fresh Scratch and open-Workspace sessions. Failure after that commit keeps the new name effective in `recreation-pending` and retries only missing fresh sessions; it never rolls back to an already-cleaned server. DevHub never silently abandons or migrates terminal processes between servers.

Scratch session name is `scratch`. Workspace session names begin `ws-` followed by the first 20 hexadecimal SHA-256 characters of the canonical root. Each owned session carries `@devhub-context`, `@devhub-workspace-id`, and `@devhub-root`. A name collision with mismatched metadata extends the digest to 32 characters; any remaining conflict is a hard runtime error.

DevHub inspects, attaches, and terminates only marked sessions. Unknown sessions on the dedicated server are left untouched and reported. tmux panes and windows remain internal to the one Scratch or Workspace Terminal Surface; they do not become Sidebar entries or additional DevHub Surfaces.

## Busy inspection

Every Workspace resource inspector returns exactly one of:

- `clean`;
- `busy`, with counted reasons;
- `unknown`, with a diagnostic code.

The Workspace is clean only when Agent, tmux, and Editor inspectors all return clean. Any busy or unknown result produces the consolidated confirmation sheet. Unknown is displayed as “could not verify” and never treated as clean.

After confirmation, cleanup is idempotent and ordered: Agents, Workspace tmux session, Editor Surface, runtime-state commit. Default operation deadlines are five seconds per Agent/provider close, three seconds for tmux, and three seconds for Editor disposal. Timeout or unverifiable ownership keeps the Workspace in `Closing failed` with completed steps recorded for Retry. DevHub never kills an unmarked provider resource.

Natural Agent exit racing explicit Stop satisfies the Stop once reconciliation proves the provider Agent and pane are gone. Operation IDs and tombstones prevent stale events from recreating removed state.
