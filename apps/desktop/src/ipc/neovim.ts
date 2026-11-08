/**
 * The Neovim editor page's wire: `neovim.html`, main, and the Neovim host.
 *
 * The page is a GUI for one headless Neovim (`docs/neovim-editor.md`). Main
 * finds or starts the Neovim and answers the attach; the UI's own connection
 * — the socket, the attach, the clipboard and GUI-window requests Neovim
 * makes — is the Neovim host's (`main/neovimHost/`), which forwards Neovim's
 * `redraw` batches to the page over the page's port as they arrived (ext
 * handles already turned into numbers), and takes back what the person did
 * as Neovim API calls on the same port. With the host given up on, main
 * holds the connection and the same messages go over IPC. Nothing here
 * interprets the UI protocol: that is `shell/neovim/redraw.ts`.
 *
 * Nothing here may import Electron, Node or the DOM: the file is compiled
 * into the main process, the preload and the page alike.
 */

/**
 * DevHub's own redraw event, not Neovim's: put in the redraw stream where a
 * UI starts over on the server a `:restart` started (0.12), so the page
 * forgets the old server's screen in order with the new one's first events
 * (`main/editor/neovimUiSessions.ts`, `shell/neovim/redraw.ts`).
 */
export const NEOVIM_RESTARTED_EVENT = "devhub_restarted";

export const NEOVIM_CHANNELS = {
	/** page → main: attach as this Workspace's UI at this size. */
	attach: "devhub:neovim:attach",
	/** page → main: a Neovim API call, fire and forget, in order. */
	call: "devhub:neovim:call",
	/** page → main: a Neovim API call whose answer the page waits for. */
	request: "devhub:neovim:request",
	/** main → page: one `redraw` notification's batches. */
	redraw: "devhub:neovim:redraw",
	/** main → page: the connection to Neovim ended (with why). */
	ended: "devhub:neovim:ended",
	/** main → page: a GUI window was opened, changed or closed from Lua. */
	guiWindow: "devhub:neovim:gui-window",
	/** main → page: which Neovim windows show GUI windows, and which is current. */
	guiWindows: "devhub:neovim:gui-windows",
	/** page → main: a GUI window's page posted a message to its Lua side. */
	guiMessage: "devhub:neovim:gui-message",
	/** main → page: Lua sent a GUI window a message. */
	guiSend: "devhub:neovim:gui-send",
	/** main → page: a toast, an inline image, a rich float, and where they are. */
	guiEvent: "devhub:neovim:gui-event",
	/** main → page: a port to the Neovim host (transferred), with its generation. */
	port: "devhub:neovim:port",
	/** main → page: the Neovim host of this generation ended; its port is dead. */
	restarted: "devhub:neovim:restarted",
} as const;

/** What the page asks for when it attaches. */
export interface NeovimAttachRequest {
	readonly workspaceId: string;
	readonly cols: number;
	readonly rows: number;
}

export type NeovimAttachResult =
	| {
			readonly ok: true;
			/** `major.minor.patch` of the Neovim attached to. */
			readonly version: string;
			/** Where it runs, for the page's sentences (`""` on this Mac). */
			readonly where: string;
	  }
	| { readonly ok: false; readonly message: string };

/**
 * The attach as main answers the preload: `hosted` is the generation of the
 * Neovim host whose port carries this Workspace's UI from now on; absent, it
 * is main's and its calls are IPC.
 */
export type NeovimAttachReply = NeovimAttachResult & {
	readonly hosted?: number;
};

/** One API call the page makes: `nvim_input`, `nvim_input_mouse`, … */
export interface NeovimCall {
	readonly workspaceId: string;
	readonly method: string;
	readonly params: readonly unknown[];
}

export type NeovimRequestResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly message: string };

/**
 * A GUI window: web content DevHub paints over a Neovim window's grid
 * (`require('devhub_gui').open{…}`). Neovim owns where it is; this only says
 * what is in it.
 */
export interface NeovimGuiWindowWire {
	readonly id: number;
	/** The Neovim window it is drawn in (its handle). */
	readonly win: number;
	readonly title: string;
	readonly content:
		| { readonly kind: "html"; readonly html: string }
		| { readonly kind: "url"; readonly url: string };
	/** `false`: the window was closed and this GUI window with it. */
	readonly open: boolean;
}

/** Every Neovim window showing a GUI window, and Neovim's current window. */
export interface NeovimGuiWindowsWire {
	readonly windows: readonly {
		readonly id: number;
		readonly win: number;
		/** A float with a border: the content goes inside its cells. */
		readonly border?: boolean;
	}[];
	readonly current: number;
	/** Every window of the current tab page, where Neovim says it is. */
	readonly layout?: readonly {
		readonly win: number;
		readonly row: number;
		readonly col: number;
		readonly width: number;
		readonly height: number;
	}[];
}

/** A message between a GUI window's page and its Lua side. */
export interface NeovimGuiMessage {
	readonly workspaceId: string;
	readonly id: number;
	readonly message: unknown;
}

/**
 * A one-way event from `devhub_gui` (`docs/neovim-editor.md`): `notify`
 * (a toast), `image`/`image_clear`, `rich`/`rich_clear` (a float's markdown)
 * and `place` (where every image and rich float is now). The page checks the
 * payload's shape; anything it does not understand is ignored.
 */
export interface NeovimGuiEvent {
	readonly workspaceId: string;
	readonly kind: string;
	readonly payload: unknown;
}

/** What the UI's connection says to its page, on its port or (from main) as IPC. */
export type NeovimPageEvent =
	| {
			readonly type: "redraw";
			readonly workspaceId: string;
			readonly batches: readonly unknown[];
	  }
	| {
			readonly type: "gui-window";
			readonly workspaceId: string;
			readonly window: NeovimGuiWindowWire;
	  }
	| {
			readonly type: "gui-windows";
			readonly workspaceId: string;
			readonly windows: NeovimGuiWindowsWire;
	  }
	| { readonly type: "gui-send"; readonly message: NeovimGuiMessage }
	| { readonly type: "gui-event"; readonly event: NeovimGuiEvent };

/** What the page sends the Neovim host on its port; `request` is answered by `rid`. */
export type PageToNeovimHost =
	| { readonly type: "call"; readonly call: NeovimCall }
	| {
			readonly type: "request";
			readonly rid: number;
			readonly call: NeovimCall;
	  }
	| { readonly type: "gui-message"; readonly message: NeovimGuiMessage };

export type NeovimHostToPage =
	| NeovimPageEvent
	| {
			readonly type: "reply";
			readonly rid: number;
			readonly result: NeovimRequestResult;
	  };

/** The bridge member the Neovim page has (`window.devhub.neovim`). */
export interface DevhubNeovimApi {
	attach(request: NeovimAttachRequest): Promise<NeovimAttachResult>;
	call(call: NeovimCall): void;
	request(call: NeovimCall): Promise<NeovimRequestResult>;
	onRedraw(
		listener: (workspaceId: string, batches: readonly unknown[]) => void,
	): () => void;
	/**
	 * The connection ended. `reconnect`: only the way to Neovim went (the
	 * Neovim host restarted) and it went on running, so attaching again
	 * picks it up — the page does so by itself.
	 */
	onEnded(
		listener: (workspaceId: string, reason: string, reconnect: boolean) => void,
	): () => void;
	onGuiWindow(
		listener: (workspaceId: string, window: NeovimGuiWindowWire) => void,
	): () => void;
	onGuiWindows(
		listener: (workspaceId: string, windows: NeovimGuiWindowsWire) => void,
	): () => void;
	onGuiSend(listener: (message: NeovimGuiMessage) => void): () => void;
	onGuiEvent(listener: (event: NeovimGuiEvent) => void): () => void;
	guiMessage(message: NeovimGuiMessage): void;
}
