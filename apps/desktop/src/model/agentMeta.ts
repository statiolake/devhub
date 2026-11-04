/**
 * An Agent's own key/value pairs: `role=reviewer`, `issue=123`,
 * `parent=<agent id>`.
 *
 * Whatever a person or an agent wants to say about an Agent that DevHub has
 * no field for — most of all an orchestrating agent tagging the agents it
 * started, so that `devhub --tell agents --meta parent=<its id>` finds them
 * again. DevHub reads none of it: it is kept with the Agent (`state.json`,
 * across a restart), shown quietly in the Agent row's tooltip, and listed by
 * `--tell agents --json` / `agent status --json`.
 *
 * Small on purpose, and checked in one place for every door it comes in by —
 * the command line, the socket, the state file: a key is a short identifier,
 * a value one line of text, and an Agent carries a bounded number of them.
 */

/** A key: a letter, then letters, digits, `_`, `.` or `-`; 32 at most. */
const META_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/u;
/** The longest value, in characters. */
export const META_VALUE_LIMIT = 256;
/** The most pairs one Agent carries. */
export const META_PAIR_LIMIT = 32;

export type AgentMeta = Readonly<Record<string, string>>;

export const NO_META: AgentMeta = Object.freeze({});

/** Why `key` cannot be a key, in a sentence; undefined when it can. */
export function metaKeyProblem(key: string): string | undefined {
  return META_KEY.test(key)
    ? undefined
    : `${JSON.stringify(key)} is not a metadata key: a key starts with a letter and has up to 32 letters, digits, '_', '.' or '-'.`;
}

/** Why `value` cannot be a value, in a sentence; undefined when it can. */
export function metaValueProblem(value: string): string | undefined {
  if ([...value].length > META_VALUE_LIMIT)
    return `a metadata value is at most ${String(META_VALUE_LIMIT)} characters.`;
  // One line: it is drawn as a line of a tooltip and printed as one by --tell.
  // eslint-disable-next-line no-control-regex -- control characters are the point
  if (/[\u0000-\u001f\u007f]/u.test(value))
    return "a metadata value is one line of text, with no control characters.";
  return undefined;
}

/**
 * `meta` with `key` set to `value`, or removed when `value` is undefined.
 * The same object back when nothing changes; throws the sentence when the
 * pair, or one pair too many, is refused.
 */
export function withMeta(
  meta: AgentMeta,
  key: string,
  value: string | undefined,
): AgentMeta {
  const keyProblem = metaKeyProblem(key);
  if (keyProblem !== undefined) throw new Error(keyProblem);
  if (value === undefined) {
    if (!(key in meta)) return meta;
    const { [key]: _removed, ...rest } = meta;
    return Object.freeze(rest);
  }
  const valueProblem = metaValueProblem(value);
  if (valueProblem !== undefined) throw new Error(valueProblem);
  if (meta[key] === value) return meta;
  if (!(key in meta) && Object.keys(meta).length >= META_PAIR_LIMIT)
    throw new Error(
      `an agent carries at most ${String(META_PAIR_LIMIT)} metadata keys; unset one first.`,
    );
  return Object.freeze({ ...meta, [key]: value });
}

/** A whole set of pairs, checked as `withMeta` checks each (for a state file). */
export function checkedMeta(
  record: Readonly<Record<string, string>>,
): AgentMeta {
  let meta: AgentMeta = NO_META;
  for (const [key, value] of Object.entries(record))
    meta = withMeta(meta, key, value);
  return meta;
}

/** `KEY=VALUE`, as `--meta` takes it: the first `=` splits. */
export function parseMetaPair(
  text: string,
): { readonly key: string; readonly value: string } | string {
  const at = text.indexOf("=");
  if (at <= 0) return `--meta takes KEY=VALUE, not ${JSON.stringify(text)}.`;
  const key = text.slice(0, at);
  const value = text.slice(at + 1);
  return metaKeyProblem(key) ?? metaValueProblem(value) ?? { key, value };
}
