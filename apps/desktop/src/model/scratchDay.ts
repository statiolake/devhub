/**
 * Scratch is today's daily folder: `[scratch] daily` in `settings.toml`.
 *
 * The setting is a path with `strftime` fields, `~/junk/%Y%m%d` by default.
 * Exactly four fields are understood, and they are the ones a daily folder is
 * named with:
 *
 * - `%Y` — the year, four digits
 * - `%m` — the month, `01`–`12`
 * - `%d` — the day of the month, `01`–`31`
 * - `%%` — a literal `%`
 *
 * Anything else after a `%` is refused when the settings are read
 * (`scratchDailyProblem`), never passed through: `%H` in a daily folder would
 * make a new Scratch every hour, and `%j` a folder the person never asked for,
 * and in both cases nothing on screen would say why.
 *
 * The day is the *local* day, read through `Date`'s local getters, for the
 * same reason `dateTemplate.ts` gives: a daily folder is named after the day
 * the person is living in. `nextLocalMidnight` is the one other thing here
 * that knows what a day is, so the rollover timer and the folder name can
 * never disagree about when "today" ends.
 *
 * Nothing here touches the filesystem or reads the clock.
 */

export const DEFAULT_SCRATCH_DAILY = "~/junk/%Y%m%d";

/** Why a `daily` value is refused, or nothing when it is fine. */
export type ScratchDailyProblem =
  | { readonly kind: "not-a-path" }
  | { readonly kind: "unknown-field"; readonly field: string }
  | { readonly kind: "no-date" };

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * What is wrong with this `daily` value, if anything.
 *
 * A path that names no date at all is refused too: it would be one folder
 * forever, which is a Workspace a person can simply open, and calling it
 * "today's" would be a claim the setting cannot keep.
 */
export function scratchDailyProblem(
  template: string,
): ScratchDailyProblem | undefined {
  if (
    template.length === 0 ||
    template.includes("\0") ||
    (!template.startsWith("/") && !template.startsWith("~/"))
  ) {
    return { kind: "not-a-path" };
  }
  let dated = false;
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] !== "%") continue;
    const field = template[index + 1];
    if (field === "Y" || field === "m" || field === "d") {
      dated = true;
    } else if (field !== "%") {
      return { kind: "unknown-field", field: `%${field ?? ""}` };
    }
    index += 1;
  }
  return dated ? undefined : { kind: "no-date" };
}

/**
 * Today's folder as the setting spells it, `~` still unexpanded.
 *
 * Throws on a value `scratchDailyProblem` would refuse: the settings reader
 * refuses those first, so one arriving here is a broken invariant.
 */
export function scratchDailyPath(template: string, now: Date): string {
  const problem = scratchDailyProblem(template);
  if (problem) {
    throw new Error(`scratch.daily is not a valid template: ${template}`);
  }
  let out = "";
  for (let index = 0; index < template.length; index += 1) {
    const character = template[index];
    if (character !== "%") {
      out += character;
      continue;
    }
    const field = template[index + 1];
    index += 1;
    if (field === "Y") out += pad(now.getFullYear(), 4);
    else if (field === "m") out += pad(now.getMonth() + 1, 2);
    else if (field === "d") out += pad(now.getDate(), 2);
    else out += "%";
  }
  return out;
}

/** `~/…` against this machine's home; an absolute path as it is. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/"))
    return `${home.replace(/\/+$/, "")}${path.slice(1)}`;
  return path;
}

/**
 * The first instant of the local day after `now`.
 *
 * Built from the local calendar rather than by adding 24 hours, so a day that
 * is 23 or 25 hours long (a DST change) still ends at its own midnight.
 */
export function nextLocalMidnight(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}
