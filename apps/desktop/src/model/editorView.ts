/**
 * What a Workspace's editor area shows: its terminal or its VS Code editor
 * (`docs/terminal-mode.md`). Said once for the model, main and the pages.
 * Pure: no Electron, no Node.
 *
 * Every Workspace has its own answer, remembered across restarts, and the
 * terminal is the default: the Workspace's `ws-` tmux session, drawn by
 * DevHub's own terminal surface. `Cmd+Q E` switches it to the Workspace's
 * VS Code workbench — started the first time it is asked for, then asleep and
 * awake under the workbench lifecycle like any other — and back.
 */

/** The two things a Workspace's editor area can show. */
export type EditorView = "terminal" | "editor";

export const DEFAULT_EDITOR_VIEW: EditorView = "terminal";

/** The fact about a Workspace that decides whether it has a terminal view. */
export interface EditorViewPlace {
  readonly location: { readonly kind: string };
}

/**
 * Whether this Workspace's editor area can show its terminal: a folder on
 * this Mac. The terminal view is local-only — an SSH Workspace's editor area
 * is its VS Code workbench on the host, always. A dev container is only where
 * a *workbench* runs (`EditorAttachment`): the Workspace's terminals and
 * Agents are on this Mac either way, so its terminal view is the local folder
 * it is.
 */
export function hasTerminalView(workspace: EditorViewPlace): boolean {
  return workspace.location.kind === "local";
}

/**
 * The view a Workspace actually shows, given the one it asked for: an SSH
 * Workspace shows its editor whatever was written down.
 */
export function effectiveEditorView(
  workspace: EditorViewPlace,
  chosen: EditorView,
): EditorView {
  return hasTerminalView(workspace) ? chosen : "editor";
}

/**
 * Whether a file opened for this Workspace — an Agent's path link, `devhub
 * <file>`, `devhub -g`, Finder — goes to its managed Neovim: its editor area
 * shows its terminal, and the file is on this Mac. Everything else — its
 * VS Code editor shown, an SSH Workspace, a path on another machine — goes to
 * its workbench. The file goes to what the person is looking at.
 */
export function opensInNeovim(
  workspace: EditorViewPlace & { readonly editorView: EditorView },
  machine: string,
): boolean {
  return (
    machine === "local" &&
    hasTerminalView(workspace) &&
    workspace.editorView === "terminal"
  );
}
