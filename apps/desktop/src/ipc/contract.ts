/**
 * The one contract between the App Shell page and the main process.
 *
 * The page never touches Electron's IPC directly: the preload exposes exactly
 * the calls below as `window.devhub`, and every one of them is a request the
 * main process answers or an error it throws. There is no second style.
 */

/** A folder DevHub keeps in the sidebar, with a workbench view of its own. */
export interface Workspace {
	/** Stable across restarts; the absolute folder path is the identity. */
	readonly id: string;
	readonly name: string;
	readonly path: string;
	/** True once a workbench view exists for it in this session. */
	readonly opened: boolean;
}

/** Everything the App Shell page draws. Main owns it; the page mirrors it. */
export interface ShellState {
	readonly workspaces: readonly Workspace[];
	readonly selectedId: string | undefined;
}

/** The rectangle, in page CSS pixels, that workbench views must cover. */
export interface ContentRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** The surface the preload puts on `window.devhub`. */
export interface DevhubApi {
	getState(): Promise<ShellState>;
	onStateChanged(listener: (state: ShellState) => void): () => void;
	selectWorkspace(id: string): Promise<void>;
	/** Opens the native folder picker; resolves when the pick was handled. */
	addWorkspace(): Promise<void>;
	removeWorkspace(id: string): Promise<void>;
	setContentRect(rect: ContentRect): Promise<void>;
}

/**
 * Channel names. Requests are `invoke`/`handle`; the single push is the state
 * the page mirrors. Main→page pushes carry no other traffic.
 */
export const CHANNELS = {
	getState: "devhub:get-state",
	selectWorkspace: "devhub:select-workspace",
	addWorkspace: "devhub:add-workspace",
	removeWorkspace: "devhub:remove-workspace",
	setContentRect: "devhub:set-content-rect",
	stateChanged: "devhub:state-changed",
} as const;
