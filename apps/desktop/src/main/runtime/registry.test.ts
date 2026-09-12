/**
 * The one switch, and the fact that it is the only one.
 */

import { describe, expect, it } from "vitest";
import { workspaceLocation } from "../../model/domain.js";
import {
	disposeRuntime,
	liveRuntimes,
	localRuntime,
	runtimeFor,
} from "./registry.js";

describe("runtimeFor", () => {
	it("gives every local Workspace the one local runtime", () => {
		const one = runtimeFor(workspaceLocation({ kind: "local", path: "/a" }));
		const two = runtimeFor(workspaceLocation({ kind: "local", path: "/b" }));
		expect(one).toBe(two);
		expect(one).toBe(localRuntime());
		expect(one.id).toBe("local");
		expect(one.where).toBe("");
	});

	it("gives every Workspace on one host the same runtime", () => {
		// Not an optimisation: a second runtime for one host would be a second
		// multiplexed connection, a second `$HOME` and a `devhub --metrics` that
		// reported half the truth twice.
		const one = runtimeFor(
			workspaceLocation({ kind: "ssh", host: "build-box", path: "/srv/a" }),
		);
		const two = runtimeFor(
			workspaceLocation({ kind: "ssh", host: "build-box", path: "/srv/b" }),
		);
		const other = runtimeFor(
			workspaceLocation({ kind: "ssh", host: "other-box", path: "/srv/a" }),
		);
		expect(one).toBe(two);
		expect(one).not.toBe(other);
		expect(one.id).toBe("ssh:build-box");
		expect(one.where).toBe(" on build-box");
	});

	it("lists the runtimes that are live, for a reading", async () => {
		expect(liveRuntimes()).toContain(localRuntime());
		expect(liveRuntimes()[0]).toBe(localRuntime());
	});

	it("forgets a host nothing is on any more", async () => {
		const before = runtimeFor(
			workspaceLocation({ kind: "ssh", host: "gone-box", path: "/srv/a" }),
		);
		expect(liveRuntimes()).toContain(before);
		await disposeRuntime(before.id);
		expect(liveRuntimes()).not.toContain(before);
	});
});
