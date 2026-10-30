/**
 * What a Workspace's editor area shows: its terminal or its VS Code editor
 * (`docs/terminal-mode.md`). Said once for the model, main and the pages.
 * Pure: no Electron, no Node.
 *
 * Every Workspace has its own answer, remembered across restarts. One that
 * has none yet — a new Workspace, or one from a state file that does not say
 * — is given `general.default_view` when it enters the model (`AppModel`),
 * and keeps it from then on: DevHub's default is the terminal, the
 * Workspace's `ws-` tmux session drawn by DevHub's own terminal surface.
 * `Cmd+Q E` switches it to the Workspace's VS Code workbench — started the
 * first time it is shown, then asleep and awake under the workbench lifecycle
 * like any other — and back.
 */

/** The two things a Workspace's editor area can show. */
export type EditorView = "terminal" | "editor";

/** DevHub's own `general.default_view`. */
export const DEFAULT_EDITOR_VIEW: EditorView = "terminal";

/** Whether a value read from a file is one of the two views. */
export function isEditorView(value: unknown): value is EditorView {
  return value === "terminal" || value === "editor";
}

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
