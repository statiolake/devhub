/**
 * Codex's defaults for new sessions: which model and reasoning effort a
 * thread starts on when nothing in it chose one, where that comes from, and
 * how a default is changed.
 *
 * # What a thread gets
 *
 * DevHub opens a Codex thread (`thread/start`) without a model or an effort,
 * so the app-server takes both from its configuration, in Codex's own order
 * (developers.openai.com/codex/config-reference):
 *
 * - a `-c key=value` override the profile's arguments give `codex` before
 *   `app-server` (`argv.ts` puts them there): `-c model=…`,
 *   `-c model_reasoning_effort=…`;
 * - the selected configuration profile — `-c profile=…`, else the top-level
 *   `profile` key — whose `[profiles.<name>]` table's `model` and
 *   `model_reasoning_effort` come before the top-level ones;
 * - the top-level `model` and `model_reasoning_effort` of
 *   `$CODEX_HOME/config.toml` (`~/.codex/config.toml`);
 * - else Codex's own: the model `model/list` marks as its default, and that
 *   model's default effort.
 *
 * Both the profile table and the top level are the person's user
 * configuration, so both are the `user` source: a change there is a change
 * Codex reads.
 *
 * # Changing a default
 *
 * As Codex's own model picker saves one: in `config.toml`, in the selected
 * profile's table when a profile is selected, else at the top level — `model`
 * for a model, `model_reasoning_effort` for an effort. The file is edited in
 * place (`tomlDocument.ts`): every other key, comment and table stays as the
 * person wrote it. An override among the profile's arguments still wins;
 * `CliDefault.source` says so, and the page says a change would not take
 * effect until it is gone.
 */

import type { CliDefault, CliDefaults } from "./cliDefaults.js";
import {
  parseTomlValue,
  updateTomlDocument,
  type TomlValue,
} from "./tomlDocument.js";

/** What decides a Codex default, read on the Agent's machine. */
export interface CodexDefaultInputs {
  /** `config.toml`'s parsed contents; absent when there is none, or it does not parse. */
  readonly config: Readonly<Record<string, unknown>> | undefined;
  /** The profile's own arguments, which `codex` is started with. */
  readonly args: readonly string[];
}

/** Both defaults, as `codexDefaults` decides them. */
export type CodexDefaults = Pick<CliDefaults, "model" | "effort">;

/** The configuration keys a default is saved under. */
export const CODEX_KEYS = {
  model: "model",
  effort: "model_reasoning_effort",
} as const;

function objectOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * The value of the last `-c key=value` (or `--config key=value`) override
 * of `key` in `args`, as Codex reads one: the value is TOML when it parses
 * as a TOML value, else the text itself.
 */
export function overrideValue(
  args: readonly string[],
  key: string,
): string | undefined {
  let found: string | undefined;
  args.forEach((arg, index) => {
    const pair =
      (arg === "-c" || arg === "--config") && index + 1 < args.length
        ? args[index + 1]
        : arg.startsWith("--config=")
          ? arg.slice("--config=".length)
          : undefined;
    if (pair === undefined) return;
    const equals = pair.indexOf("=");
    if (equals < 0 || pair.slice(0, equals).trim() !== key) return;
    const raw = pair.slice(equals + 1).trim();
    let value: unknown = raw;
    try {
      value = parseTomlValue(`v = ${raw}`)["v"];
    } catch {
      // Not TOML: Codex takes the text as a string.
    }
    found = typeof value === "string" ? value : raw;
  });
  return nonEmpty(found);
}

/**
 * The configuration profile Codex runs under: a `-c profile=` override,
 * else the top-level `profile` key; undefined for none.
 */
export function selectedProfile(
  inputs: CodexDefaultInputs,
): string | undefined {
  return (
    overrideValue(inputs.args, "profile") ??
    nonEmpty(objectOf(inputs.config)["profile"])
  );
}

function codexDefault(inputs: CodexDefaultInputs, key: string): CliDefault {
  const argument = overrideValue(inputs.args, key);
  if (argument !== undefined) return { value: argument, source: "argument" };
  const profile = selectedProfile(inputs);
  const config = objectOf(inputs.config);
  if (profile !== undefined) {
    const value = nonEmpty(
      objectOf(objectOf(config["profiles"])[profile])[key],
    );
    if (value !== undefined) return { value, source: "user" };
  }
  const value = nonEmpty(config[key]);
  if (value !== undefined) return { value, source: "user" };
  return { source: "built-in" };
}

/** The model and effort a new thread starts on (see the module's doc). */
export function codexDefaults(inputs: CodexDefaultInputs): CodexDefaults {
  // A `--model` among the profile's arguments is the TUI's: the app-server
  // is handed only the `-c` overrides, so it is not read here either.
  return {
    model: codexDefault(inputs, CODEX_KEYS.model),
    effort: codexDefault(inputs, CODEX_KEYS.effort),
  };
}

/**
 * `config.toml`'s text with `which`'s default made `value`, every other key,
 * comment and table kept as it was: in `[profiles.<profile>]` when a profile
 * is named, else at the top level. `text` is the file as it is, or undefined
 * when there is none. A file that does not parse is refused rather than
 * written over: it is the person's, and DevHub cannot keep what it cannot
 * read.
 */
export function withCodexUserDefault(
  text: string | undefined,
  which: "model" | "effort",
  value: string,
  profile?: string,
): string {
  if (value.trim() === "")
    throw new Error(`a ${which} default cannot be empty`);
  const source = text ?? "";
  let config: Record<string, unknown>;
  try {
    config = parseTomlValue(source);
  } catch (error: unknown) {
    throw new Error(
      `Codex's config.toml is not valid TOML, so DevHub leaves it as it is: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const key = CODEX_KEYS[which];
  let desired: Record<string, unknown>;
  if (profile === undefined) {
    desired = { ...config, [key]: value };
  } else {
    const profiles = objectOf(config["profiles"]);
    desired = {
      ...config,
      profiles: {
        ...profiles,
        [profile]: { ...objectOf(profiles[profile]), [key]: value },
      },
    };
  }
  const written = updateTomlDocument(
    source,
    desired as Record<string, TomlValue>,
  );
  return written.endsWith("\n") ? written : `${written}\n`;
}
