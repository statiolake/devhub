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
 */

import { CancellationToken } from "code-oss-dev/out/vs/base/common/cancellation.js";
import { URI } from "code-oss-dev/out/vs/base/common/uri.js";
import { FileType } from "code-oss-dev/out/vs/platform/files/common/files.js";
import type { ICodeWindow } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import type { ResolvedPath } from "./canonical.js";
import type { ControlPosition } from "./protocol.js";

/** Ask a running workbench to open one file, optionally at a position. */
export function openFileInWorkbench(
	window: ICodeWindow,
	file: ResolvedPath,
	position: ControlPosition | undefined,
): void {
	window.sendWhenReady("vscode:openFiles", CancellationToken.None, {
		filesToOpenOrCreate: [
			{
				fileUri: URI.file(file.path),
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
	});
}
