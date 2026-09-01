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
 */

/** What each token stands for, longest first — `MMDD` before `MM`. */
function tokensFor(now: Date): readonly (readonly [string, string])[] {
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, "0");
  return [
    ["YYYY", pad(now.getFullYear(), 4)],
    ["YY", pad(now.getFullYear() % 100, 2)],
    // Ahead of `MM`, so the two-part day stamp a daily folder is usually named
    // with is one token rather than two that happen to sit together.
    ["MMDD", pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2)],
    ["MM", pad(now.getMonth() + 1, 2)],
    ["DD", pad(now.getDate(), 2)],
    ["HH", pad(now.getHours(), 2)],
    ["mm", pad(now.getMinutes(), 2)],
    ["ss", pad(now.getSeconds(), 2)],
  ];
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
