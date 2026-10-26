/**
 * What the editor area is for the life of this process: a VS Code workbench
 * per Workspace, or the Workspace's own tmux session (`docs/terminal-mode.md`).
 *
 * Read once, at launch, from the settings file's text (`workbenchModeIn`) —
 * before the controller is built, because whether workbenches exist at all is
 * an input to everything it builds — and never again. A change in Settings
 * takes effect at the next start, which the Settings row says. One answer per
 * process is the point: a Workspace that is half in one mode and half in the
 * other is not a state anything here knows how to draw.
 *
 * A module and not a field of the controller because the readers are spread
 * across main: the lifecycle's executor, the layout, the menu bar, VS Code's
 * window service override. Each asks this rather than the config, which can
 * change under it.
 */

import {
	DEFAULT_WORKBENCH_MODE,
	type WorkbenchMode,
} from "../../model/config.js";

let mode: WorkbenchMode = DEFAULT_WORKBENCH_MODE;

/** Fix the mode for this process. Called once, by `bootstrapShell`. */
export function settleWorkbenchMode(next: WorkbenchMode): void {
	mode = next;
}

export function workbenchMode(): WorkbenchMode {
	return mode;
}

/** No VS Code workbench exists in this process; the editor area is tmux. */
export function isTerminalMode(): boolean {
	return mode === "terminal";
}

/**
 * The Workspaces the lifecycle keeps a workbench for: every one whose folder
 * is there (asking for one that is gone is what put VS Code's "path does not
 * exist" box on screen) — and none at all in terminal mode, which is the whole
 * of "no workbench is created": the one executor plans from this list.
 */
export function workspacesWantingWorkbenches<
	W extends { readonly state: { readonly kind: string } },
>(mode: WorkbenchMode, workspaces: readonly W[]): readonly W[] {
	if (mode === "terminal") return [];
	return workspaces.filter(
		(workspace) => workspace.state.kind !== "unavailable",
	);
}

export {
	terminalModeSupports,
	terminalModeUnsupported,
	type TerminalModePlace,
} from "../../model/terminalMode.js";
