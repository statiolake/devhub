/**
 * What main and the process host say to each other (`client.ts`, `entry.ts`).
 *
 * Plain data both ways, numbered by the run: main asks for a child and may
 * end it; the host says what came out of it and how it ended. A stream is a
 * child with no end in sight (`terminal/streamRun.ts`): its bytes come back
 * here, or go to the port that came with `stream` and are never main's.
 */

import type { ChildOutcome, ChildRequest } from "../terminal/childRun.js";
import type { StreamExit, StreamSpawn } from "../terminal/streamRun.js";

export type ToHost =
	| {
			readonly type: "run";
			readonly id: number;
			readonly request: ChildRequest;
	  }
	| { readonly type: "kill"; readonly id: number }
	/** With one transferred port when its bytes go elsewhere (`StreamSink`). */
	| {
			readonly type: "stream";
			readonly id: number;
			readonly spawn: StreamSpawn;
	  }
	| { readonly type: "stream-kill"; readonly id: number };

export type FromHost =
	| { readonly type: "output"; readonly id: number; readonly chunk: Uint8Array }
	| {
			readonly type: "ended";
			readonly id: number;
			readonly outcome: ChildOutcome;
	  }
	/** The host could not start the run at all (`spawn` threw). */
	| { readonly type: "threw"; readonly id: number; readonly message: string }
	/** A stream's bytes, for one that came without a port. */
	| {
			readonly type: "stream-data";
			readonly id: number;
			readonly chunk: Uint8Array;
	  }
	| {
			readonly type: "stream-ended";
			readonly id: number;
			readonly exit: StreamExit;
	  };
