/**
 * A path that names a date: `~/workspace/daily/YYYY/MMDD`.
 *
 * DevHub used to get today's workspace by running a program that printed it.
 * That works exactly on the machine where the program is installed, which is
 * not a thing a default configuration can assume — a default has to mean
 * something on a computer that has only just run DevHub for the first time.
 * The path is a sentence about where the folders are, and expanding it needs
 * nothing but the clock.
 *
 * The tokens are moment/dayjs's, and they are those rather than `strftime`'s
 * on purpose: they are the ones the sibling extension `vscode-project-picker`
 * takes in its `formatDate` entries, so one person's daily folder is written
 * the same way in both places. `[...]` passes text through verbatim, which is
 * the only way to have a literal `DD` in a path.
 *
 * Nothing here touches the filesystem, and nothing here asks what time it is:
 * the clock is a parameter, so a test can say what day it is and the answer is
 * a pure function of the template and that day.
 *
 * The day is the *local* day, and this is the one place that says so. Every
 * token below reads its instant through `Date`'s local-time getters, never the
 * UTC ones, because a daily folder is named after the day the person having it
 * is living in — at 23:59 on the first of the month they want the first's
 * folder, whatever date UTC has already moved on to. Anything that needs to
 * agree with this — a caller, a test pinning an instant — expresses its instant
 * in local time too (`new Date(year, monthIndex, day, …)`), and then the answer
 * is the same in every timezone.
 */

/**
 * Every token, longest first — `MMDD` before `MM`, so the two-part day stamp a
 * daily folder is usually named with is one token rather than two that happen
 * to sit together.
 *
 * The order is the matching order, and it is stated once: what a token stands
 * for is below, and what counts as a token when a template is read for
 * mistakes (`dateTemplateAmbiguity`) is the same list, so the two can never
 * come to disagree about what `mm` is.
 */
const TOKEN_NAMES = [
  "YYYY",
  "YY",
  "MMDD",
  "MM",
  "DD",
  "HH",
  "mm",
  "ss",
] as const;

type TokenName = (typeof TOKEN_NAMES)[number];

/** What each token stands for, in matching order. */
function tokensFor(now: Date): readonly (readonly [string, string])[] {
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, "0");
  const stands_for: Record<TokenName, string> = {
    YYYY: pad(now.getFullYear(), 4),
    YY: pad(now.getFullYear() % 100, 2),
    MMDD: pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2),
    MM: pad(now.getMonth() + 1, 2),
    DD: pad(now.getDate(), 2),
    HH: pad(now.getHours(), 2),
    mm: pad(now.getMinutes(), 2),
    ss: pad(now.getSeconds(), 2),
  };
  return TOKEN_NAMES.map((name) => [name, stands_for[name]] as const);
}

/**
 * The template with its tokens replaced, as of `now`.
 *
 * An unclosed `[` is not possible here: a template that has one is refused
 * when the config is read (`validateWorkspaceSources`), so by the time this
 * runs the brackets balance. If one arrives anyway the rest of the template is
 * taken literally, which is the reading that loses the least.
 */
export function expandDateTemplate(template: string, now: Date): string {
  const tokens = tokensFor(now);
  let out = "";
  let index = 0;
  while (index < template.length) {
    if (template[index] === "[") {
      const end = template.indexOf("]", index + 1);
      if (end === -1) {
        out += template.slice(index + 1);
        break;
      }
      out += template.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    const matched = tokens.find(([token]) => template.startsWith(token, index));
    if (matched) {
      out += matched[1];
      index += matched[0].length;
      continue;
    }
    out += template[index];
    index += 1;
  }
  return out;
}

/**
 * Does every `[` in this template have a `]` after it?
 *
 * The one thing about a template that can be wrong without the clock: a person
 * who opened a bracket and did not close it meant something, and quietly
 * taking the rest of the path as a literal is not it. Read when the config is
 * read, so the file is refused rather than the picker silently offering a
 * folder nobody named.
 */
export function dateTemplateBracketsBalance(template: string): boolean {
  let index = 0;
  while (index < template.length) {
    if (template[index] === "]") return false;
    if (template[index] !== "[") {
      index += 1;
      continue;
    }
    const end = template.indexOf("]", index + 1);
    if (end === -1) return false;
    index = end + 1;
  }
  return true;
}

/** A path segment that reads as a word but expands as a date. */
export interface DateTemplateAmbiguity {
  /** The segment as it is written, e.g. `summaries`. */
  readonly segment: string;
  /** The token hiding in it, e.g. `mm`. */
  readonly token: string;
  /** The segment written so it means itself, e.g. `[summaries]`. */
  readonly escaped: string;
}

/** Is this a character a person would have meant as part of a word? */
function isWordCharacter(character: string): boolean {
  return /[A-Za-z0-9]/.test(character);
}

/**
 * The first segment of this template that mixes a word with a token, if any.
 *
 * `expandDateTemplate` replaces tokens *everywhere*, which is what makes the
 * language small enough to explain in a sentence — and what makes
 * `~/Documents/summaries/YYYY` expand to `~/Documents/su09aries/2026`. Nobody
 * sees that happen: the picker offers a folder that does not exist, which
 * looks exactly like a folder that has not been made yet.
 *
 * So the mistake is caught where the configuration is read, and the rule is
 * about one path segment at a time, because a segment is the unit a person
 * names: a segment that is only tokens and punctuation (`YYYY`, `MMDD`,
 * `YYYY-MM-DD`) is a date and is meant to be one, and a segment where a token
 * sits among letters or digits (`summaries`, `logsYYYY`) is a word that is
 * about to stop being one. Text inside `[...]` is already the person saying
 * "this is not a date", so it is left alone.
 */
export function dateTemplateAmbiguity(
  template: string,
): DateTemplateAmbiguity | undefined {
  for (const segment of template.split("/")) {
    let token: string | undefined;
    let word = false;
    let index = 0;
    while (index < segment.length) {
      if (segment[index] === "[") {
        const end = segment.indexOf("]", index + 1);
        // An unclosed bracket is a different mistake, reported on its own by
        // `dateTemplateBracketsBalance`. Nothing past it is a token.
        if (end === -1) break;
        index = end + 1;
        continue;
      }
      const matched = TOKEN_NAMES.find((name) =>
        segment.startsWith(name, index),
      );
      if (matched) {
        token ??= matched;
        index += matched.length;
        continue;
      }
      if (isWordCharacter(segment[index] ?? "")) word = true;
      index += 1;
    }
    if (token !== undefined && word) {
      return { segment, token, escaped: `[${segment}]` };
    }
  }
  return undefined;
}
