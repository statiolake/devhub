# DevHub configuration contract

`~/.config/devhub/config.toml` is the only user-authored product configuration. This document is normative for schema version 1.

## Complete MVP example

```toml
version = 1

[general]
import_login_environment = true

[runtimes]
shell = "/bin/zsh"
git = "git"
tmux = "tmux"
herdr = "herdr"
tmux_socket_name = "devhub"
tmux_args = []

[appearance]
color_scheme = "light"
terminal_font_family = "SF Mono"
terminal_font_size = 13
terminal_line_height = 1.2
sidebar_density = "compact"

[[workspace_sources]]
id = "daily"
type = "command"
command = ["workspace_path", "-d"]
timeout_ms = 2000

[[workspace_sources]]
id = "dev-git"
type = "filesystem"
path = "~/dev"
min_depth = 1
max_depth = 4
kinds = ["git_repository", "git_worktree"]

[[workspace_sources]]
id = "work"
type = "filesystem"
path = "~/workspace/work"
min_depth = 1
max_depth = 1
kinds = ["directory"]

[[workspace_sources]]
id = "home-git"
type = "filesystem"
path = "~"
min_depth = 1
max_depth = 2
kinds = ["git_repository", "git_worktree"]

[[agent_profiles]]
id = "codex"
display_name = "Codex"
kind = "codex"
args = []

[agent_profiles.env]

[[agent_profiles]]
id = "claude"
display_name = "Claude"
kind = "claude"
args = []

[agent_profiles.env]
```

When the file is absent, DevHub creates this default atomically. A missing optional command such as `workspace_path` disables only that source and produces a source diagnostic.

## Validation rules

- Unknown keys are errors. DevHub never ignores a likely typo.
- `version` is required and must be exactly `1` for the MVP.
- IDs are non-empty ASCII lowercase slugs matching `[a-z][a-z0-9_-]{0,63}` and unique within their collection.
- Strings are UTF-8. NUL is rejected.
- Leading `~` is expanded only when it is the complete first path component. Environment-variable and shell expansion are not performed.
- Runtime strings may be absolute paths or command names. Relative paths containing `/` are rejected.
- `tmux_socket_name` matches `[A-Za-z0-9_.-]{1,64}`.
- `tmux_args` is a closed allowlist of the standalone flags `-u` and `-2`.
  Socket selectors, config-file selectors, command names, separators, and all
  other tmux options are rejected. DevHub inserts its own dedicated `-L`
  socket selector and command boundary after these flags.
- Agent environment keys must be valid environment names. Values remain opaque and are never logged.
- Invalid content keeps the complete last-known-good configuration active; partial application is forbidden.

## General

`general.import_login_environment` is boolean and defaults to `true`. When enabled, DevHub runs the configured shell as a login shell once during app startup to import its environment. The resulting environment is filtered against NUL/invalid keys, used only for child process launch, and never written to logs or runtime state.

## Runtimes

`shell`, `git`, `tmux`, and `herdr` default to the values above. Runtime paths, imported environment, and extra tmux arguments apply only on the next DevHub launch. A socket-name change is first evaluated on the next launch: it becomes effective immediately only when the previous socket has no marked sessions and target preflight succeeds; otherwise it enters the pending/conflict flow below and may be applied live after the conflict is cleared and any required destruction is confirmed. Settings shows configured, resolved, and effective values.

When DevHub creates a previously absent dedicated tmux server, its startup
bootstrap quietly sources exactly one trusted user configuration, using the
normal precedence: `$HOME/.tmux.conf`, then `$XDG_CONFIG_HOME/tmux/tmux.conf`
when `XDG_CONFIG_HOME` is absolute, otherwise `$HOME/.config/tmux/tmux.conf`.
If none exists it sources `/dev/null`. The selected path is resolved from the
startup-frozen launch context and passed through one fixed environment
variable; it is never interpolated into a command argument. The Homebrew
system config is intentionally not sourced because `-f` replaces tmux's
system/user startup selection and DevHub needs a deterministic, app-owned
server boundary. User configuration runs before DevHub's Scratch metadata and
ownership marker, so the final marker is written only after the exact setup.

Changing `tmux_socket_name` cannot strand live terminals. On launch, DevHub probes the previous effective socket recorded in StateStore. If marked Scratch or Workspace sessions remain, the previous name stays effective and Settings reports a pending change rather than silently switching. The Runtimes section then offers `Apply socket change…`; it first verifies that the target socket is absent or correctly marked with no marked DevHub sessions, then shows one destructive confirmation with the exact old Scratch and Workspace session counts. A target conflict changes nothing. Accepting runs the persisted transition defined in `IDENTITY-AND-LIFECYCLE.md`: old cleanup failure keeps the old name effective, while failure to recreate fresh sessions after the new-name commit keeps the new name effective and retries only missing sessions. Unknown unmarked sessions are never destroyed. Agents and Editors are unaffected, and terminal processes are never migrated across servers.

OpenVSCode is bundled and has no release-mode TOML path override. Development builds may use an undocumented process environment override that is excluded from Settings, examples, and release behavior.

## Appearance

Appearance fields apply live.

- `color_scheme` is exactly `light` in schema version 1. Other values are validation errors rather than unimplemented promises.
- `terminal_font_family` is a non-empty font-family string and defaults to `SF Mono`.
- `terminal_font_size` is an integer from `9` through `24` and defaults to `13` points.
- `terminal_line_height` is a number from `1.0` through `2.0` and defaults to `1.2`.
- `sidebar_density` is `compact` or `comfortable` and defaults to `compact`.

Terminal appearance applies only to DevHub Agent, Workspace Terminal, and Scratch xterm Surfaces. OpenVSCode, including its Integrated Terminal, retains its own settings.

## Filesystem Workspace sources

Required fields are `id`, `type = "filesystem"`, and `path`.

- `min_depth` defaults to `0`.
- `max_depth` defaults to `min_depth`, must be at least `min_depth`, and may not exceed `16`.
- `kinds` defaults to `["directory"]` and is an OR list of `directory`, `git_repository`, and `git_worktree`.
- `directory` may not be combined with the Git-specific kinds because it would subsume them.
- `include_hidden` defaults to `false`. The configured source root itself may be hidden.
- `exclude_names` defaults to `[".git", "node_modules", "target", "dist", "build", ".cache"]`. It replaces the default when explicitly present.
- A match does not prune traversal; nested matching repositories remain candidates.
- Permission and I/O errors are source diagnostics and do not abort other sources.

## Command Workspace sources

Required fields are `id`, `type = "command"`, and non-empty `command` array.

- No shell interprets the command.
- `timeout_ms` defaults to `2000`, with an allowed range of `100..30000`.
- stdout is UTF-8 with one candidate path per line. Empty lines are ignored; surrounding CR/LF is removed but other whitespace is preserved.
- Output paths must be absolute after leading-`~` expansion. Relative and nonexistent paths are rejected individually with diagnostics.
- stderr is summarized without copying full output into the product log.
- Non-zero exit or timeout disables only the invocation result for that source.

## Agent Profiles

Required fields are `id`, `display_name`, and `kind`. `kind` is exactly `codex` or `claude`. `args` defaults to an empty string array and `env` to an empty string map.

Profile edits apply to future launches. Existing Agents retain the profile snapshot used at launch. Removing a Profile never terminates existing Agents. Duplicate display names are allowed; IDs remain unique.

## Live application and edit conflicts

Workspace source changes, the available Agent Profile list, and Appearance changes validate and apply live. Existing Agents keep their launch-time Profile snapshots. An in-progress Workspace scan is cancelled and replaced. Runtime changes show a restart-required badge; a pending tmux socket change follows the explicit destructive application flow above.

Settings reads retain a content revision. Saving after an external edit returns a conflict instead of overwriting. The user may reload and reapply the change. Writes resolve a symbolic link to its target, create a temporary sibling file, preserve permissions, fsync, and rename the target while keeping the link itself intact.
