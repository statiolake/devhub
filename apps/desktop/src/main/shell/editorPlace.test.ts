import { describe, expect, it } from "vitest";
import { locationFromWorkspaceUri, SCRATCH_EDITOR_KEY } from "./editorPlace.js";
import { locationKey } from "../../model/domain.js";

/** As much of a `URI` as the rule reads, spelled out. */
function uri(parts: {
	scheme: string;
	authority?: string;
	path?: string;
	fsPath?: string;
}) {
	return {
		scheme: parts.scheme,
		authority: parts.authority ?? "",
		path: parts.path ?? "",
		fsPath: parts.fsPath ?? "",
	};
}

describe("which place a window's folder URI names", () => {
	it("reads a local folder exactly as it always did", () => {
		expect(
			locationFromWorkspaceUri(uri({ scheme: "file", fsPath: "/dev/api" })),
		).toEqual({ kind: "local", path: "/dev/api" });
	});

	it("reads an ssh authority back into the host it was composed from", () => {
		expect(
			locationFromWorkspaceUri(
				uri({
					scheme: "vscode-remote",
					authority: "ssh-remote+build.example.com",
					path: "/srv/api",
				}),
			),
		).toEqual({ kind: "ssh", host: "build.example.com", path: "/srv/api" });
	});

	it("gives the same key both ways, so one window is found by both sides", () => {
		// This is the whole reason the rule is in one place: DevHub files a view
		// under `locationKey`, and VS Code asks whether this URI already has one.
		// Two spellings of the same place would open a second workbench.
		const place = locationFromWorkspaceUri(
			uri({
				scheme: "vscode-remote",
				authority: "ssh-remote+build",
				path: "/srv/api",
			}),
		);
		expect(place && locationKey(place)).toBe("ssh://build/srv/api");
	});

	it("does not mistake a remote window for Scratch", () => {
		// `fsPath` on a `vscode-remote://` URI is not a local path, and reading it
		// as one used to be the only thing this code did — so an SSH Workspace's
		// window would have fallen through to "no folder", which is DevHub's
		// signal for the Scratch editor.
		const remote = uri({
			scheme: "vscode-remote",
			authority: "ssh-remote+build",
			path: "/srv/api",
		});
		expect(locationFromWorkspaceUri(remote)).not.toBeUndefined();
	});

	it("says nothing about an authority some other resolver owns", () => {
		expect(
			locationFromWorkspaceUri(
				uri({
					scheme: "vscode-remote",
					authority: "wsl+Ubuntu",
					path: "/srv/api",
				}),
			),
		).toBeUndefined();
		expect(
			locationFromWorkspaceUri(uri({ scheme: "untitled", path: "/x" })),
		).toBeUndefined();
	});

	it("refuses a place this build would not have made, rather than throwing", () => {
		// A URI arrives from VS Code, not from DevHub's own constructor, so a host
		// or path this build rejects is "no place DevHub knows" — not a crash in
		// the middle of opening somebody's window.
		expect(
			locationFromWorkspaceUri(
				uri({
					scheme: "vscode-remote",
					authority: "ssh-remote+has a space",
					path: "/srv/api",
				}),
			),
		).toBeUndefined();
		expect(
			locationFromWorkspaceUri(
				uri({ scheme: "file", fsPath: "relative/path" }),
			),
		).toBeUndefined();
	});

	it("keeps Scratch's key out of every real one's way", () => {
		expect(SCRATCH_EDITOR_KEY).toBe("");
		for (const place of [
			{ kind: "local" as const, path: "/dev/api" as never },
			{ kind: "ssh" as const, host: "build" as never, path: "/srv" as never },
		]) {
			expect(locationKey(place)).not.toBe(SCRATCH_EDITOR_KEY);
		}
	});
});
