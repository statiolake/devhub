/**
 * What main, the pty host and the pages say to each other (`client.ts`,
 * `host.ts`, `preload/terminal.ts`).
 *
 * Main asks the host to start and stop clients and hands it each page's port;
 * the host says when a client has started, could not start, or has ended.
 * A page and the host talk over the page's port: frames one way; input,
 * resizes and acks the other, each answered with a `TerminalResult`.
 */

import type {
	ExitReason,
	TerminalResult,
	TerminalSize,
} from "../../ipc/terminal.js";
import type { PtyLaunch } from "../terminal/pty.js";

/** One client to start: its identity, its page, and what to run. */
export interface OpenSpec {
	readonly id: string;
	readonly surfaceKey: string;
	readonly viewLabel: string;
	readonly targetGeneration: number;
	readonly size: TerminalSize;
	/** The page's number, as `page` gave it. */
	readonly page: number;
	/** The page's channel id for this surface: what its frames are sent under. */
	readonly channelId: string;
	readonly launch: PtyLaunch;
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
	  };

export type PageToPtyHost = {
	readonly type: "input" | "resize" | "ack";
	readonly rid: number;
	/** The request as the page sent it; validated by the host. */
	readonly request: unknown;
};

export type PtyHostToPage =
	| {
			readonly type: "frame";
			readonly channelId: string;
			/**
			 * Whose frame: a channel's next attachment can start while the one
			 * it replaced still has frames on the way.
			 */
			readonly attachmentId: string;
			readonly sequence: number;
			/** An exited or error frame: nothing follows it on this channel. */
			readonly last: boolean;
			/** `encodeTerminalFrame`'s bytes, as main's frames are. */
			readonly frame: Uint8Array;
	  }
	| {
			readonly type: "reply";
			readonly rid: number;
			readonly result: TerminalResult<void>;
	  };
