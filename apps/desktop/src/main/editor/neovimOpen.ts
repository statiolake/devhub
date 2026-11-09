/**
 * A file DevHub is asked to open (`devhub <file>`, a conversation's file
 * link), as the Neovim editor's open: what
 * `AppController.openInEditor` hands on.
 */

import type { ResolvedPath } from "../cli/canonical.js";
import type { FileSelection } from "../cli/fileSelection.js";
import type { NeovimOpen } from "./managedNeovim.js";

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
