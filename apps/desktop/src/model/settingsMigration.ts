/**
 * The one-time fold of `settings.local.toml` back into `settings.toml`.
 *
 * DevHub used to read two files: `settings.toml`, shared through a dotfiles
 * repository and never written here, and `settings.local.toml` beside it,
 * this machine's half and the only one a save touched. The dotfiles side now
 * *generates* `settings.toml` as an ordinary file rather than symlinking one
 * in, so the reason for the second file is gone — there is one file, DevHub
 * reads it and DevHub writes it.
 *
 * What is left is the machines that still have the second file. On the first
 * start after the change their local answers are folded into `settings.toml`
 * with exactly the rule that used to combine them at read time:
 *
 * - Tables merge key by key, all the way down.
 * - Everything else — scalars, arrays, arrays of tables — local replaces whole.
 *
 * Tables merge because that is what the split was for: `[appearance]` could
 * live in the shared file while this machine overrode nothing but
 * `terminal_font_family`. Arrays replace because there is no honest answer to
 * what merging two lists means — position and identity disagree, and neither
 * can express "drop the third one" — so the list a file wrote is the list it
 * got. Folding with any other rule would silently change what the machine has
 * been running on.
 *
 * The merge is over raw TOML tables — what the files literally say, before
 * `config.ts` fills in any defaults. That ordering is the whole reason this is
 * a separate module: a default is indistinguishable from a value once it has
 * been filled in, so merging two finished `Config`s would let a default the
 * local file never mentioned quietly beat a real value the shared file gave.
 *
 * The old file is renamed, not deleted. It is the person's data, and a rename
 * is also what makes the migration happen once: the second start finds
 * nothing at `settings.local.toml` and does nothing.
 */

import { readFile, rename } from "node:fs/promises";
import { updateTomlDocument, type TomlValue } from "./tomlDocument.js";

/** What a migrated `settings.local.toml` is renamed to. */
export const MIGRATED_SUFFIX = ".migrated";

export type TomlTable = Readonly<Record<string, unknown>>;

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copy);
  }
  if (isTable(value)) {
    return mergeSettings({}, value);
  }
  return value;
}

/**
 * The shared file's answers with the local file's word over them.
 *
 * The result shares no object with either argument, so a caller that keeps a
 * document around to compare against later still has what it read.
 */
export function mergeSettings(
  shared: TomlTable,
  local: TomlTable,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(shared)) {
    merged[key] = copy(shared[key]);
  }
  for (const key of Object.keys(local)) {
    const mine = local[key];
    const theirs = merged[key];
    merged[key] =
      isTable(mine) && isTable(theirs)
        ? mergeSettings(theirs, mine)
        : copy(mine);
  }
  return merged;
}

/**
 * How this module reaches the two files it folds together.
 *
 * `parse` and `write` are arguments rather than imports because `config.ts`
 * owns both — its parse turns a TOML syntax error into the diagnostic the rest
 * of DevHub reports, and its write is the temp-and-rename that every other
 * settings write goes through. Importing them here would be a cycle, and
 * writing a second parse or a second write would be a second answer to a
 * question that already has one.
 */
export interface MigrationIo {
  readonly parse: (text: string) => Record<string, unknown>;
  readonly write: (path: string, text: string) => Promise<void>;
}

/**
 * The text `settings.toml` should hold once the local file is folded in.
 *
 * Written over the document that is there rather than in place of it, so the
 * shared file keeps its comments, its grouping and its key order — the same
 * guarantee an ordinary save gives.
 */
export function migratedText(
  shared: string,
  local: string,
  parse: MigrationIo["parse"],
): string {
  const merged = mergeSettings(parse(shared), parse(local)) as Record<
    string,
    TomlValue
  >;
  return updateTomlDocument(shared, merged);
}

/** What a start found to migrate, and what it did about it. */
export type MigrationOutcome =
  | { readonly kind: "nothing-to-migrate" }
  | { readonly kind: "migrated"; readonly from: string; readonly to: string };

/**
 * Fold `localPath` into `sharedPath` and rename it away, if it is still there.
 *
 * A thin wrapper over `migratedText`: read, merge, write, rename. Nothing is
 * caught. A local file that will not parse, a `settings.toml` that cannot be
 * written — those are startup failures, and DevHub silently running on half a
 * configuration it just decided to rewrite is the one outcome worth avoiding.
 */
export async function migrateLocalSettings(
  sharedPath: string,
  localPath: string,
  io: MigrationIo,
): Promise<MigrationOutcome> {
  const local = await readFile(localPath, "utf8").catch((error: unknown) => {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  });
  if (local === undefined) {
    return { kind: "nothing-to-migrate" };
  }
  const shared = await readFile(sharedPath, "utf8").catch((error: unknown) => {
    if (isNotFound(error)) {
      return "";
    }
    throw error;
  });
  await io.write(sharedPath, migratedText(shared, local, io.parse));
  const to = `${localPath}${MIGRATED_SUFFIX}`;
  await rename(localPath, to);
  return { kind: "migrated", from: localPath, to };
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}
