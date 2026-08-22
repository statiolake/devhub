# DevHub

DevHub is a local development environment that organizes editing, agents, and terminals around currently open workspaces.

## Language

**Workspace**:
A currently open development context rooted at one Workspace Root. It is restored across an app restart but ceases to exist when explicitly closed.
_Avoid_: Project, Git repository, VS Code window, Herdr workspace

**Workspace Root**:
The canonical local directory opened by a Workspace. A normal Git checkout and each linked worktree are distinct Workspace Roots.
_Avoid_: Project registration

**Repository**:
The identity named by a Git remote. One Repository may have multiple Workspace Roots.
_Avoid_: Workspace, local checkout

**Workspace Picker**:
The streaming UI that discovers and opens Workspace Root candidates from configured sources.
_Avoid_: Project Picker, project registry

**Activity**:
A fixed top-level navigation choice that selects a kind of work, such as Editor, Agent, or Terminal. Activities are not opened or closed and may be disabled when they do not apply to the current context.
_Avoid_: Tab

**Navigation Context**:
The current left-pane selection that Activities resolve against. It is exactly one of the Global Context, a Workspace, or an Agent.
_Avoid_: Active tab

**Surface**:
The concrete screen shown for an Activity and its current target, such as the Editor Surface of one Workspace or the Agent Surface of one Agent.
_Avoid_: Activity, tab

**Editor Surface**:
The code-editing Surface owned by either a Workspace or the Global Context. Agent contexts in the same Workspace resolve to the same Workspace-owned Editor Surface.
_Avoid_: Editor tab, VS Code window

**Global Editor**:
The folderless singleton Editor Surface owned by the Global Context. Opening a folder from it creates or focuses a Workspace rather than changing its ownership.
_Avoid_: Global workspace

**Agent**:
An autonomous development session belonging to one Workspace. Its identity is independent of the runtime used to execute it.
_Avoid_: Herdr pane, Herdr tab

**Agent Surface**:
The Surface for observing and interacting with one Agent through a provider-owned terminal control stream.
_Avoid_: Agent tab, Agent terminal

**Workspace Terminal**:
The persistent interactive shell Surface belonging to one Workspace.
_Avoid_: Agent terminal

**Global Context**:
The app-wide navigation context used for work that belongs to no Workspace. It owns the Scratch Terminal and a folderless Editor Surface and cannot be closed.
_Avoid_: Global workspace

**Scratch Terminal**:
The persistent interactive shell belonging to the Global Context and starting in the user's home directory.
_Avoid_: Scratch workspace
