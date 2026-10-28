/**
 * A ```diff / ```patch block, or a .diff / .patch file, read as the change it
 * describes: which files, and each file's lines on the side they belong to.
 *
 * Three shapes are read: what `git diff` writes (`diff --git`, `index`,
 * `new file mode`, `rename from/to`, `---`/`+++`, hunks), what `diff -u`
 * writes (`---`/`+++`, hunks), and bare hunks with no file named. Anything
 * before the first file — a mail's words, `git format-patch`'s header — is
 * not a change and is left out of the drawing (it stays in the source).
 */

import { diffRows, type DiffRow } from "./EntryParts";

export type PatchStatus = "modified" | "added" | "deleted" | "renamed";

export interface PatchFile {
  /** The file's path after the change; before it, for a deleted file. */
  readonly path: string;
  /** Its path before, when the change renamed it. */
  readonly from: string | undefined;
  readonly status: PatchStatus;
  /** The hunks, as unified diff lines (`@@`, ` `, `-`, `+`). */
  readonly hunks: string;
  /** `Binary files … differ`: a change with no lines to show. */
  readonly binary: boolean;
}

/** Whether `text` has a change in it to draw: a hunk, or a changed line. */
export function isPatch(text: string): boolean {
  return (
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/mu.test(text) ||
    (/^--- \S/mu.test(text) && /^\+\+\+ \S/mu.test(text)) ||
    /^diff --git /mu.test(text)
  );
}

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` → undefined. */
function pathOf(spec: string): string | undefined {
  let path = spec.replace(/\t.*$/u, "").trim();
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (path === "/dev/null") return undefined;
  return /^[ab]\//u.test(path) ? path.slice(2) : path;
}

interface Draft {
  oldPath: string | undefined;
  newPath: string | undefined;
  status: PatchStatus;
  from: string | undefined;
  lines: string[];
  binary: boolean;
}

const blank = (): Draft => ({
  oldPath: undefined,
  newPath: undefined,
  status: "modified",
  from: undefined,
  lines: [],
  binary: false,
});

function finish(draft: Draft): PatchFile | undefined {
  if (draft.lines.length === 0 && !draft.binary && draft.from === undefined)
    return undefined;
  const status: PatchStatus =
    draft.status !== "modified"
      ? draft.status
      : draft.oldPath === undefined && draft.newPath !== undefined
        ? "added"
        : draft.newPath === undefined && draft.oldPath !== undefined
          ? "deleted"
          : draft.oldPath !== draft.newPath &&
              draft.oldPath !== undefined &&
              draft.newPath !== undefined
            ? "renamed"
            : "modified";
  const path = draft.newPath ?? draft.oldPath ?? "";
  return {
    path,
    from: status === "renamed" ? (draft.from ?? draft.oldPath) : undefined,
    status,
    hunks: draft.lines.join("\n"),
    binary: draft.binary,
  };
}

/** The files a patch changes, in order. */
export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let draft: Draft | undefined;
  let inHunk = false;
  const close = () => {
    if (draft !== undefined) {
      const file = finish(draft);
      if (file !== undefined) files.push(file);
    }
    draft = undefined;
    inHunk = false;
  };
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    const git = /^diff --git (\S+) (\S+)/u.exec(line);
    if (git !== null) {
      close();
      draft = blank();
      draft.oldPath = pathOf(git[1]!);
      draft.newPath = pathOf(git[2]!);
      continue;
    }
    // `--- a` followed by `+++ b` starts a file (a second one in a `diff -u`
    // stream, or the names of a `diff --git` one); inside a hunk a `---`
    // line is a removed `--`, unless the hunk's counts say it has ended.
    if (
      line.startsWith("--- ") &&
      lines[at + 1]?.startsWith("+++ ") === true &&
      (!inHunk || lines[at + 2]?.startsWith("@@") === true)
    ) {
      if (draft === undefined || draft.lines.length > 0) {
        close();
        draft = blank();
      }
      draft.oldPath = pathOf(line.slice(4));
      draft.newPath = pathOf(lines[at + 1]!.slice(4));
      at += 1;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      draft ??= blank();
      inHunk = true;
      draft.lines.push(line);
      continue;
    }
    if (draft === undefined) continue;
    if (inHunk && /^[ +\-\\]/u.test(line)) {
      draft.lines.push(line);
      continue;
    }
    if (inHunk && line === "") {
      // A blank context line whose space an editor took away.
      draft.lines.push(" ");
      continue;
    }
    inHunk = false;
    if (line.startsWith("new file mode")) draft.status = "added";
    else if (line.startsWith("deleted file mode")) draft.status = "deleted";
    else if (line.startsWith("rename from ")) {
      draft.status = "renamed";
      draft.from = line.slice("rename from ".length);
    } else if (line.startsWith("rename to "))
      draft.newPath = line.slice("rename to ".length);
    else if (/^Binary files .* differ$/u.test(line)) draft.binary = true;
  }
  close();
  // Trailing blank context an editor added after the last hunk.
  return files.map((file) => ({
    ...file,
    hunks: file.hunks.replace(/(?:\n )+$/u, ""),
  }));
}

/** One line of a file's change, with where it is in the side text it was coloured in. */
export interface PatchRow extends DiffRow {
  /** Its line in the old side's text (context and removed lines). */
  readonly oldAt: number | undefined;
  /** Its line in the new side's text (context and added lines). */
  readonly newAt: number | undefined;
}

/**
 * A file's rows, and the two texts its lines make on each side — the file
 * before and after, in the stretches the hunks show — so that each side can
 * be coloured as code of the file's language and its rows take their colours
 * from it.
 */
export function patchSides(hunks: string): {
  readonly rows: readonly PatchRow[];
  readonly oldText: string;
  readonly newText: string;
} {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const rows = diffRows(hunks).map((row): PatchRow => {
    const body = row.text.slice(1);
    let oldAt: number | undefined;
    let newAt: number | undefined;
    if (row.kind === "context" && !row.text.startsWith("\\")) {
      oldAt = oldLines.push(body) - 1;
      newAt = newLines.push(body) - 1;
    } else if (row.kind === "remove") {
      oldAt = oldLines.push(body) - 1;
    } else if (row.kind === "add") {
      newAt = newLines.push(body) - 1;
    }
    return { ...row, oldAt, newAt };
  });
  return { rows, oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

/** One row of the side-by-side view: the old line on the left, the new on the right. */
export interface SplitRow {
  readonly hunk?: string;
  readonly left?: PatchRow;
  readonly right?: PatchRow;
}

/**
 * Rows side by side: context on both sides, and each run of removed lines
 * beside the run of added lines that follows it, line for line, the longer
 * run's rest against nothing.
 */
export function splitRows(rows: readonly PatchRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let removed: PatchRow[] = [];
  let added: PatchRow[] = [];
  const flush = () => {
    for (let at = 0; at < Math.max(removed.length, added.length); at++) {
      out.push({ left: removed[at], right: added[at] });
    }
    removed = [];
    added = [];
  };
  for (const row of rows) {
    if (row.kind === "remove") {
      if (added.length > 0) flush();
      removed.push(row);
    } else if (row.kind === "add") added.push(row);
    else {
      flush();
      if (row.kind === "hunk") out.push({ hunk: row.text });
      else out.push({ left: row, right: row });
    }
  }
  flush();
  return out;
}
