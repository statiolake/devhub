/**
 * Scratch is today's daily folder: `[scratch] daily` in `settings.toml`.
 *
 * The setting is a path in the one date language DevHub has,
 * `model/dateTemplate.ts` — the same tokens a `workspace_sources` entry of
 * type `date` takes (`YYYY`, `MM`, `DD`, `MMDD`, …, `[...]` for literal text).
 * The default is `~/junk/YYYYMMDD`.
 *
 * What makes a value refused (`scratchDailyProblem`) is the date language's
 * own two mistakes — an unclosed bracket, a token hiding inside a word — plus
 * one of Scratch's: it has to name *a day*. A path that names no date is one
 * folder forever, and one with `HH` or `mm` in it names a new folder every
 * hour or minute; neither is today's folder, and both are refused rather than
 * quietly producing a Scratch that moves when nobody expects it.
 *
 * The day is the local day, as `dateTemplate.ts` says. Nothing here touches
 * the filesystem or reads the clock.
 */

import {
  dateTemplateAmbiguity,
  dateTemplateBracketsBalance,
  expandDateTemplate,
} from "./dateTemplate.js";

export const DEFAULT_SCRATCH_DAILY = "~/junk/YYYYMMDD";

/** Why a `daily` value is refused, or nothing when it is fine. */
export type ScratchDailyProblem =
  | { readonly kind: "not-a-path" }
  | { readonly kind: "unbalanced-brackets" }
  | { readonly kind: "ambiguous"; readonly segment: string }
  | { readonly kind: "not-one-day" };

/** What is wrong with this `daily` value, if anything. */
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
  if (!dateTemplateBracketsBalance(template)) {
    return { kind: "unbalanced-brackets" };
  }
  const ambiguity = dateTemplateAmbiguity(template);
  if (ambiguity) return { kind: "ambiguous", segment: ambiguity.segment };
  // One folder per day: the same all day long, and a different one tomorrow.
  const morning = new Date(2001, 1, 3, 0, 0, 0);
  const night = new Date(2001, 1, 3, 23, 59, 59);
  const tomorrow = new Date(2001, 1, 4, 0, 0, 0);
  const today = expandDateTemplate(template, morning);
  if (
    expandDateTemplate(template, night) !== today ||
    expandDateTemplate(template, tomorrow) === today
  ) {
    return { kind: "not-one-day" };
  }
  return undefined;
}

/**
 * Today's folder as the setting spells it, `~` still unexpanded.
 *
 * Throws on a value `scratchDailyProblem` would refuse: the settings reader
 * refuses those first, so one arriving here is a broken invariant.
 */
export function scratchDailyPath(template: string, now: Date): string {
  if (scratchDailyProblem(template)) {
    throw new Error(`scratch.daily is not a valid template: ${template}`);
  }
  return expandDateTemplate(template, now);
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
