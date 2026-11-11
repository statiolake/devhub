/**
 * What main, the pty host and the pages say to each other (`client.ts`,
 * `host.ts`, `preload/terminal.ts`).
 *
 * Main asks the host to start and stop control clients and hands it each
 * page's port; the host says when a client has started, could not start, or
 * has ended. A page and the host talk over the page's port: the client's news
 * one way, the page's requests the other, each answered with a
 * `TerminalResult`.
 */

import type {
	ExitReason,
	TerminalResult,
	TerminalSize,
} from "../../ipc/terminal.js";
import type { PtyLaunch } from "../terminal/pty.js";
import type { ControlToPage } from "../../ipc/terminalControl.js";

/** One client to start: its identity, its page, and what to run. */
export interface OpenSpec {
	readonly id: string;
	readonly surfaceKey: string;
	readonly viewLabel: string;
	readonly targetGeneration: number;
	readonly size: TerminalSize;
	/** The page's number, as `page` gave it. */
	readonly page: number;
	/** The page's channel id for this surface: what its news is sent under. */
	readonly channelId: string;
	/** The tmux control client (`control/controlClient.ts`), run on pipes. */
	readonly launch: PtyLaunch;
	/** What its popups are opened as (`control/popup.ts`), in a pty. */
	readonly popupLaunch?: PtyLaunch;
}

export type ToPtyHost =
	/** A page's port, transferred with this message; `viewLabel` owns what it opens. */
	| { readonly type: "page"; readonly page: number; readonly viewLabel: string }
	| { readonly type: "page-gone"; readonly page: number }
	| { readonly type: "open"; readonly rid: number; readonly spec: OpenSpec }
	| {
			readonly type: "stop";
			readonly id: string;
			readonly reason: ExitReason;
	  };

export type FromPtyHost =
	| { readonly type: "opened"; readonly rid: number }
	| {
			readonly type: "open-failed";
			readonly rid: number;
			readonly message: string;
	  }
	| {
			readonly type: "ended";
			readonly id: string;
			readonly reason: ExitReason;
	  }
	/**
	 * A control client read a pane's `@devhub-nvim` from tmux (`""`: none):
	 * the surface and page it draws, the pane and its size in cells.
	 */
	| {
			readonly type: "nvim-socket";
			readonly surfaceKey: string;
			readonly page: number;
			readonly pane: number;
			readonly socket: string;
			readonly cols: number;
			readonly rows: number;
	  };

export type PageToPtyHost = {
	/** A `ControlRequest`, for a control client. */
	readonly type: "control";
	readonly rid: number;
	/** The request as the page sent it; validated by the host. */
	readonly request: unknown;
};

export type PtyHostToPage =
	| {
			/** A control client's news for the page that drew it. */
			readonly type: "control";
			readonly channelId: string;
			readonly attachmentId: string;
			/** Its end: nothing follows it on this channel. */
			readonly last: boolean;
			readonly message: ControlToPage;
	  }
	| {
			readonly type: "reply";
			readonly rid: number;
			readonly result: TerminalResult<void>;
	  };
