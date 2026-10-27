/**
 * A CLI's defaults for new sessions, as the composer's pickers show and
 * change them, whichever CLI the Agent runs: which model and effort a new
 * session starts on, where that comes from, and the file a change is saved
 * in. What decides them is each CLI's own — `claudeDefaults.ts` for Claude
 * Code, `codexDefaults.ts` for Codex — and this is the part they share.
 *
 * A default is changed in the CLI's own user configuration, as the CLI's own
 * pickers save it in a terminal, never in DevHub's settings: the CLI reads
 * it there whether or not DevHub started it, so a default made here is the
 * one a `claude` or `codex` typed in a terminal starts on too.
 */

import { SAVABLE_EFFORTS } from "./claudeDefaults.js";

/** The CLIs whose defaults DevHub reads and changes. */
export type CliName = "claude" | "codex";

/** Where a default comes from. Codex's come from the argument, user and built-in ones only. */
export type CliDefaultSource =
  | "argument"
  | "environment"
  | "managed"
  | "local"
  | "project"
  | "user"
  | "built-in";

/** A setting's default for new sessions. */
export interface CliDefault {
  /**
   * The value: a model alias or name, an effort level. Absent for a model
   * nothing set (the account's default: Claude's choice `default`, the
   * model Codex's `model/list` marks as its default) and for an effort
   * whose level the CLI decides from the model.
   */
  readonly value?: string;
  readonly source: CliDefaultSource;
}

/** Both defaults, as main hands them to the page. */
export interface CliDefaults {
  readonly cli: CliName;
  /**
   * Where a change is saved, as a person reads it — "~/.claude/settings.json",
   * "~/.codex/config.toml", or the profile table of it that Codex reads.
   */
  readonly savedIn: string;
  readonly model: CliDefault;
  readonly effort: CliDefault;
}

/** How a CLI is called in a sentence. */
export const CLI_WORDS: Readonly<Record<CliName, string>> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** How a default's source reads, after "set by", for the CLIs that have it. */
const SOURCE_WORDS: Readonly<
  Record<CliName, Partial<Record<CliDefaultSource, string>>>
> = {
  claude: {
    argument: "the Agent profile's arguments",
    environment: "the environment",
    managed: "managed settings",
    local: "this project's .claude/settings.local.json",
    project: "this project's .claude/settings.json",
  },
  codex: {
    argument: "the Agent profile's arguments (-c)",
  },
};

/** How `source` reads, after "set by": the user's own is the file a change goes to. */
export function sourceWords(
  defaults: Pick<CliDefaults, "cli" | "savedIn">,
  source: CliDefaultSource,
): string {
  if (source === "user") return defaults.savedIn;
  if (source === "built-in") return CLI_WORDS[defaults.cli];
  return SOURCE_WORDS[defaults.cli][source] ?? source;
}

/**
 * Whether a default from `source` is what a change to the user settings
 * decides: it is the user settings' own, or nothing above them set one.
 */
export function userSettingsDecide(source: CliDefaultSource): boolean {
  return source === "user" || source === "built-in";
}

/**
 * Why `effort` cannot be saved as `cli`'s default, or undefined when it can:
 * Claude Code's settings keep the levels `SAVABLE_EFFORTS` names (`max` is a
 * session's only); Codex keeps any level its model list offers.
 */
export function unsavableEffort(
  cli: CliName,
  effort: string,
): string | undefined {
  if (cli === "claude" && !SAVABLE_EFFORTS.includes(effort))
    return `Claude Code's settings do not keep ${effort} as a default: it is for one session only`;
  return undefined;
}
