# Isolate persistent terminals in a DevHub tmux server

DevHub owns persistent terminal sessions through a dedicated tmux socket server selected with `tmux -L <effective-name>`, defaulting to `devhub`. The server still loads the user's normal tmux configuration. The Global Context owns one non-closeable Scratch session, and each Workspace owns one independent session rooted at its canonical Workspace Root.

## Consequences

- Scratch and Workspace terminals do not collide with the user's default tmux server.
- Scratch starts in the user's home directory and is recreated automatically when missing.
- Workspace session names are derived deterministically from the canonical root and verified against stored root metadata.
- Users may create normal tmux panes and windows inside each session and may attach externally with the effective socket name shown in Settings, default `tmux -L devhub`.
- Closing or quitting the DevHub app detaches clients and leaves sessions running.
- Explicit Workspace close confirms running Agents, terminal child processes, multiple panes or windows, and unsaved editor state before terminating owned resources.
- A missing Workspace session is recreated when its Terminal Activity is opened.
- The tmux executable path and additional launch arguments are user configuration; changes apply on the next DevHub launch.
- A socket-name change that would abandon marked sessions remains pending until the user confirms `Apply socket change…`; the action destroys only verified terminal sessions and recreates fresh sessions on the requested socket.
