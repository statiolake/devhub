/**
 * `[orchestrator]` in `settings.toml`: where the orchestrator agent runs, how
 * the window starts it, and what it is told when something happens.
 *
 * DevHub gives the orchestrator a mechanism — the board, escalations, events —
 * and no rules of its own. What the orchestrator *does* is the person's: a
 * skill in `root` (`.claude/skills/…`, `AGENTS.md`), or whatever `event_prompt`
 * invokes. See `docs/orchestrator.md`.
 *
 * Read through `RunningSettings` like every other setting; this module is
 * the shape, the defaults and the rules, and nothing reads the file here.
 */

import { isSlug } from "./domain.js";

export interface OrchestratorConfig {
  /**
   * The folder the orchestrator agent runs in: an absolute or `~/` path. Its
   * skills and instructions are the ones that folder has. Absent: not set,
   * and starting one from the window asks for it to be set first.
   */
  readonly root: string | undefined;
  /** The agent profile the window starts it with; absent: the window's default. */
  readonly profile: string | undefined;
  /** GUI or terminal, for the window; absent: the profile's own default. */
  readonly presentation: "gui" | "tui" | undefined;
  /** What the orchestrator is sent for each event; `{EVENT}` is the event. */
  readonly event_prompt: string;
  /**
   * What it is sent when it starts. Absent: `event_prompt` with the `init`
   * event as `{EVENT}`.
   */
  readonly init_prompt: string | undefined;
}

export const EVENT_PLACEHOLDER = "{EVENT}";

export const DEFAULT_EVENT_PROMPT =
  "このイベントが発生したのでハンドリングしてください。{EVENT}";

export const DEFAULT_ORCHESTRATOR: OrchestratorConfig = {
  root: undefined,
  profile: undefined,
  presentation: undefined,
  event_prompt: DEFAULT_EVENT_PROMPT,
  init_prompt: undefined,
};

export const ORCHESTRATOR_KEYS = [
  "root",
  "profile",
  "presentation",
  "event_prompt",
  "init_prompt",
] as const;

export type OrchestratorKey = (typeof ORCHESTRATOR_KEYS)[number];

/** Why a field cannot be what it is, as the key it is about; undefined when all is well. */
export function orchestratorProblem(
  config: OrchestratorConfig,
): OrchestratorKey | undefined {
  if (config.root !== undefined && orchestratorRootProblem(config.root))
    return "root";
  if (config.profile !== undefined && !isSlug(config.profile)) return "profile";
  if (
    config.presentation !== undefined &&
    config.presentation !== "gui" &&
    config.presentation !== "tui"
  )
    return "presentation";
  if (promptProblem(config.event_prompt)) return "event_prompt";
  if (config.init_prompt !== undefined && promptProblem(config.init_prompt))
    return "init_prompt";
  return undefined;
}

/** `root` is an absolute path, `~`, or one starting with `~/`. */
export function orchestratorRootProblem(root: string): boolean {
  return (
    root.includes("\0") ||
    !(root.startsWith("/") || root === "~" || root.startsWith("~/"))
  );
}

/** A prompt has some text in it, and no null character. */
export function promptProblem(prompt: string): boolean {
  return prompt.trim().length === 0 || prompt.includes("\0");
}

export const ORCHESTRATOR_ROOT_RULE =
  "orchestrator.root is an absolute path, or one starting with ~/ (or ~ on its own): the folder the orchestrator agent runs in.";

export const ORCHESTRATOR_PROMPT_RULE =
  "An orchestrator prompt has some text in it, and no null character. {EVENT} is replaced by the event.";

/** `template` with every `{EVENT}` replaced; one without it gets the event after it. */
export function renderEventPrompt(template: string, event: string): string {
  if (!template.includes(EVENT_PLACEHOLDER)) return `${template}\n\n${event}`;
  return template.split(EVENT_PLACEHOLDER).join(event);
}
