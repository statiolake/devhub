import { describe, expect, it } from "vitest";
import { editorPlaceFromWorkspaceUri } from "./editorPlace.js";
import {
	devContainerConfigPath,
	editorAuthorityOf,
	locationKey,
	workspaceLocation,
} from "../../model/domain.js";

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
			editorPlaceFromWorkspaceUri(uri({ scheme: "file", fsPath: "/dev/api" })),
		).toEqual({
			location: { kind: "local", path: "/dev/api" },
			editor: { kind: "host" },
		});
	});

	it("reads an ssh authority back into the host it was composed from", () => {
		expect(
			editorPlaceFromWorkspaceUri(
				uri({
					scheme: "vscode-remote",
					authority: "ssh-remote+build.example.com",
					path: "/srv/api",
				}),
			),
		).toEqual({
			location: { kind: "ssh", host: "build.example.com", path: "/srv/api" },
			editor: { kind: "host" },
		});
	});

	it("gives the same key both ways, so one window is found by both sides", () => {
		// This is the whole reason the rule is in one place: DevHub files a view
		// under `locationKey`, and VS Code asks whether this URI already has one.
		// Two spellings of the same place would open a second workbench.
		const place = editorPlaceFromWorkspaceUri(
			uri({
				scheme: "vscode-remote",
				authority: "ssh-remote+build",
				path: "/srv/api",
			}),
		);
		expect(place && locationKey(place.location)).toBe("ssh://build/srv/api");
	});

	it("reads a dev container window as the Workspace's own folder, with its editor attached", () => {
		// The URI's path is where the folder is mounted *inside*; the Workspace is
		// the folder here. So the key is the one the folder opened locally has,
		// and a reattached editor lands in the same slot.
		const location = workspaceLocation({ kind: "local", path: "/src/api" });
		const editor = {
			kind: "devContainer",
			configPath: devContainerConfigPath(
				"/src/api/.devcontainer/python/devcontainer.json",
			),
		} as const;
		const place = editorPlaceFromWorkspaceUri(
			uri({
				scheme: "vscode-remote",
				authority: editorAuthorityOf(location, editor) ?? "",
				path: "/workspaces/api",
			}),
		);
		expect(place).toEqual({ location, editor });
		expect(place && locationKey(place.location)).toBe("/src/api");
	});

	it("reads a dev container on a host as that host's folder", () => {
		const location = workspaceLocation({
			kind: "ssh",
			host: "build",
			path: "/srv/api",
		});
		const editor = {
			kind: "devContainer",
			configPath: devContainerConfigPath(
				"/srv/api/.devcontainer/devcontainer.json",
			),
		} as const;
		const place = editorPlaceFromWorkspaceUri(
			uri({
				scheme: "vscode-remote",
				authority: editorAuthorityOf(location, editor) ?? "",
				path: "/workspaces/api",
			}),
		);
		expect(place).toEqual({ location, editor });
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
		expect(editorPlaceFromWorkspaceUri(remote)).not.toBeUndefined();
	});

	it("says nothing about an authority some other resolver owns", () => {
		expect(
			editorPlaceFromWorkspaceUri(
				uri({
					scheme: "vscode-remote",
					authority: "wsl+Ubuntu",
					path: "/srv/api",
				}),
			),
		).toBeUndefined();
		expect(
			editorPlaceFromWorkspaceUri(uri({ scheme: "untitled", path: "/x" })),
		).toBeUndefined();
	});

	it("refuses a place this build would not have made, rather than throwing", () => {
		// A URI arrives from VS Code, not from DevHub's own constructor, so a host
		// or path this build rejects is "no place DevHub knows" — not a crash in
		// the middle of opening somebody's window.
		expect(
			editorPlaceFromWorkspaceUri(
				uri({
					scheme: "vscode-remote",
					authority: "ssh-remote+has a space",
					path: "/srv/api",
				}),
			),
		).toBeUndefined();
		expect(
			editorPlaceFromWorkspaceUri(
				uri({ scheme: "file", fsPath: "relative/path" }),
			),
		).toBeUndefined();
		// An authority from before the definition was carried in it: a window
		// this DevHub did not write, not a container with a guessed definition.
		const legacy = Buffer.from(
			JSON.stringify({ hostPath: "/src/api" }),
		).toString("hex");
		expect(
			editorPlaceFromWorkspaceUri(
				uri({
					scheme: "vscode-remote",
					authority: `dev-container+${legacy}`,
					path: "/workspaces/api",
				}),
			),
		).toBeUndefined();
	});
});
