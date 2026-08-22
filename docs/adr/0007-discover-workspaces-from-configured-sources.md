# Discover Workspaces from configured sources

DevHub discovers Workspace candidates from typed Workspace sources in user configuration. Filesystem and Git are the source of truth; DevHub does not maintain a persistent registry of folder roots or previously registered Workspaces.

Filesystem sources declare a root, minimum and maximum depth, and candidate kinds (`directory`, `git_repository`, or `git_worktree`). Command sources execute an argument array directly without a shell and interpret one output line as one candidate path. This preserves personal dynamic workflows such as `workspace_path -d` without coupling DevHub to zsh aliases or VS Code extension settings.

## Consequences

- Opening the Workspace Picker starts a cancellable streaming scan and displays candidates incrementally.
- Canonical paths deduplicate candidates across sources. Nested matching repositories are retained.
- Git remote identity is resolved asynchronously and associated with the candidate Repository when available.
- Selecting an already-open canonical root focuses its existing Workspace.
- The Workspace Picker supports fuzzy matching over basename and displayed path and always provides `Open Folder…` as an escape hatch.
- Hidden directories, dependency trees, and build outputs have configurable default exclusions.
- Source command failure is isolated to that source and reported without discarding other candidates.
- New Workspace creation, Clone Repository, Issue URL resolution, and Dev Container launch are deferred beyond the MVP.
