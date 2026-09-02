/**
 * The two scopes a DevHub configuration is written across.
 *
 * `settings.toml` is the shared one — kept in a dotfiles repository, usually
 * reaching `~/.config/devhub/` as a symlink, and the same on every machine.
 * `settings.local.toml` sits beside it and holds what cannot be shared: the
 * shell's path, where this machine keeps its repositories, a font that is only
 * installed here. DevHub reads both and runs on the result.
 *
 * Both functions here work on raw TOML tables — what the file literally says,
 * before `config.ts` fills in any defaults. That ordering is the whole reason
 * this is a separate module: a default is indistinguishable from a value once
 * it has been filled in, so merging two finished `Config`s would let a default
 * that local never mentioned quietly beat a real value global did.
 *
 * The rules are two sentences:
 *
 * - Tables merge key by key, all the way down.
 * - Everything else — scalars, arrays, arrays of tables — local replaces whole.
 *
 * Tables merge because that is what makes the split usable: `[appearance]` can
 * live in the shared file while this machine overrides nothing but
 * `terminal_font_family`, instead of having to copy both sixteen-colour
 * palettes down to change a font. Arrays replace because there is no honest
 * answer to what merging two lists means — position and identity disagree, and
 * neither can express "drop the third one" — so the list a scope writes is the
 * list it gets.
 *
 * One thing local deliberately cannot do is *remove* a key global spells. It
 * can only say something different. That is not a gap to be patched with a
 * tombstone syntax: a key global spells is a key DevHub's loader knows (an
 * unknown one is a load error), so every key global can hold is a key local can
 * write a value for.
 */

import type { TomlValue } from "./tomlDocument.js";

export type TomlTable = Readonly<Record<string, unknown>>;

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copy);
  }
  if (isTable(value)) {
    return mergeScopes({}, value);
  }
  return value;
}

/**
 * The configuration DevHub actually runs on: global, with local's word over it.
 *
 * The result shares no object with either argument, so a caller that keeps a
 * scope around to compare against later still has what it read.
 */
export function mergeScopes(
  global: TomlTable,
  local: TomlTable,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(global)) {
    merged[key] = copy(global[key]);
  }
  for (const key of Object.keys(local)) {
    const mine = local[key];
    const theirs = merged[key];
    merged[key] =
      isTable(mine) && isTable(theirs) ? mergeScopes(theirs, mine) : copy(mine);
  }
  return merged;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((element, index) => sameValue(element, b[index]))
    );
  }
  if (isTable(a) || isTable(b)) {
    if (!isTable(a) || !isTable(b)) {
      return false;
    }
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && sameValue(a[key], b[key]))
    );
  }
  return Object.is(a, b);
}

/**
 * What the local file has to say, given what global already says.
 *
 * A save arrives as a whole configuration — every key, because that is what the
 * Settings window edits. Writing all of it to the local file would make the
 * shared file dead weight within one save: local would spell everything, and
 * global would never be reached again. So a save writes down only the keys
 * whose value global does not already give, and `merge(global, that)` is the
 * configuration that was saved — the property the round-trip tests pin.
 *
 * This is also what makes moving a setting to the shared file a safe, ordinary
 * thing to do. Copy a block into `settings.toml`, and the next save notices the
 * local copy is saying nothing new and takes it out — rather than leaving two
 * spellings of one setting to drift apart.
 */
export function subtractScope(
  desired: Readonly<Record<string, TomlValue>>,
  global: TomlTable,
): Record<string, TomlValue> {
  const local: Record<string, TomlValue> = {};
  for (const key of Object.keys(desired)) {
    const mine = desired[key];
    const theirs = global[key];
    if (!(key in global)) {
      local[key] = mine as TomlValue;
      continue;
    }
    if (isTable(mine) && isTable(theirs)) {
      const inner = subtractScope(
        mine as Readonly<Record<string, TomlValue>>,
        theirs,
      );
      if (Object.keys(inner).length > 0) {
        local[key] = inner;
      }
      continue;
    }
    if (!sameValue(mine, theirs)) {
      local[key] = mine as TomlValue;
    }
  }
  return local;
}
