/**
 * Which place a workbench window is showing, in the one vocabulary both sides
 * of the seam speak.
 *
 * DevHub asks VS Code to open a folder and VS Code asks DevHub, through the
 * `openInBrowserWindow` override, whether that folder already has a view. Those
 * two are the same question and must have the same answer, so the URI a window
 * carries and the `WorkspaceLocation` a Workspace carries have to translate
 * into each other exactly once — here.
 *
 * They used to translate by not translating: the folder was a local path on
 * both sides, `URI.file` one way and `uri.fsPath` the other, and a window whose
 * folder was on another machine had no path at all. `vscode-remote://` URIs
 * would have fallen through as "no folder", which is DevHub's signal for
 * "somewhere to scribble" — so an SSH Workspace's window would have been
 * handed Scratch's workbench.
 *
 * Nothing here touches VS Code: it works on the four fields of a URI, so it is
 * a rule about strings and is tested as one.
 */

import {
	decodeContainerAuthority,
	DEV_CONTAINER_PREFIX,
	EDITOR_ON_HOST,
	workspaceLocation,
	type EditorAttachment,
	type WorkspaceLocation,
} from "../../model/domain.js";

/**
 * The authority prefix DevHub's resolver registers for hosts.
 *
 * Its `package.json` says so twice — `onResolveRemoteAuthority:ssh-remote` and
 * the `ssh-remote+*` resource label formatter — and `remoteAuthorityOf`
 * composes the other half. If this and that disagree, the window opens on an
 * authority nobody resolves and hangs on "Opening Remote…".
 */
export const SSH_REMOTE_PREFIX = "ssh-remote+";

/** As much of a `URI` as the rule needs. */
export interface WorkspaceUriParts {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	/** Only meaningful for `file:`, and only read for `file:`. */
	readonly fsPath: string;
}

/** A window's place: which Workspace, and where its editor is attached. */
export interface EditorPlace {
	readonly location: WorkspaceLocation;
	readonly editor: EditorAttachment;
}

/**
 * The place a window's folder URI names, or nothing when it names none DevHub
 * can hold a Workspace for.
 *
 * `undefined` is not an error: a window with no folder, or one on an authority
 * some other resolver owns, is a window DevHub did not open for a Workspace,
 * and the caller has its own answer for that.
 *
 * A window on a dev container names the Workspace's own folder — the one on
 * this Mac or on the host — and not the path it is mounted at inside: the
 * authority carries the folder and the definition, and the URI's path is only
 * where the workbench opened it. So a Workspace's window has the same
 * `locationKey` whichever way its editor is attached, which is what lets a
 * reattached editor land in the same slot.
 */
export function editorPlaceFromWorkspaceUri(
	uri: WorkspaceUriParts,
): EditorPlace | undefined {
	if (uri.scheme === "file") {
		return onHost(tryLocation({ kind: "local", path: uri.fsPath }));
	}
	if (uri.scheme !== "vscode-remote") return undefined;
	if (uri.authority.startsWith(SSH_REMOTE_PREFIX)) {
		return onHost(
			tryLocation({
				kind: "ssh",
				host: uri.authority.slice(SSH_REMOTE_PREFIX.length),
				path: uri.path,
			}),
		);
	}
	if (uri.authority.startsWith(DEV_CONTAINER_PREFIX)) {
		const target = decodeContainerAuthority(
			uri.authority.slice(DEV_CONTAINER_PREFIX.length),
		);
		if (target === undefined) return undefined;
		return {
			location: target.location,
			editor: { kind: "devContainer", configPath: target.configPath },
		};
	}
	return undefined;
}

function onHost(
	location: WorkspaceLocation | undefined,
): EditorPlace | undefined {
	return location === undefined
		? undefined
		: { location, editor: EDITOR_ON_HOST };
}

/**
 * A URI that came from VS Code is not a value DevHub validated, so a host or a
 * path this build refuses is "no place DevHub knows", not a crash in the middle
 * of opening somebody's window.
 */
function tryLocation(
	requested: Parameters<typeof workspaceLocation>[0],
): WorkspaceLocation | undefined {
	try {
		return workspaceLocation(requested);
	} catch {
		return undefined;
	}
}
