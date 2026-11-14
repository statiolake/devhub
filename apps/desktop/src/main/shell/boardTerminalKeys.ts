/**
 * Where the keys are while the Orchestrator's Terminal tab is on screen: in
 * its terminal (the Workspace's terminal page laid over the board's body,
 * `LayoutState.boardTerminal`), or in the board and the orchestrator's pane
 * beside it.
 *
 * - Choosing the tab puts them in the terminal: its first show, a click on
 *   the tab (the one shown included), the row's Show Editor, `Cmd+Q E`.
 * - A click takes them where it landed: into the terminal page, or out of it
 *   into the board's page (its header, the tab strip in it too) or the
 *   orchestrator's conversation.
 * - Off the tab there is nothing to remember: the next show starts in it.
 *
 * The press that chooses the tab lands in the board's header first, and so
 * takes the keys out (`focused("agents")`) before the choice comes (`chosen`)
 * and puts them back: choosing must always say so, not only when the tab
 * was not shown — a click on the Terminal tab already shown used to leave
 * the keys in the board, with nothing typed reaching the terminal or tmux.
 */
export class BoardTerminalKeys {
	/** Undefined while the tab is not on screen. */
	#inTerminal: boolean | undefined;

	/** Whether the keys are the terminal's (only while the tab is shown). */
	get inTerminal(): boolean {
		return this.#inTerminal === true;
	}

	/** The tab was chosen: the keys go into its terminal. */
	chosen(): void {
		this.#inTerminal = true;
	}

	/**
	 * A content view took the keyboard by itself (a click): the terminal's
	 * page (`editor`), the board's (`agents`), an Agent terminal's. Whether
	 * that changed where the keys are, for the layout to be said again.
	 */
	focused(pane: "editor" | "agents" | "terminal"): boolean {
		if (this.#inTerminal === undefined || pane === "terminal") return false;
		const inTerminal = pane === "editor";
		if (inTerminal === this.#inTerminal) return false;
		this.#inTerminal = inTerminal;
		return true;
	}

	/**
	 * The arrangement, as it is laid: whether the tab is on screen. Shown
	 * for the first time since it was not, it starts with the keys.
	 */
	shown(onScreen: boolean): void {
		if (!onScreen) this.#inTerminal = undefined;
		else if (this.#inTerminal === undefined) this.#inTerminal = true;
	}
}

/**
 * Where `Cmd+Q O` on the Orchestrator row takes the keys, from where they
 * are (`AppController.swapOrchestratorFocus`):
 *
 * - `conversation`: out of the board's half — the Terminal tab's terminal,
 *   or a GUI orchestrator's board — to the orchestrator agent's pane.
 * - `board-terminal`: from a GUI conversation to the Terminal tab shown,
 *   chosen as its tab is (`BoardTerminalKeys.chosen`).
 * - `board`: from a GUI conversation to the board.
 * - `toggle`: a TUI orchestrator's pane and the board are one page, the
 *   Agents view, whose focus is the only word on which of them has the
 *   keys, so that page moves them (to the tab, with it shown).
 */
export type OrchestratorFocusMove =
	| "conversation"
	| "board-terminal"
	| "board"
	| "toggle";

export function orchestratorFocusMove(where: {
	/** The keys are the Terminal tab's (`BoardTerminalKeys.inTerminal`). */
	readonly inBoardTerminal: boolean;
	/** The Terminal tab is on screen. */
	readonly boardTerminalShown: boolean;
	/** The orchestrator's pane is a GUI conversation, a view of its own. */
	readonly gui: boolean;
	/** With a GUI one, the board rather than it is where the keys go. */
	readonly keysOnBoard: boolean;
}): OrchestratorFocusMove {
	if (where.inBoardTerminal || (where.gui && where.keysOnBoard))
		return "conversation";
	if (!where.gui) return "toggle";
	return where.boardTerminalShown ? "board-terminal" : "board";
}
