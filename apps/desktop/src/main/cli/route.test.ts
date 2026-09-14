import { describe, expect, it } from "vitest";
import { routeOpen, type RoutableWorkspace } from "./route.js";

function workspace(
	workspaceId: string,
	root: string,
	machine: string,
): RoutableWorkspace {
	return { workspaceId, root, machine };
}

describe("where an open lands", () => {
	it("goes to the Workspace whose root contains the path", () => {
		const open = routeOpen("/work/alpha/src/main.ts", "local", [
			workspace("alpha", "/work/alpha", "local"),
			workspace("beta", "/work/beta", "local"),
		]);

		expect(open).toEqual({
			kind: "workspace",
			workspace: workspace("alpha", "/work/alpha", "local"),
		});
	});

	it("goes to the deepest Workspace when they are nested", () => {
		const open = routeOpen("/work/alpha/inner/f.ts", "local", [
			workspace("outer", "/work/alpha", "local"),
			workspace("inner", "/work/alpha/inner", "local"),
		]);

		expect(open).toEqual({
			kind: "workspace",
			workspace: workspace("inner", "/work/alpha/inner", "local"),
		});
	});

	it("goes to Scratch when no open Workspace contains the path", () => {
		const open = routeOpen("/elsewhere/notes.md", "local", [
			workspace("alpha", "/work/alpha", "local"),
		]);

		expect(open).toEqual({ kind: "scratch" });
	});

	it("goes to Scratch when there is nothing open at all", () => {
		expect(routeOpen("/work/alpha/f.ts", "local", [])).toEqual({
			kind: "scratch",
		});
	});
});

/**
 * The failure the `machine` field exists to prevent, from both ends.
 *
 * It is not hypothetical and it is not loud: two computers with a `/srv/app`
 * on each is the ordinary shape of a checkout mirrored onto a build host, and
 * a rule that could not tell them apart routed by whichever one the model
 * happened to list first.
 */
describe("two machines with the same root", () => {
	const both = [
		workspace("here", "/srv/app", "local"),
		workspace("there", "/srv/app", "ssh:build-host"),
	];

	it("routes a local path to the local Workspace", () => {
		expect(routeOpen("/srv/app/src/main.ts", "local", both)).toEqual({
			kind: "workspace",
			workspace: workspace("here", "/srv/app", "local"),
		});
	});

	it("routes a path on the host to the Workspace on that host", () => {
		expect(routeOpen("/srv/app/src/main.ts", "ssh:build-host", both)).toEqual({
			kind: "workspace",
			workspace: workspace("there", "/srv/app", "ssh:build-host"),
		});
	});

	/**
	 * The listing order is the whole of what the old rule answered from, so a
	 * reversed list is the case that used to come out the other way round.
	 */
	it("gives the same answer whatever order the Workspaces are listed in", () => {
		const reversed = [...both].reverse();

		expect(routeOpen("/srv/app/f.ts", "local", reversed)).toEqual(
			routeOpen("/srv/app/f.ts", "local", both),
		);
		expect(routeOpen("/srv/app/f.ts", "ssh:build-host", reversed)).toEqual(
			routeOpen("/srv/app/f.ts", "ssh:build-host", both),
		);
	});

	it("sends a path on a third machine to Scratch rather than to either of them", () => {
		expect(routeOpen("/srv/app/f.ts", "ssh:other-host", both)).toEqual({
			kind: "scratch",
		});
	});
});
