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
			reason: "containing",
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
			reason: "containing",
			workspace: workspace("inner", "/work/alpha/inner", "local"),
		});
	});

	it("goes to Scratch when no open Workspace contains the path", () => {
		const open = routeOpen("/elsewhere/notes.md", "local", [
			workspace("alpha", "/work/alpha", "local"),
		]);

		expect(open).toEqual({
			kind: "scratch",
			reason: "no-containing-workspace",
		});
	});

	it("goes to Scratch when there is nothing open at all", () => {
		expect(routeOpen("/work/alpha/f.ts", "local", [])).toEqual({
			kind: "scratch",
			reason: "no-containing-workspace",
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
			reason: "containing",
			workspace: workspace("here", "/srv/app", "local"),
		});
	});

	it("routes a path on the host to the Workspace on that host", () => {
		expect(routeOpen("/srv/app/src/main.ts", "ssh:build-host", both)).toEqual({
			kind: "workspace",
			reason: "containing",
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
			reason: "no-containing-workspace",
		});
	});
});

/**
 * The case the whole feature is for: a file that no open Workspace contains,
 * typed into a Workspace's own terminal.
 *
 * Before the origin it went to Scratch, every time, because the path was the
 * only thing the request carried. Where it should go is not a preference about
 * focus — it is the window that made the terminal.
 */
describe("an open that says which workbench it came from", () => {
	const alpha = workspace("alpha-id", "/work/alpha", "local");
	const beta = workspace("beta-id", "/work/beta", "local");
	const open = [alpha, beta];
	const fromAlpha = "local\talpha-id";

	it("lands in that window even when no Workspace contains the path", () => {
		expect(routeOpen("/etc/hosts", "local", open, fromAlpha)).toEqual({
			kind: "workspace",
			reason: "origin",
			workspace: alpha,
		});
	});

	/**
	 * The origin wins over the containing Workspace, not the other way round.
	 * `devhub ../beta/x.ts` from alpha's terminal opens in alpha, the way
	 * `code ../beta/x.ts` from VS Code's terminal does.
	 */
	it("lands in that window even when another Workspace contains the path", () => {
		expect(routeOpen("/work/beta/x.ts", "local", open, fromAlpha)).toEqual({
			kind: "workspace",
			reason: "origin",
			workspace: alpha,
		});
	});

	it("lands in Scratch when the terminal is Scratch's own", () => {
		expect(
			routeOpen("/work/alpha/f.ts", "local", open, "local\tscratch"),
		).toEqual({ kind: "scratch", reason: "origin" });
	});

	/**
	 * A tmux session outlives the window it was made for, by design, so a pane
	 * naming a Workspace that was closed an hour ago is ordinary rather than
	 * exceptional. It must fall through to the rule, not fail: the person asked
	 * to open a file and there is still a right answer to that.
	 */
	it("falls through to the containing Workspace when the origin's window is gone", () => {
		expect(
			routeOpen("/work/beta/x.ts", "local", open, "local\tclosed-id"),
		).toEqual({ kind: "workspace", reason: "containing", workspace: beta });
	});

	it("falls through to Scratch when the origin is gone and nothing contains the path", () => {
		expect(routeOpen("/etc/hosts", "local", open, "local\tclosed-id")).toEqual({
			kind: "scratch",
			reason: "no-containing-workspace",
		});
	});

	/**
	 * Half a match is not a match. An id that belongs to a Workspace on another
	 * machine is not this pane's window, whatever the id says.
	 */
	it("ignores an origin whose machine disagrees with the Workspace's", () => {
		expect(
			routeOpen("/work/beta/x.ts", "local", open, "ssh:build-host\talpha-id"),
		).toEqual({ kind: "workspace", reason: "containing", workspace: beta });
	});

	/**
	 * DevHub wrote the variable, so anything that is not the shape DevHub
	 * writes came from somewhere else and says nothing about DevHub.
	 */
	it("ignores an origin that is not the shape DevHub writes", () => {
		for (const malformed of ["", "local", "local\talpha-id\textra", "\t"]) {
			expect(routeOpen("/etc/hosts", "local", open, malformed)).toEqual({
				kind: "scratch",
				reason: "no-containing-workspace",
			});
		}
	});

	/** A Workspace on a host, reached from a pane on that host. */
	it("lands in a remote Workspace's window for a pane on that host", () => {
		const remote = workspace("remote-id", "/srv/app", "ssh:build-host");

		expect(
			routeOpen(
				"/etc/hosts",
				"ssh:build-host",
				[alpha, remote],
				"ssh:build-host\tremote-id",
			),
		).toEqual({ kind: "workspace", reason: "origin", workspace: remote });
	});
});
