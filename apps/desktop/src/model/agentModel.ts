/**
 * The model an Agent runs on, chosen per Agent: `--model` on `agent new`,
 * `issue assign` and `agent resume` (`devhub --tell`).
 *
 * Only a Claude profile takes one. The choice goes into the Agent's profile
 * snapshot as Claude's own `--model <name>`, in place of any `--model` the
 * profile's arguments carry (`withModel`) — never beside it — so the
 * snapshot says the one model the Agent was started on, and a restart, a
 * DevHub restart and Restart Session, which start the snapshot again, keep
 * it. A resume or a Reopen Closed starts a new snapshot from the configured
 * profile, so the choice is also written down with the session
 * (`session-meta.json`, `recently_closed`) and given to it again.
 *
 * The names are Claude's: its aliases `haiku`, `sonnet` and `opus`, or a full
 * model id, passed through as they are. DevHub keeps no list of model ids —
 * the CLI is the one that knows them — so a name is only checked to be one
 * word that cannot be read as another flag.
 */

import { argumentValue } from "./claudeDefaults.js";

/** Claude's aliases for its current models, cheapest first. */
export const MODEL_ALIASES = ["haiku", "sonnet", "opus"] as const;

/** One word: a letter or digit first, then what model ids are made of. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/u;

/** Why `name` cannot be a model name, in a sentence; undefined when it can. */
export function modelProblem(name: string): string | undefined {
  return MODEL_NAME.test(name)
    ? undefined
    : `--model takes a model name: ${MODEL_ALIASES.join(", ")}, or a full model id such as claude-sonnet-4-5 (one word, at most 128 characters), not ${JSON.stringify(name)}`;
}

/**
 * Why an Agent of `kind` cannot be given a model, in a sentence; undefined
 * for Claude. Codex has a `--model` of its own, but not these names, and a
 * GUI Codex Agent's model is chosen over its app-server, not its arguments:
 * no mapping is safe, so it is refused rather than guessed at.
 */
export function modelKindProblem(
  kind: string,
  profile: string,
): string | undefined {
  if (kind === "claude") return undefined;
  return `--model is for Claude profiles: '${profile}' runs ${kind}, whose model DevHub does not choose (set it in the profile's own arguments, or leave --model out)`;
}

/** The model `args` start Claude on (the last `--model`), if they name one. */
export function modelOf(args: readonly string[]): string | undefined {
  const value = argumentValue(args, "--model")?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * `args` with `model` as their one `--model`: every `--model <x>` and
 * `--model=<x>` taken out, and `--model <model>` put at the end.
 */
export function withModel(
  args: readonly string[],
  model: string,
): readonly string[] {
  const kept: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === "--model") {
      at += 1;
      continue;
    }
    if (arg.startsWith("--model=")) continue;
    kept.push(arg);
  }
  return [...kept, "--model", model];
}

/**
 * The model an Agent started on `agentArgs` was given over its profile's
 * own (`profileArgs`): its `--model` when the two differ, else undefined.
 * What the row's badge shows and what a resume is given again.
 */
export function modelOverride(
  agentArgs: readonly string[],
  profileArgs: readonly string[] | undefined,
): string | undefined {
  const model = modelOf(agentArgs);
  if (model === undefined) return undefined;
  return profileArgs !== undefined && modelOf(profileArgs) === model
    ? undefined
    : model;
}
