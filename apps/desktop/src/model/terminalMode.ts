/**
 * Which Workspaces terminal mode can serve, said once for main and the pages
 * (`docs/terminal-mode.md`). Pure: no Electron, no Node.
 */

/** The two facts about a Workspace that decide whether terminal mode can show it. */
export interface TerminalModePlace {
  readonly location: { readonly kind: string };
  readonly editor: { readonly kind: string };
}

/**
 * Whether terminal mode can draw this Workspace's editor area and open its
 * files: a folder on this Mac (phase 1) or on an SSH host (phase 2), whose
 * editor is not attached to a dev container — that is phase 3 of
 * `docs/terminal-mode.md`.
 */
export function terminalModeSupports(workspace: TerminalModePlace): boolean {
  return (
    (workspace.location.kind === "local" ||
      workspace.location.kind === "ssh") &&
    workspace.editor.kind === "host"
  );
}

/**
 * What terminal mode says about a Workspace it cannot serve yet — the editor
 * area's state and a refused file jump use the same sentence.
 */
export function terminalModeUnsupported(_workspace: TerminalModePlace): string {
  return "Terminal mode does not support Workspaces whose editor is in a dev container yet.";
}
