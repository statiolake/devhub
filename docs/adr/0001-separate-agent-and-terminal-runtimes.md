# Separate agent and terminal runtimes

DevHub will use one dedicated named Herdr session to execute and monitor Agents, while Workspace Terminals and the Scratch Terminal use independent tmux sessions. Herdr's full-client navigation is shared across its session and would couple DevHub windows, whereas its terminal bridge can safely target individual Agent terminals; keeping human shells in tmux gives each Workspace explicit lifecycle ownership and preserves independent attachment for future multi-window support.

## Consequences

- Closing a Workspace terminates its Agents through `AgentRuntime`, cleans hidden provider resources, and closes its tmux session after confirmation; quitting DevHub only detaches.
- Agent Surfaces connect through Herdr's public terminal-session bridge and never embed the full Herdr UI.
- The Scratch Terminal uses its own reserved tmux session and is not represented as a fake Workspace.
