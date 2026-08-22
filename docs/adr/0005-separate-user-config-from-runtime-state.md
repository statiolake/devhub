# Separate user configuration from runtime state

DevHub stores user-authored configuration in `~/.config/devhub/config.toml` and machine-owned runtime state in `~/Library/Application Support/DevHub/state.json`. The TOML file is suitable for dotfiles and may be a symbolic link. Runtime state is local, schema-versioned, and never synchronized through the configuration file.

## Consequences

- Native Settings UI and direct TOML editing are equally supported.
- Settings writes resolve and preserve a symbolic link, update its target atomically, and preserve TOML comments and ordering where possible.
- External edits are watched and validated transactionally. Invalid content leaves the last-known-good configuration active and reports the source location.
- Settings UI does not silently overwrite a file changed externally since it was loaded.
- Workspace sources, the available Agent Profile list, and presentation settings apply live. Existing Agents retain their launch-time Profile snapshot.
- Executable paths for Herdr, tmux, Git, and the login shell apply on the next DevHub launch. The bundled OpenVSCode path is not a release configuration setting.
- Runtime state uses atomic writes, includes a schema version, and retains a recoverable backup when corruption is detected.
