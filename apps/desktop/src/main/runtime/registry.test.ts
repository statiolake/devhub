/**
 * The one switch, and the fact that it is the only one.
 */

import { describe, expect, it } from "vitest";
import { workspaceLocation } from "../../model/domain.js";
import { TypedFailure } from "../../model/wire.js";
import { liveRuntimes, localRuntime, runtimeFor } from "./registry.js";

describe("runtimeFor", () => {
	it("gives every local Workspace the one local runtime", () => {
		const one = runtimeFor(workspaceLocation({ kind: "local", path: "/a" }));
		const two = runtimeFor(workspaceLocation({ kind: "local", path: "/b" }));
		expect(one).toBe(two);
		expect(one).toBe(localRuntime());
		expect(one.id).toBe("local");
		expect(one.where).toBe("");
	});

	it("refuses an ssh Workspace at the moment it is asked, naming the host", () => {
		// Loudly, and here, rather than by handing back something that answers
		// some calls and swallows others: a runtime that half-works puts the
		// "not on this machine" branch back into every caller.
		let thrown: unknown;
		try {
			runtimeFor(
				workspaceLocation({ kind: "ssh", host: "build-box", path: "/srv/app" }),
			);
		} catch (error: unknown) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(TypedFailure);
		expect((thrown as TypedFailure).wire.summary).toBe(
			"DevHub cannot run anything on build-box yet: its SSH runtime is not implemented.",
		);
	});

	it("lists the runtimes that are live, for a reading", () => {
		expect(liveRuntimes()).toEqual([localRuntime()]);
	});
});
