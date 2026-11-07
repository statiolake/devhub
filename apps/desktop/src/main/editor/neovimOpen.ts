/**
 * A file DevHub is asked to open (`devhub <file>`, a conversation's file
 * link, Send to Agent's reference), as the Neovim editor's open: the one
 * place an open is branched on `general.editor` is `AppController.openInEditor`,
 * and this is the Neovim half of what it hands on.
 */

import type { ResolvedPath } from "../cli/canonical.js";
import type { FileSelection } from "../cli/openFiles.js";
import type { NeovimOpen } from "./managedNeovim.js";
import type { EditorKind } from "../../model/config.js";

/** The editor an open goes to, for the setting DevHub runs on. */
export function editorForOpen(setting: EditorKind): "workbench" | "neovim" {
	return setting === "neovim" ? "neovim" : "workbench";
}

/**
 * A selection with an end puts the cursor at its start (Neovim has no
 * selection to be handed); a position with no column is the line's start.
 */
export function neovimOpenOf(
	file: ResolvedPath,
	position: FileSelection | undefined,
	waitMarkerPath: string | undefined,
): NeovimOpen {
	return {
		path: file.path,
		...(position === undefined
			? {}
			: { line: position.line, column: position.column }),
		...(waitMarkerPath === undefined ? {} : { waitMarkerPath }),
	};
}
