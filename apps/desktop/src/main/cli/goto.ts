/**
 * `FILE:LINE[:COLUMN]`, the way `code --goto` reads it.
 *
 * The split is upstream's (`parseLineAndColumnAware` in
 * `vs/base/common/extpath.ts`) and it is copied rather than imported because
 * the `devhub` command is a socket client that imports nothing from VS Code —
 * see `devhubCli.ts`. Copying a rule means keeping it identical, so the loop
 * below is deliberately the same one: split on `:`, and every segment that is
 * not a number is part of the path, because a path may well contain a colon.
 *
 * What is added is a check upstream does not make: a line has to be a whole
 * number from 1 up. `file.txt:` and `file.txt:2.5` both parse into a position
 * upstream, and both then ask the editor to put the cursor somewhere that does
 * not exist. Saying so here is the difference between a command that reports a
 * typo and one that opens a file with the cursor mysteriously at the top.
 *
 * A spec with no line at all is just a path. That is `code`'s behaviour too:
 * `--goto` without a position opens the file and leaves the cursor alone.
 */

/** Where the cursor goes. One-based, as every editor counts. */
export interface FilePosition {
	readonly line: number;
	readonly column: number;
}

export interface FileAndPosition {
	readonly path: string;
	readonly position: FilePosition | undefined;
}

const FORMAT =
	"the format for --goto is FILE:LINE(:COLUMN), for example src/main.ts:42:7.";

export function parseFileAndPosition(spec: string): FileAndPosition {
	let path: string | undefined;
	let line: number | undefined;
	let column: number | undefined;

	for (const segment of spec.split(":")) {
		const asNumber = Number(segment);
		if (!Number.isFinite(asNumber)) {
			path = path === undefined ? segment : `${path}:${segment}`;
		} else if (line === undefined) {
			line = asNumber;
		} else if (column === undefined) {
			column = asNumber;
		}
	}

	if (path === undefined || path.length === 0) {
		throw new Error(FORMAT);
	}
	if (line === undefined) return { path, position: undefined };
	if (!isPositive(line) || (column !== undefined && !isPositive(column))) {
		throw new Error(FORMAT);
	}
	// A line without a column means the start of the line, which is column 1.
	return { path, position: { line, column: column ?? 1 } };
}

function isPositive(value: number): boolean {
	return Number.isInteger(value) && value >= 1;
}
