/**
 * Which Workspaces terminal mode can serve, said once for main and the pages
 * (`docs/terminal-mode.md`). Pure: no Electron, no Node.
 */

/** The fact about a Workspace that decides whether terminal mode can show it. */
export interface TerminalModePlace {
  readonly location: { readonly kind: string };
}

/**
 * Whether terminal mode can draw this Workspace's editor area and open its
 * files: a folder on this Mac. Terminal mode is local-only — SSH Workspaces
 * are VS Code mode's. A dev container is only where a *workbench* would run
 * (`EditorAttachment`): the Workspace's terminals and Agents are on this Mac
 * either way, so terminal mode serves that folder as the local folder it is.
 */
export function terminalModeSupports(workspace: TerminalModePlace): boolean {
  return workspace.location.kind === "local";
}

/**
 * What terminal mode says about an SSH Workspace — the editor area's state
 * and a refused file jump use the same sentence.
 */
export const TERMINAL_MODE_NO_SSH =
  "SSH Workspaces are not available in terminal mode. Use VS Code mode to open them.";

/** What terminal mode says when it is asked for a dev container. */
export const TERMINAL_MODE_NO_DEV_CONTAINERS =
  "Dev containers are not available in terminal mode. Use VS Code mode to reopen a folder in its container.";
