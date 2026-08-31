/**
 * Editing a TOML document in place.
 *
 * `config.toml` is a file a person writes and keeps: they group things their
 * way, leave comments explaining a choice, and expect to still recognise it
 * after DevHub has written to it. A save that re-serialises the whole document
 * destroys all of that — the file still means the same thing, but it is no
 * longer theirs.
 *
 * The Rust used `toml_edit`, which keeps the source and rewrites only the spans
 * that changed. This does the same, over a real TOML CST: parse the file, find
 * the exact source range of each value, and splice. Anything nobody edited —
 * comments, blank lines, key order, inline-vs-standard table style, alignment —
 * is never touched, because it is never re-rendered.
 *
 * The rules, in one place:
 *
 * - A value that is unchanged is left exactly as written, even if this module
 *   would have rendered it differently.
 * - A value that changed replaces only itself; its key, its spacing and its
 *   trailing comment stay.
 * - A key that is new is appended to the table it belongs to, after that
 *   table's last entry, so it lands under the heading a reader expects.
 * - A key that is gone takes its whole line with it, including a comment that
 *   is only about that line.
 * - Array-of-tables entries (`[[workspace_sources]]`, `[[agent_profiles]]`)
 *   are matched by their `id`, not their position: reordering the array in the
 *   UI does not rewrite unrelated blocks, and a removed entry takes its own
 *   block and nothing else.
 * - An array of tables has two spellings — a run of `[[key]]` blocks, or one
 *   inline `key = [ { … } ]` — and the document's own spelling wins. An empty
 *   array has no block spelling at all, so `key = []` is the empty marker
 *   rather than a choice of spelling: emptying an array removes every block
 *   *and* writes `key = []`, and refilling it takes the blocks back. The key
 *   is still written because `desired` says it is there, and a reader that
 *   tells an absent key from an empty one (DevHub's loader does — an absent
 *   `workspace_sources` means the defaults) would otherwise read back
 *   something nobody asked for. Writing one spelling without removing the
 *   other is how a document ends up defining the same key twice, which is not
 *   TOML at all.
 */

import { parseTOML, getStaticTOMLValue } from "toml-eslint-parser";
import type { AST } from "toml-eslint-parser";

export type TomlValue =
  | string
  | number
  | boolean
  | readonly TomlValue[]
  | { readonly [key: string]: TomlValue };

/** A document that could not be parsed at all. */
export class TomlSyntaxError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = "TomlSyntaxError";
  }
}

interface ParsedDocument {
  readonly ast: AST.TOMLProgram;
  readonly value: Record<string, unknown>;
}

function parse(source: string): ParsedDocument {
  let ast: AST.TOMLProgram;
  try {
    ast = parseTOML(source);
  } catch (error) {
    const location = error as { lineNumber?: number; column?: number };
    throw new TomlSyntaxError(
      error instanceof Error ? error.message : "invalid TOML",
      location.lineNumber,
      location.column,
    );
  }
  const value = getStaticTOMLValue(ast);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TomlSyntaxError("the document is not a table");
  }
  return { ast, value: value as Record<string, unknown> };
}

/** Read a document's values. The only parser in this codebase. */
export function parseTomlValue(source: string): Record<string, unknown> {
  return parse(source).value;
}

// ------------------------------------------------------------------ rendering

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function renderKey(key: string): string {
  return BARE_KEY.test(key) ? key : renderString(key);
}

function renderString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // Everything else below the printable range has no literal spelling, so a
    // basic string must escape it. The rule this suppresses exists to catch a
    // control character typed in by accident; here they are the subject.
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  return `"${escaped}"`;
}

function renderNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TomlSyntaxError("a non-finite number has no TOML spelling");
  }
  return Number.isInteger(value) ? String(value) : String(value);
}

/** One value, inline. Arrays and tables stay on one line, as the file had them. */
export function renderValue(value: TomlValue): string {
  if (typeof value === "string") return renderString(value);
  if (typeof value === "number") return renderNumber(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.length === 0
      ? "[]"
      : `[ ${value.map((item) => renderValue(item as TomlValue)).join(", ")} ]`;
  }
  const entries = Object.entries(value as Record<string, TomlValue>);
  return entries.length === 0
    ? "{}"
    : `{ ${entries
        .map(([key, item]) => `${renderKey(key)} = ${renderValue(item)}`)
        .join(", ")} }`;
}

function isTable(value: unknown): value is Record<string, TomlValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * Whether a value belongs in its own `[table]` rather than on one line.
 *
 * A table of scalars is a table; a table of tables is a table. An array is a
 * value either way — DevHub's arrays are short lists of strings, and the file
 * reads better with them inline, which is also how the defaults are written.
 */
function needsTableBlock(value: TomlValue): value is Record<string, TomlValue> {
  return isTable(value) && Object.keys(value).length > 0;
}

/** A whole `[path]` block, for a table the document does not have yet. */
function renderTableBlock(path: readonly string[], value: TomlValue): string {
  const heading = `[${path.map(renderKey).join(".")}]`;
  const lines: string[] = [heading];
  const nested: string[] = [];
  for (const [key, entry] of Object.entries(
    value as Record<string, TomlValue>,
  )) {
    if (needsTableBlock(entry)) {
      nested.push(renderTableBlock([...path, key], entry));
    } else {
      lines.push(`${renderKey(key)} = ${renderValue(entry)}`);
    }
  }
  return [lines.join("\n"), ...nested].join("\n\n");
}

/** One `[[path]]` element. */
function renderArrayTableBlock(
  path: readonly string[],
  value: TomlValue,
): string {
  const heading = `[[${path.map(renderKey).join(".")}]]`;
  const lines: string[] = [heading];
  const nested: string[] = [];
  for (const [key, entry] of Object.entries(
    value as Record<string, TomlValue>,
  )) {
    if (needsTableBlock(entry)) {
      nested.push(renderTableBlock([...path, key], entry));
    } else {
      lines.push(`${renderKey(key)} = ${renderValue(entry)}`);
    }
  }
  return [lines.join("\n"), ...nested].join("\n\n");
}

/** A whole document, for when there is no file to preserve. */
export function renderTomlDocument(value: Record<string, TomlValue>): string {
  const scalars: string[] = [];
  const blocks: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (
      Array.isArray(entry) &&
      entry.length > 0 &&
      entry.every((item) => needsTableBlock(item as TomlValue))
    ) {
      for (const item of entry) {
        blocks.push(renderArrayTableBlock([key], item as TomlValue));
      }
    } else if (needsTableBlock(entry)) {
      blocks.push(renderTableBlock([key], entry));
    } else {
      scalars.push(`${renderKey(key)} = ${renderValue(entry)}`);
    }
  }
  const parts = [scalars.join("\n"), ...blocks].filter(
    (part) => part.length > 0,
  );
  return `${parts.join("\n\n")}\n`;
}

// --------------------------------------------------------------------- editing

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function keyPath(key: AST.TOMLKey): string[] {
  return key.keys.map((part) =>
    part.type === "TOMLBare" ? part.name : String(part.value),
  );
}

/** Every table body in the document, by the path it resolves to. */
interface TableEntry {
  readonly path: readonly (string | number)[];
  readonly node: AST.TOMLTable;
}

function tables(ast: AST.TOMLProgram): TableEntry[] {
  const found: TableEntry[] = [];
  for (const node of ast.body[0].body) {
    if (node.type === "TOMLTable") {
      found.push({ path: node.resolvedKey, node });
    }
  }
  return found;
}

function samePath(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}

/**
 * The line a key-value pair occupies, including its newline and any comment
 * that sits after it on that line — deleting the pair must not leave the
 * comment behind explaining a key that is gone.
 */
function lineSpan(
  source: string,
  node: AST.TOMLKeyValue,
): { start: number; end: number } {
  let start = node.range[0];
  while (start > 0 && source[start - 1] !== "\n") {
    start -= 1;
  }
  let end = node.range[1];
  while (end < source.length && source[end] !== "\n") {
    end += 1;
  }
  return { start, end: Math.min(source.length, end + 1) };
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => valuesEqual(item, right[index]))
    );
  }
  if (isTable(left) && isTable(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) =>
        valuesEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
      )
    );
  }
  return left === right;
}

interface TableEdit {
  /** Where a new key would be appended: after this table's last entry. */
  readonly insertAt: number;
  readonly indent: string;
}

function insertionPoint(source: string, table: AST.TOMLTable): TableEdit {
  const last = table.body.at(-1);
  if (!last) {
    // An empty table: straight after its heading line.
    let end = table.range[0];
    while (end < source.length && source[end] !== "\n") end += 1;
    return { insertAt: Math.min(source.length, end + 1), indent: "" };
  }
  const span = lineSpan(source, last);
  const line = source.slice(span.start, span.end);
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  return { insertAt: span.end, indent };
}

/**
 * Rewrite `source` so it expresses `desired`, changing as little as possible.
 *
 * Anything the two agree about is not touched at all — not re-rendered, not
 * reordered, not reindented — which is what keeps a hand-written config
 * recognisable after a save.
 */
export function updateTomlDocument(
  source: string,
  desired: Record<string, TomlValue>,
): string {
  const { ast, value: current } = parse(source);
  const edits: Edit[] = [];
  const appended: string[] = [];
  const allTables = tables(ast);

  const tableAt = (
    path: readonly (string | number)[],
  ): AST.TOMLTable | undefined =>
    allTables.find((entry) => samePath(entry.path, path))?.node;

  /** The `[[path]]` blocks the document already has, in document order. */
  const arrayTableBlocks = (
    path: readonly (string | number)[],
  ): readonly TableEntry[] =>
    allTables.filter(
      (entry) =>
        entry.node.kind === "array" &&
        entry.path.length === path.length + 1 &&
        samePath(entry.path.slice(0, -1), path),
    );

  /**
   * A block's own span plus the sub-tables written inside it.
   *
   * `[agent_profiles.env]` belongs to the `[[agent_profiles]]` block above it.
   * Removing the block without it leaves a heading whose parent is gone, and
   * the document stops parsing — the same class of failure as leaving the
   * block behind, just spelled differently.
   */
  const blockWithChildrenSpan = (
    entry: TableEntry,
  ): { start: number; end: number } => {
    let last = entry;
    for (
      let next = allTables.indexOf(entry) + 1;
      next < allTables.length;
      next += 1
    ) {
      const candidate = allTables[next];
      if (candidate.path.length <= entry.path.length) break;
      if (!samePath(candidate.path.slice(0, entry.path.length), entry.path)) {
        break;
      }
      last = candidate;
    }
    return {
      start: blockSpan(source, entry.node).start,
      end: blockSpan(source, last.node).end,
    };
  };

  /**
   * Whether this key is an array of tables at all.
   *
   * With entries the value answers: every element is a table. Empty, the value
   * cannot answer, so the document does — `[[key]]` blocks mean this is that
   * array being emptied. With neither, it is an ordinary empty array, and
   * `key = []` is the whole of it either way.
   */
  const isArrayOfTables = (
    path: readonly (string | number)[],
    wanted: readonly unknown[],
  ): boolean =>
    wanted.length > 0
      ? wanted.every((item) => needsTableBlock(item as TomlValue))
      : arrayTableBlocks(path).length > 0;

  /**
   * Reconcile one table's worth of keys.
   *
   * `body` is where the pairs live (the top-level body, or a table's), `path`
   * is what that table is called, and `existing`/`target` are the two versions
   * of its contents.
   */
  const reconcile = (
    path: readonly (string | number)[],
    body: readonly (AST.TOMLTopLevelTable["body"][number] | AST.TOMLKeyValue)[],
    container: AST.TOMLTable | undefined,
    existing: Record<string, unknown>,
    target: Record<string, TomlValue>,
  ): void => {
    const pairs = new Map<string, AST.TOMLKeyValue>();
    for (const node of body) {
      if (node.type === "TOMLKeyValue") {
        const parts = keyPath(node.key);
        // A dotted key is one entry under its first segment, which is the only
        // level this needs to address.
        pairs.set(parts.join("."), node);
      }
    }

    const newKeys: [string, TomlValue][] = [];

    for (const [key, wanted] of Object.entries(target)) {
      const childPath = [...path, key];

      if (Array.isArray(wanted) && isArrayOfTables(childPath, wanted)) {
        // The document's own spelling wins — but only while it has entries to
        // spell. An inline `key = []` is the empty marker, not a claim on the
        // inline spelling, so refilling the array goes back to blocks.
        const inline = pairs.get(key);
        const spelledInline =
          inline !== undefined &&
          Array.isArray(existing[key]) &&
          (existing[key] as readonly unknown[]).length > 0;
        if (spelledInline) {
          if (!valuesEqual(existing[key], wanted)) {
            edits.push({
              start: inline.value.range[0],
              end: inline.value.range[1],
              text: renderValue(wanted),
            });
          }
          continue;
        }
        reconcileArrayOfTables(
          childPath,
          existing,
          key,
          wanted as readonly Record<string, TomlValue>[],
        );
        // Exactly one of the two spellings survives: blocks when there is
        // anything to put in them, `key = []` when there is not.
        if (wanted.length === 0) {
          if (!inline) newKeys.push([key, wanted]);
        } else if (inline) {
          const span = lineSpan(source, inline);
          edits.push({ start: span.start, end: span.end, text: "" });
        }
        continue;
      }

      if (isTable(wanted)) {
        // The document's own spelling wins, and a table has one either way it
        // is written — `[path]` with no keys under it is an empty table, not an
        // absent one. Asking `wanted` how to spell it would write a second
        // definition of a key the document already defines.
        const child = tableAt(childPath);
        if (child) {
          reconcile(
            childPath,
            child.body,
            child,
            (existing[key] ?? {}) as Record<string, unknown>,
            wanted,
          );
          continue;
        }
        const inline = pairs.get(key);
        if (inline) {
          // The file wrote it as an inline table; keep it inline.
          if (!valuesEqual(existing[key], wanted)) {
            edits.push({
              start: inline.value.range[0],
              end: inline.value.range[1],
              text: renderValue(wanted),
            });
          }
          continue;
        }
        // Neither spelling is in the document, so this picks one: a table with
        // contents earns its own block, an empty one reads better as `key = {}`
        // than as a heading with nothing under it.
        if (needsTableBlock(wanted)) {
          appended.push(renderTableBlock(childPath.map(String), wanted));
        } else {
          newKeys.push([key, wanted]);
        }
        continue;
      }

      const pair = pairs.get(key);
      if (!pair) {
        newKeys.push([key, wanted]);
        continue;
      }
      if (!valuesEqual(existing[key], wanted)) {
        edits.push({
          start: pair.value.range[0],
          end: pair.value.range[1],
          text: renderValue(wanted),
        });
      }
    }

    for (const [key, node] of pairs) {
      if (!(key in target)) {
        const span = lineSpan(source, node);
        edits.push({ start: span.start, end: span.end, text: "" });
      }
    }

    if (newKeys.length > 0) {
      const point = container
        ? insertionPoint(source, container)
        : topLevelInsertionPoint(source, ast);
      const text = newKeys
        .map(
          ([key, item]) =>
            `${point.indent}${renderKey(key)} = ${renderValue(item)}\n`,
        )
        .join("");
      edits.push({ start: point.insertAt, end: point.insertAt, text });
    }
  };

  const reconcileArrayOfTables = (
    path: readonly (string | number)[],
    existing: Record<string, unknown>,
    key: string,
    wanted: readonly Record<string, TomlValue>[],
  ): void => {
    const name = path.map(String);
    const blocks = arrayTableBlocks(path);
    const existingArray = Array.isArray(existing[key])
      ? (existing[key] as Record<string, unknown>[])
      : [];

    // Blocks are matched by their own `id`, not by position: the array can be
    // reordered in the UI without rewriting blocks whose contents did not move.
    const byId = new Map<
      string,
      { node: AST.TOMLTable; value: Record<string, unknown> }
    >();
    blocks.forEach((entry, index) => {
      const value = existingArray[index] ?? {};
      const id = typeof value["id"] === "string" ? value["id"] : undefined;
      if (id !== undefined) byId.set(id, { node: entry.node, value });
    });

    const kept = new Set<AST.TOMLTable>();
    for (const item of wanted) {
      const id = typeof item["id"] === "string" ? item["id"] : undefined;
      const match = id === undefined ? undefined : byId.get(id);
      if (!match) {
        appended.push(renderArrayTableBlock(name, item));
        continue;
      }
      kept.add(match.node);
      reconcile(
        [...path, blocks.findIndex((entry) => entry.node === match.node)],
        match.node.body,
        match.node,
        match.value,
        item,
      );
    }

    // Every block the desired array did not claim goes, whether it had an `id`
    // to be matched by or not: a block left behind is an entry that comes back
    // on the next read.
    for (const entry of blocks) {
      if (kept.has(entry.node)) continue;
      const span = blockWithChildrenSpan(entry);
      edits.push({ start: span.start, end: span.end, text: "" });
    }
  };

  reconcile([], ast.body[0].body, undefined, current, desired);

  // Back to front, so an earlier edit cannot move a later one's range.
  edits.sort((left, right) => right.start - left.start);
  let output = source;
  for (const edit of edits) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }

  if (appended.length > 0) {
    const separator = output.endsWith("\n") ? "" : "\n";
    output = `${output}${separator}\n${appended.join("\n\n")}\n`;
  }

  return output.endsWith("\n") ? output : `${output}\n`;
}

/** A whole `[table]` or `[[table]]` block, heading line included. */
function blockSpan(
  source: string,
  table: AST.TOMLTable,
): { start: number; end: number } {
  let start = table.range[0];
  while (start > 0 && source[start - 1] !== "\n") start -= 1;
  let end = table.range[1];
  while (end < source.length && source[end] !== "\n") end += 1;
  end = Math.min(source.length, end + 1);
  // Take the blank line that separated it from the next block, so removing a
  // block does not leave a widening gap behind.
  while (end < source.length && source[end] === "\n") end += 1;
  return { start, end };
}

/** Where a new top-level key goes: after the last one, before any table. */
function topLevelInsertionPoint(
  source: string,
  ast: AST.TOMLProgram,
): TableEdit {
  let insertAt = 0;
  for (const node of ast.body[0].body) {
    if (node.type !== "TOMLKeyValue") break;
    insertAt = lineSpan(source, node).end;
  }
  return { insertAt, indent: "" };
}
