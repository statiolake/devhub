/**
 * Opening a file inside a workbench that is already running.
 *
 * This is VS Code's own mechanism, used the way VS Code uses it: the ready
 * message `vscode:openFiles`, which `WindowsMainService.doOpenFilesInExistingWindow`
 * sends and `vs/workbench/electron-browser/window.ts` handles by turning each
 * path into an editor input. `sendWhenReady` is part of the public `ICodeWindow`
 * interface, so a workbench that is still starting gets the message when it is
 * ready rather than dropping it.
 *
 * What is deliberately *not* used is `IWindowsMainService.open({ urisToOpen: [{ fileUri }] })`.
 * Upstream picks the target window for a bare file with `findWindowOnFile`
 * followed by "the last active window" — and the last active window is exactly
 * the rule DevHub rejects. DevHub decides the target from the path alone (see
 * `resolve.ts`) and then addresses that window directly.
 *
 * Files that do not exist follow `code`: it stats the path, treats `ENOENT` as
 * `exists: false` (`ignoreFileNotFound` on the CLI path in
 * `windowsMainService.ts`), and the workbench opens an untitled editor bound to
 * that resource — so `devhub notes.md` in an open workspace gives you an empty
 * editor that saves to `notes.md`, exactly as `code notes.md` does.
 *
 * A `--goto` position rides along as `options.selection`, which is the same
 * field upstream fills in `windowsMainService.ts` when `code -g file:10:2` is
 * parsed in `gotoLineMode`. `pathsToEditors` copies `options` onto the editor
 * input unchanged, so a caret placed here is the caret `code` would place.
 *
 * The one thing that *is* a branch here is which machine the path is on, and
 * it is a branch about the URI rather than about the window. A path on this
 * Mac is `file:`, in every window, remote authority or not — see
 * `openFiles.test.ts` for why that is upstream's behaviour and not a hope. A
 * path on a host is `vscode-remote://<authority>/<path>`, because there is no
 * other way to name it: `file:` in a remote window means *this* disk.
 *
 * That applies to the wait marker as much as to the file, and the marker is
 * where being wrong has no symptom. A remote marker sent as `file:` is deleted
 * on this Mac, while the CLI on the host polls a file nothing will ever
 * remove — `git commit` over there hangs forever after the tab is closed, with
 * no error anywhere.
 */

import { CancellationToken } from "code-oss-dev/out/vs/base/common/cancellation.js";
import { URI } from "code-oss-dev/out/vs/base/common/uri.js";
import { FileType } from "code-oss-dev/out/vs/platform/files/common/files.js";
import type { ICodeWindow } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import { remoteAuthorityForMachine } from "../runtime/registry.js";
import type { RuntimeId } from "../runtime/runtime.js";
import type { ResolvedPath } from "./canonical.js";
import type { ControlPosition } from "./protocol.js";

/**
 * Ask a running workbench to open one file, optionally at a position, and
 * optionally holding a `--wait` marker open until it is closed again.
 *
 * `filesToWait` is upstream's field and upstream's behaviour: `onOpenFiles`
 * watches the editors it just opened and deletes the marker when they close —
 * or deletes it immediately if none of them opened, so a file that cannot be
 * opened ends the CLI's wait instead of hanging it forever. DevHub adds
 * nothing to that; it only says which file, and where the marker is.
 */
export function openFileInWorkbench(
	window: ICodeWindow,
	machine: RuntimeId,
	file: ResolvedPath,
	position: ControlPosition | undefined,
	waitMarkerPath: string | undefined,
): void {
	const fileUri = workbenchUri(machine, file.path);
	window.sendWhenReady("vscode:openFiles", CancellationToken.None, {
		filesToOpenOrCreate: [
			{
				fileUri,
				exists: file.exists,
				type: FileType.File,
				// Omitted rather than `undefined` when there is no position, so
				// that a plain `devhub <file>` sends byte for byte what it sent
				// before `--goto` existed.
				...(position === undefined
					? {}
					: {
							options: {
								selection: {
									startLineNumber: position.line,
									startColumn: position.column,
								},
							},
						}),
			},
		],
		// Omitted for the same reason, so that an open without `--wait` is the
		// message it has always been.
		...(waitMarkerPath === undefined
			? {}
			: {
					filesToWait: {
						paths: [{ fileUri }],
						// The same machine as the file, because it is a path the
						// same `devhub` made, in the same place.
						waitMarkerFileUri: workbenchUri(machine, waitMarkerPath),
					},
				}),
	});
}

/**
 * How a workbench names a path on a machine.
 *
 * One function for both kinds, so the URI the file is opened with and the URI
 * its wait marker is deleted by cannot come to disagree — which is the whole
 * of the failure this exists to prevent.
 */
function workbenchUri(machine: RuntimeId, path: string): URI {
	const authority = remoteAuthorityForMachine(machine);
	return authority === undefined
		? URI.file(path)
		: URI.from({ scheme: "vscode-remote", authority, path });
}
