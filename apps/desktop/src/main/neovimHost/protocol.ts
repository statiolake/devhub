/**
 * What main and the Neovim host say to each other (`client.ts`, `host.ts`).
 * What a page and the host say on the page's port is `ipc/neovim.ts`'s
 * (`PageToNeovimHost`, `NeovimHostToPage`): the preload is the page's end.
 *
 * Main hands the host each page's port and says which Neovim a page attaches
 * to; the host answers the attach, and says when a UI's connection ended,
 * when the current buffer changed, and what Neovim did with the clipboard,
 * which is main's (a utility process has none).
 */

import type { NeovimUiTarget } from "../editor/neovimUiSessions.js";

export type ToNeovimHost =
	/** A page's port, transferred with this message. */
	| { readonly type: "page"; readonly page: number }
	| { readonly type: "page-gone"; readonly page: number }
	| {
			readonly type: "attach";
			readonly rid: number;
			readonly page: number;
			readonly target: NeovimUiTarget;
	  }
	/** Let go of a Workspace's UI without saying so: it is closing. */
	| { readonly type: "detach"; readonly workspaceId: string }
	/** The answer to `clipboard-read`. */
	| { readonly type: "clipboard"; readonly rid: number; readonly text: string };

export type FromNeovimHost =
	| {
			readonly type: "attached";
			readonly rid: number;
			readonly version: string;
	  }
	| {
			readonly type: "attach-failed";
			readonly rid: number;
			readonly message: string;
	  }
	| { readonly type: "ended"; readonly workspaceId: string }
	| {
			readonly type: "buffer";
			readonly workspaceId: string;
			readonly name: string;
	  }
	| { readonly type: "clipboard-read"; readonly rid: number }
	| { readonly type: "clipboard-write"; readonly text: string };
