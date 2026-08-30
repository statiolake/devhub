/**
 * The one rule for a terminal font family.
 *
 * Three places have an opinion about this value — the config loader that reads
 * `config.toml`, the appearance projection the shell renders from, and the
 * field in the Settings window someone types into. When each states the rule in
 * its own words they drift, and the first symptom is a value one of them
 * accepts and another refuses, with a message that names neither.
 *
 * The rule itself is short, because a font family is a CSS `font-family` value
 * and CSS is what decides whether it resolves: a bare name (`Menlo`), a name
 * with spaces (`SF Mono`), a quoted name (`"Fira Code"`), or a fallback list
 * (`JetBrains Mono, Menlo, monospace`) are all ordinary. DevHub is not the
 * judge of whether a font is installed — an unresolvable name simply falls back
 * the way CSS falls back — so it refuses only the two things that are not a
 * font family at all: nothing, and text carrying control characters, which no
 * font name contains and which would be re-read as something else on the way
 * through TOML.
 */

/**
 * As many characters as DevHub will carry.
 *
 * A fallback list of any reasonable length fits well inside this; the bound is
 * here so a pasted document cannot become the value that every appearance
 * projection from then on has to carry.
 */
export const MAX_FONT_FAMILY_LENGTH = 128;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function isValidFontFamily(value: string): boolean {
  return (
    value.trim().length > 0 &&
    [...value].length <= MAX_FONT_FAMILY_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}

/**
 * The rule, in the words shown to whoever broke it.
 *
 * It is a sentence rather than a code because the only reason to show it is
 * that someone typed a value and needs to know what would be accepted instead.
 */
export const FONT_FAMILY_RULE = `A font family is a CSS font-family value: a name such as Menlo, a name with spaces such as SF Mono, a quoted name such as "Fira Code", or a comma-separated list of them. It cannot be empty, cannot contain control characters, and is at most ${String(MAX_FONT_FAMILY_LENGTH)} characters.`;
