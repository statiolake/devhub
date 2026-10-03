/**
 * Claude Code's defaults for new sessions: which model and effort a session
 * starts on when nothing in it chose one, where that comes from, and how a
 * default is changed.
 *
 * # What a session gets, in Claude Code's own order
 *
 * Claude Code's model configuration (code.claude.com/docs/en/model-config)
 * and settings reference (…/settings-reference) say:
 *
 * - **Model**: `/model` during the session, then `--model` at startup, then
 *   `ANTHROPIC_MODEL`, then the `model` key of the settings files, else the
 *   account's own default — which the handshake lists as the choice
 *   `default`. Of the settings files, managed settings come first (an
 *   organization default overrides the person's), then local
 *   (`.claude/settings.local.json`), project (`.claude/settings.json`) and
 *   user (`~/.claude/settings.json`).
 * - **Effort**: an explicit choice — `CLAUDE_CODE_EFFORT_LEVEL` before
 *   `--effort` ("`CLAUDE_CODE_EFFORT_LEVEL` takes precedence over both"),
 *   or `/effort` in the session — then the settings: the level saved for the
 *   model (`modelSettings.<model>.effortLevel`), else the top-level
 *   `effortLevel`, which is for "models you haven't saved a level for"; then
 *   the model's own default: `medium` on Opus 5.5 and Sonnet 5.5, `xhigh` on
 *   Opus 4.7, `high` on every other model that takes effort.
 *
 * # Resume
 *
 * "Resumed sessions started with `claude --resume`, `--continue`, or the
 * `/resume` picker keep the model they were using when the transcript was
 * saved, regardless of the current `model` setting" (model-config, "Model
 * on resume"), unless that model was retired or is not allowed. Nothing says
 * an effort is kept: an effort chosen with `/effort` in `-p` mode — DevHub's
 * GUI Agents run there — is applied "to that session only and doesn't save
 * it", so a CLI started again resolves its effort from the order above. That
 * is why the defaults here say what a *new* process starts at, and the
 * session's own model, when it resumed one, is read from its transcript.
 *
 * # Changing a default
 *
 * DevHub changes the person's own user settings only, as the CLI's own
 * `/model` and `/effort` save there in an interactive session: the `model`
 * key, or the effort saved for the model (`modelSettings.<model>.effortLevel`,
 * where the CLI itself saves it) — or the top-level `effortLevel` when no
 * model is named. Every other key is kept as it was. A source above the user
 * settings (an argument, the environment, managed, local or project
 * settings) still wins; `CliDefault.source` says which one the default is
 * from, so the page can say a change would not take effect.
 */

/** A settings file Claude Code reads, highest first. */
export const CLAUDE_SETTINGS_LAYERS = [
  "managed",
  "local",
  "project",
  "user",
] as const;

export type ClaudeSettingsLayer = (typeof CLAUDE_SETTINGS_LAYERS)[number];

/** What decides a default, read on the Agent's machine. */
export interface ClaudeDefaultInputs {
  /** Each settings file's parsed contents; a file that is not there is absent. */
  readonly settings: Readonly<Partial<Record<ClaudeSettingsLayer, unknown>>>;
  /** The environment the CLI starts in: the machine's, with the profile's over it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The profile's own arguments, which the CLI is started with. */
  readonly args: readonly string[];
}

/** Where a default comes from. */
export type CliDefaultSource =
  | "argument"
  | "environment"
  | ClaudeSettingsLayer
  | "built-in";

/** A setting's default for new sessions. */
export interface CliDefault {
  /**
   * The value: a model alias or name, an effort level. Absent for a model
   * nothing set (the account's default, the choice `default`) and for an
   * effort whose model is not known.
   */
  readonly value?: string;
  readonly source: CliDefaultSource;
}

/** Both defaults, as main hands them to the page. */
export interface CliDefaults {
  readonly model: CliDefault;
  readonly effort: CliDefault;
}

/** The effort levels a settings file takes (`max` is a session's only). */
export const SAVABLE_EFFORTS: readonly string[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

/** The suffix that picks a model's 1M token context window: not a model of its own. */
const LONG_CONTEXT = "[1m]";

/**
 * The value of the last `--flag value` or `--flag=value` in `args`, as the
 * CLI's parser reads a flag given twice.
 */
export function argumentValue(
  args: readonly string[],
  flag: string,
): string | undefined {
  let value: string | undefined;
  args.forEach((arg, index) => {
    if (arg === flag && index + 1 < args.length) value = args[index + 1];
    else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
  });
  return value;
}

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

/** The model a new session starts on (see the module's doc). */
export function claudeModelDefault(inputs: ClaudeDefaultInputs): CliDefault {
  const argument = nonEmpty(argumentValue(inputs.args, "--model"));
  if (argument !== undefined) return { value: argument, source: "argument" };
  const environment = nonEmpty(inputs.env["ANTHROPIC_MODEL"]);
  if (environment !== undefined)
    return { value: environment, source: "environment" };
  for (const layer of CLAUDE_SETTINGS_LAYERS) {
    const value = nonEmpty(objectOf(inputs.settings[layer])["model"]);
    if (value !== undefined) return { value, source: layer };
  }
  return { source: "built-in" };
}

/**
 * The effort a model starts at when nothing chose one, as model-config's
 * "Adjust effort level" lists it; undefined for no model.
 */
export function builtInEffort(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  if (/opus-5-5|sonnet-5-5/u.test(model)) return "medium";
  if (/opus-4-7/u.test(model)) return "xhigh";
  return "high";
}

/** The names `modelSettings` may save `model` under: as given, and without its context window. */
function modelKeys(model: string | undefined): readonly string[] {
  if (model === undefined) return [];
  return model.endsWith(LONG_CONTEXT)
    ? [model, model.slice(0, -LONG_CONTEXT.length)]
    : [model];
}

/**
 * The effort a new session of `model` (its full name, when known) starts at
 * (see the module's doc). `auto` in the environment is the model's default.
 */
export function claudeEffortDefault(
  inputs: ClaudeDefaultInputs,
  model: string | undefined,
): CliDefault {
  const environment = nonEmpty(inputs.env["CLAUDE_CODE_EFFORT_LEVEL"]);
  if (environment !== undefined) {
    const value = environment === "auto" ? builtInEffort(model) : environment;
    return value === undefined
      ? { source: "environment" }
      : { value, source: "environment" };
  }
  const argument = nonEmpty(argumentValue(inputs.args, "--effort"));
  if (argument !== undefined) return { value: argument, source: "argument" };
  for (const layer of CLAUDE_SETTINGS_LAYERS) {
    const saved = objectOf(objectOf(inputs.settings[layer])["modelSettings"]);
    for (const key of modelKeys(model)) {
      const value = nonEmpty(objectOf(saved[key])["effortLevel"]);
      if (value !== undefined) return { value, source: layer };
    }
  }
  for (const layer of CLAUDE_SETTINGS_LAYERS) {
    const value = nonEmpty(objectOf(inputs.settings[layer])["effortLevel"]);
    if (value !== undefined) return { value, source: layer };
  }
  const value = builtInEffort(model);
  return value === undefined
    ? { source: "built-in" }
    : { value, source: "built-in" };
}

export function claudeDefaults(
  inputs: ClaudeDefaultInputs,
  model: string | undefined,
): CliDefaults {
  return {
    model: claudeModelDefault(inputs),
    effort: claudeEffortDefault(inputs, model),
  };
}

/**
 * Whether a default from `source` is what a change to the user settings
 * decides: it is the user settings' own, or nothing above them set one.
 */
export function userSettingsDecide(source: CliDefaultSource): boolean {
  return source === "user" || source === "built-in";
}

/** How a default's source reads, after "set by". */
export const SOURCE_WORDS: Readonly<Record<CliDefaultSource, string>> = {
  argument: "the Agent profile's arguments",
  environment: "the environment",
  managed: "managed settings",
  local: "this project's .claude/settings.local.json",
  project: "this project's .claude/settings.json",
  user: "~/.claude/settings.json",
  "built-in": "Claude Code itself",
};

/**
 * The user settings file's text with `which`'s default made `value`, every
 * other key kept. `model` names the model an effort is saved for (its full
 * name; a context-window suffix is not part of it); without one the effort
 * is the top-level `effortLevel`. `text` is the file as it is, or undefined
 * when there is none. A file that is not a JSON object is refused rather
 * than written over: it is the person's, and DevHub cannot keep what it
 * cannot read.
 */
export function withUserDefault(
  text: string | undefined,
  which: "model" | "effort",
  value: string,
  model?: string,
): string {
  let settings: Record<string, unknown> = {};
  if (text !== undefined && text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      throw new Error(
        `Claude Code's user settings are not valid JSON, so DevHub leaves them as they are: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(
        "Claude Code's user settings are not a JSON object, so DevHub leaves them as they are",
      );
    settings = { ...(parsed as Record<string, unknown>) };
  }
  if (value.trim() === "")
    throw new Error(`a ${which} default cannot be empty`);
  if (which === "model") {
    settings["model"] = value;
  } else {
    if (!SAVABLE_EFFORTS.includes(value))
      throw new Error(
        `Claude Code's settings take ${SAVABLE_EFFORTS.join(", ")} as a default effort, not ${value}: ${value === "max" ? "max is for one session only" : "it is not a level"}`,
      );
    const key =
      model === undefined
        ? undefined
        : model.endsWith(LONG_CONTEXT)
          ? model.slice(0, -LONG_CONTEXT.length)
          : model;
    if (key === undefined) {
      settings["effortLevel"] = value;
    } else {
      const saved = { ...objectOf(settings["modelSettings"]) };
      saved[key] = { ...objectOf(saved[key]), effortLevel: value };
      settings["modelSettings"] = saved;
    }
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}
