/**
 * Where an editor puts the caret when a file is opened into it.
 */

import type { ControlPosition } from "./protocol.js";

/**
 * Where the editor puts the caret — or, with an `end`, which text it selects.
 * A position is a selection without an end, so `--goto`'s is one as it is.
 * An `end` column past its line's end is the line's end: the editor clamps a
 * selection to its text.
 */
export interface FileSelection extends ControlPosition {
	readonly end?: ControlPosition;
}
