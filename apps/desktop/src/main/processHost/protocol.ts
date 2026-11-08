/**
 * What main and the process host say to each other (`client.ts`, `entry.ts`).
 *
 * Plain data both ways, numbered by the run: main asks for a child and may
 * end it; the host says what came out of it and how it ended.
 */

import type { ChildOutcome, ChildRequest } from "../terminal/childRun.js";

export type ToHost =
	| {
			readonly type: "run";
			readonly id: number;
			readonly request: ChildRequest;
	  }
	| { readonly type: "kill"; readonly id: number };

export type FromHost =
	| { readonly type: "output"; readonly id: number; readonly chunk: Uint8Array }
	| {
			readonly type: "ended";
			readonly id: number;
			readonly outcome: ChildOutcome;
	  }
	/** The host could not start the run at all (`spawn` threw). */
	| { readonly type: "threw"; readonly id: number; readonly message: string };
