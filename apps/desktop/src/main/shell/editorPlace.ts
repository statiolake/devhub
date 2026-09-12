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
 * Scratch — so an SSH Workspace's window would have been handed the Scratch
 * workbench.
 *
 * Nothing here touches VS Code: it works on the four fields of a URI, so it is
 * a rule about strings and is tested as one.
 */

import {
	workspaceLocation,
	type WorkspaceLocation,
} from "../../model/domain.js";

/**
 * The authority prefix Open Remote - SSH registers.
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

/**
 * The place a window's folder URI names, or nothing when it names none DevHub
 * can hold a Workspace for.
 *
 * `undefined` is not an error: a window with no folder, or one on an authority
 * some other resolver owns, is a window DevHub did not open for a Workspace,
 * and the caller has its own answer for that.
 */
export function locationFromWorkspaceUri(
	uri: WorkspaceUriParts,
): WorkspaceLocation | undefined {
	if (uri.scheme === "file") {
		return tryLocation({ kind: "local", path: uri.fsPath });
	}
	if (uri.scheme !== "vscode-remote") return undefined;
	if (!uri.authority.startsWith(SSH_REMOTE_PREFIX)) return undefined;
	return tryLocation({
		kind: "ssh",
		host: uri.authority.slice(SSH_REMOTE_PREFIX.length),
		path: uri.path,
	});
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

/**
 * The Scratch editor's key.
 *
 * Empty, because Scratch has no folder and never had one; `locationKey` starts
 * every real key with `/` or `ssh://`, so nothing can collide with it.
 */
export const SCRATCH_EDITOR_KEY = "";
