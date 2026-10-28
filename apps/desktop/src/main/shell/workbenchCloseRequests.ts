/**
 * A workbench asking to close its own Workspace: Vim quitting.
 *
 * In the editor's Vim (`docs/vim.md`, Windows) `:q` closes a window — an
 * editor group — and the last window of the last tab page is Vim itself
 * going away; so are `:qa`, `:wqa` and `:xa`. In DevHub what goes away is
 * the Workspace, and what that means is what the Workspace's close button
 * means: the one close path, `AppController.closeWorkspaceOrWorktree`. A
 * Workspace with nothing to lose closes; one with something to ask about —
 * unsaved editors, a busy Agent, a dirty worktree — raises the same sheet
 * the button does, and cancelling it leaves everything where it was. It is
 * the VS Code half of what terminal mode's shell `exit` already does in the
 * editor area (`editorTerminalExits.ts`).
 *
 * The workbench half is the overlay's `devhubVim/electron-browser/
 * vimQuit.contribution.ts`. It asks twice, over one channel:
 *
 * - `probe`: may this Workspace be closed at all? Asked first so that `:qa!`
 *   and `:q!` drop unsaved changes only when the close will go ahead —
 *   Scratch is never closed (as terminal mode's `exit` never closes it), and
 *   there the answer is `scratch` and Vim says E444 with nothing lost.
 * - `close`: run the close button. Answered at once with `closing`; what the
 *   close then does is the sheet's and the projection's, never this reply's.
 *
 * Who is asking is read off the sender: only a workbench DevHub put in a
 * view, bound to a Workspace, is answered — any other contents are told
 * `unknown` and nothing happens.
 */

/** The channel; the overlay names it the same (`vimQuit.contribution.ts`). */
export const CLOSE_WORKSPACE_REQUEST = "vscode:devhubCloseWorkspace";

export type CloseRequestMode = "probe" | "close";

export type CloseRequestAnswer =
	/** `probe`: the Workspace can be closed. */
	| "closable"
	/** `close`: its close button has been pressed (or a close is already underway). */
	| "closing"
	/** Scratch: never closed. */
	| "scratch"
	/** Not a workbench of a Workspace, or a request this does not know. */
	| "unknown";

/** The Workspace a workbench belongs to, as far as closing it goes. */
export interface ClosingWorkspace {
	readonly id: string;
	readonly scratch: boolean;
	/** A close of it is already being inspected or run. */
	readonly closing: boolean;
}

export interface CloseRequestsOptions<Contents> {
	/** The Workspace whose workbench these contents are, if they are one. */
	readonly workspaceOf: (contents: Contents) => ClosingWorkspace | undefined;
	/** The Workspace's close button: the one close path. */
	readonly close: (workspaceId: string) => void;
}

/** The answer to one request, and the close it starts. */
export function answerCloseRequest<Contents>(
	options: CloseRequestsOptions<Contents>,
	contents: Contents,
	mode: unknown,
): CloseRequestAnswer {
	if (mode !== "probe" && mode !== "close") return "unknown";
	const workspace = options.workspaceOf(contents);
	if (workspace === undefined) return "unknown";
	if (workspace.scratch) return "scratch";
	if (mode === "probe") return "closable";
	// A second `:q` while the first close's sheet is up is the same close.
	if (!workspace.closing) options.close(workspace.id);
	return "closing";
}

/** As much of `ipcMain` as answering needs. */
export interface CloseRequestsIpc<Contents> {
	handle(
		channel: string,
		listener: (
			event: { readonly sender: Contents },
			...args: unknown[]
		) => CloseRequestAnswer,
	): unknown;
}

/** Answer every workbench that asks to close its Workspace. */
export function listenForCloseRequests<Contents>(
	ipc: CloseRequestsIpc<Contents>,
	options: CloseRequestsOptions<Contents>,
): void {
	ipc.handle(CLOSE_WORKSPACE_REQUEST, (event, mode) =>
		answerCloseRequest(options, event.sender, mode),
	);
}
