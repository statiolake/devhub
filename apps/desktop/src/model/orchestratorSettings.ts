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
import type { TomlValue } from "./tomlDocument.js";

export interface OrchestratorConfig {
  /**
   * The folder the orchestrator agent runs in: an absolute or `~/` path. Its
   * skills and instructions are the ones that folder has. Defaults to
   * `~/orchestrator`; the window's Start makes the folder when it is missing.
   */
  readonly root: string;
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
  /**
   * Which events reach the orchestrator, as patterns over their type:
   * `escalation.*`, `unsettled`, `*`; a pattern starting with `!` takes
   * matching types back out. `init` always goes. See `eventAllowed`.
   */
  readonly events: readonly string[];
  /**
   * The percents of a usage window (Claude's 5-hour, Codex's weekly, …) at
   * which `usage.threshold` fires, as the window's use crosses each upward:
   * once per threshold per window period. Empty: never.
   */
  readonly usage_thresholds: readonly number[];
  /**
   * The most often a batch of events goes to the orchestrator: `5m`. The
   * person's words (an answer, a message to an escalation's agent) are not
   * batched and go at once.
   */
  readonly delivery_interval: string;
  /**
   * How often an `unsettled` subject that stays so is said again: `1h`,
   * `30m`.
   */
  readonly reminder_interval: string;
  /** `[orchestrator.github]`: the GitHub event source. */
  readonly github: OrchestratorGitHubConfig;
  /** `[[orchestrator.timers]]`: fixed timers, each a `timer.elapsed`. */
  readonly timers: readonly OrchestratorTimerConfig[];
}

export interface OrchestratorGitHubConfig {
  /**
   * The GitHub Projects (v2) boards an item's lane (`Status`) is read from,
   * as `OWNER/NUMBER` (`my-org/7`): a fact of the item, never what decides
   * the population (every open Issue or pull request assigned to you). Read
   * only; DevHub never moves a card.
   */
  readonly projects: readonly string[];
  /** The base poll interval (`90s`, `2m`); it only ever backs off from here. */
  readonly interval: string;
}

export interface OrchestratorTimerConfig {
  readonly name: string;
  /** `30s`, `5m`, `1h30m`. */
  readonly interval: string;
}

export const EVENT_PLACEHOLDER = "{EVENT}";
/** The same events as JSON: an array of `{ "type": …, …fields }`. */
export const EVENT_JSON_PLACEHOLDER = "{EVENT_JSON}";

/**
 * What reaches the orchestrator unless the settings say otherwise:
 * everything. Each kind left is a signal it acts on; there is no chatter to
 * filter (`docs/orchestrator.md`, "Events").
 */
export const DEFAULT_ORCHESTRATOR_EVENTS: readonly string[] = ["*"];

/**
 * Event types a past DevHub said and this one does not, with the families
 * that have nothing left in them. A pattern in `events` naming one (or `!`
 * one) loads, is left out, and is said once as a retired setting
 * (`retiredEventPatterns`), as a retired key is (`config.ts`).
 */
export const RETIRED_EVENT_TYPES: Readonly<Record<string, string>> = {
  "escalation.stalled":
    "an agent stopped with nothing settling it is an `unsettled` subject now",
  "escalation.waiting_reminder":
    "a 待機中 escalation that may be ready — its `--at` time came, or what it is about moved — is `waiting.changed`",
  "escalation.wait_due":
    "a 待機中 escalation whose `--at` time came is `waiting.changed` (`— due`)",
  "github.assigned":
    "an open Issue assigned to you with nobody on it is `unsettled`",
  "github.unattended":
    "an open Issue assigned to you with nobody on it is `unsettled`",
  "github.lane_changed":
    "an `unsettled` or `waiting.changed` line carries the lane as it is",
  "github.pr_opened":
    "an `unsettled` or `waiting.changed` line carries the pull request as it is",
  "github.pr_ready":
    "an `unsettled` or `waiting.changed` line carries the pull request as it is",
  "github.pr_approved":
    "an `unsettled` or `waiting.changed` line carries the review decision as it is",
  "github.changes_requested":
    "an `unsettled` or `waiting.changed` line carries the review decision as it is",
  "github.review_comment":
    "an `unsettled` or `waiting.changed` line carries the unresolved conversations as they are",
  "github.checks":
    "an `unsettled` or `waiting.changed` line carries the checks as they are",
  "github.pr_merged":
    "an `unsettled` or `waiting.changed` line carries the pull request as it is",
  "github.pr_closed":
    "an `unsettled` or `waiting.changed` line carries the pull request as it is",
  "github.review_requested":
    "a pull request assigned to you is an item like an Issue: one nobody settles is `unsettled`",
  "github.reply":
    "a pull request assigned to you is an item like an Issue: one nobody settles is `unsettled`",
  "github.*":
    "nothing is said by GitHub itself: an item's state is in `unsettled`",
  "workspace.*": "a Workspace's state is read with `workspace status`",
  "workspace.opened": "a Workspace's state is read with `workspace status`",
  "workspace.closed": "a Workspace's state is read with `workspace status`",
  "workspace.issue_assigned":
    "a Workspace's state is read with `workspace status`",
  "workspace.branch_changed":
    "a Workspace's state is read with `workspace status`",
  "workspace.pr_linked": "a Workspace's state is read with `workspace status`",
  "agent.*":
    "a managed agent that stops with nothing settling it is an `unsettled` subject",
  "agent.turn_ended":
    "a managed agent that stops with nothing settling it is an `unsettled` subject",
  "agent.asked":
    "a managed agent that stops with nothing settling it is an `unsettled` subject",
  "agent.permission_requested":
    "a managed agent that stops with nothing settling it is an `unsettled` subject",
  "agent.started":
    "a managed agent that stops with nothing settling it is an `unsettled` subject",
  "agent.exited": "an Issue left with no agent on it is an `unsettled` subject",
  "agent.failed":
    "a managed agent that stops with nothing settling it is an `unsettled` subject",
};

/** Whether an `events` pattern names a retired type (or an emptied family). */
export function retiredEventPattern(pattern: string): boolean {
  const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  return Object.hasOwn(RETIRED_EVENT_TYPES, body);
}

/** `[orchestrator] usage_thresholds` when it is not set. */
export const DEFAULT_USAGE_THRESHOLDS: readonly number[] = [80, 95];

export const DEFAULT_GITHUB_INTERVAL = "90s";
/** `[orchestrator] delivery_interval` when it is not set. */
export const DEFAULT_DELIVERY_INTERVAL = "5m";
/** The most often a batch may go. */
export const MIN_DELIVERY_INTERVAL_MS = 10_000;
/** `[orchestrator] reminder_interval` when it is not set. */
export const DEFAULT_REMINDER_INTERVAL = "1h";
/** The most often an `unsettled` subject may be said again. */
export const MIN_REMINDER_INTERVAL_MS = 5 * 60_000;
/** The fastest DevHub polls GitHub for events, whatever the settings say. */
export const MIN_GITHUB_INTERVAL_MS = 30_000;
/** The fastest a timer may fire. */
export const MIN_TIMER_INTERVAL_MS = 10_000;

export const DEFAULT_EVENT_PROMPT =
  'DevHub からの通知です (対象ごとに 1 行)。各行をそれぞれバックグラウンドの fork サブエージェント (Agent ツールの subagent_type: "fork") に渡して処理し、すぐに戻ってください。\n{EVENT}';

/** Where the orchestrator runs when `[orchestrator] root` is not set. */
export const DEFAULT_ORCHESTRATOR_ROOT = "~/orchestrator";

export const DEFAULT_ORCHESTRATOR: OrchestratorConfig = {
  root: DEFAULT_ORCHESTRATOR_ROOT,
  profile: undefined,
  presentation: undefined,
  event_prompt: DEFAULT_EVENT_PROMPT,
  init_prompt: undefined,
  events: DEFAULT_ORCHESTRATOR_EVENTS,
  usage_thresholds: DEFAULT_USAGE_THRESHOLDS,
  delivery_interval: DEFAULT_DELIVERY_INTERVAL,
  reminder_interval: DEFAULT_REMINDER_INTERVAL,
  github: { projects: [], interval: DEFAULT_GITHUB_INTERVAL },
  timers: [],
};

export const ORCHESTRATOR_KEYS = [
  "root",
  "profile",
  "presentation",
  "event_prompt",
  "init_prompt",
  "events",
  "usage_thresholds",
  "delivery_interval",
  "reminder_interval",
  "github",
  "timers",
] as const;

export const ORCHESTRATOR_GITHUB_KEYS = ["projects", "interval"] as const;
export const ORCHESTRATOR_TIMER_KEYS = ["name", "interval"] as const;

export type OrchestratorKey = (typeof ORCHESTRATOR_KEYS)[number];

/** Why a field cannot be what it is, as the key it is about; undefined when all is well. */
export function orchestratorProblem(
  config: OrchestratorConfig,
): string | undefined {
  if (orchestratorRootProblem(config.root)) return "root";
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
  if (config.events.some(eventPatternProblem)) return "events";
  if (usageThresholdsProblem(config.usage_thresholds))
    return "usage_thresholds";
  if (intervalProblem(config.delivery_interval, MIN_DELIVERY_INTERVAL_MS))
    return "delivery_interval";
  if (intervalProblem(config.reminder_interval, MIN_REMINDER_INTERVAL_MS))
    return "reminder_interval";
  if (config.github.projects.some((one) => projectRefProblem(one)))
    return "github.projects";
  if (intervalProblem(config.github.interval, MIN_GITHUB_INTERVAL_MS))
    return "github.interval";
  const names = new Set<string>();
  for (const [index, timer] of config.timers.entries()) {
    if (!isTimerName(timer.name) || names.has(timer.name))
      return `timers[${String(index)}].name`;
    names.add(timer.name);
    if (intervalProblem(timer.interval, MIN_TIMER_INTERVAL_MS))
      return `timers[${String(index)}].interval`;
  }
  return undefined;
}

/** `tick`, `review-sweep`: letters, digits, `-` and `_`, at most 40. */
export function isTimerName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/u.test(name);
}

/**
 * An event pattern: a type (`unsettled`), a family (`github.*`), `*`,
 * any of them after `!` to take them out again.
 */
export function eventPatternProblem(pattern: string): boolean {
  const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  return !/^(\*|[a-z][a-z0-9_]*(\.([a-z0-9_-]+|\*))*)$/u.test(body);
}

/**
 * Whether an event of `type` reaches the orchestrator under `patterns`: the
 * last pattern that matches decides (`!` excludes), and none matching is no.
 * `init` always does: it is what starts the orchestrator off.
 */
export function eventAllowed(
  type: string,
  patterns: readonly string[],
): boolean {
  if (type === "init") return true;
  let allowed = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (patternMatches(body, type)) allowed = !negated;
  }
  return allowed;
}

function patternMatches(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

/** `my-org/7`: a Projects (v2) board, by its owner's login and its number. */
export function projectRefProblem(ref: string): boolean {
  return parseProjectRef(ref) === undefined;
}

export function parseProjectRef(
  ref: string,
): { readonly owner: string; readonly number: number } | undefined {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/(\d{1,9})$/u.exec(
    ref.trim(),
  );
  if (match === null) return undefined;
  const number = Number(match[2]);
  return number > 0 ? { owner: match[1]!, number } : undefined;
}

/** A board's page on GitHub: `https://github.com/orgs/OWNER/projects/N`. */
export function projectUrl(ref: string): string | undefined {
  const parsed = parseProjectRef(ref);
  return parsed === undefined
    ? undefined
    : `https://github.com/orgs/${parsed.owner}/projects/${String(parsed.number)}`;
}

/** How GitHub polling stands, as the board and `orchestrator status` say it. */
export type GitHubHealth = "active" | "suspended" | "idle" | "backing_off";

/**
 * The polling's health: its mode, except that an active one which last
 * failed, or is slowed or paused by a low rate limit, is backing off — with
 * why. The same thresholds the poller slows down by (`nextDelay`).
 */
export function githubHealth(github: {
  readonly state: "active" | "suspended" | "idle";
  readonly problem?: string;
  readonly rateLimit?: { readonly remaining: number; readonly limit: number };
}): { readonly health: GitHubHealth; readonly why?: string } {
  if (github.state !== "active") return { health: github.state };
  if (github.problem !== undefined)
    return { health: "backing_off", why: github.problem };
  const rate = github.rateLimit;
  if (rate !== undefined) {
    if (rate.remaining <= 100)
      return {
        health: "backing_off",
        why: `rate limit low (${String(rate.remaining)} left)`,
      };
    const share = rate.limit > 0 ? rate.remaining / rate.limit : 1;
    if (share < 0.5)
      return {
        health: "backing_off",
        why: `rate limit at ${String(Math.round(share * 100))}%: polling slower`,
      };
  }
  return { health: "active" };
}

/**
 * `90s`, `5m`, `1h30m`, `2h` as milliseconds; undefined when it is none of
 * those. Bare numbers are refused: a unit is what makes `5` mean something.
 */
export function parseInterval(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^(\d+(ms|s|m|h))+$/u.test(trimmed)) return undefined;
  let total = 0;
  for (const match of trimmed.matchAll(/(\d+)(ms|s|m|h)/gu)) {
    const value = Number(match[1]);
    const unit = match[2];
    total +=
      unit === "h"
        ? value * 3_600_000
        : unit === "m"
          ? value * 60_000
          : unit === "s"
            ? value * 1000
            : value;
  }
  return total;
}

export function intervalProblem(text: string, minimumMs: number): boolean {
  const ms = parseInterval(text);
  return ms === undefined || ms < minimumMs || ms > 7 * 24 * 3_600_000;
}

/** `90s`, `5m`, `1h30m`: an interval as a person writes one. */
export function formatInterval(ms: number): string {
  if (ms % 1000 !== 0) return `${String(ms)}ms`;
  let seconds = ms / 1000;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  return (
    [
      hours > 0 ? `${String(hours)}h` : "",
      minutes > 0 ? `${String(minutes)}m` : "",
      seconds > 0 ? `${String(seconds)}s` : "",
    ].join("") || "0s"
  );
}

export const ORCHESTRATOR_EVENTS_RULE =
  "orchestrator.events lists event types (unsettled), families (github.*) or *, each optionally after ! to exclude it.";

export const ORCHESTRATOR_GITHUB_RULE = `orchestrator.github.projects lists Projects boards as OWNER/NUMBER (my-org/7); orchestrator.github.interval is like 90s or 2m, at least ${String(MIN_GITHUB_INTERVAL_MS / 1000)}s.`;

export const ORCHESTRATOR_DELIVERY_RULE = `orchestrator.delivery_interval is like 5m or 90s, at least ${String(MIN_DELIVERY_INTERVAL_MS / 1000)}s: the most often a batch of events goes. orchestrator.reminder_interval is like 1h or 30m, at least ${String(MIN_REMINDER_INTERVAL_MS / 60_000)}m: how often an unsettled subject is said again.`;

export const ORCHESTRATOR_TIMER_RULE = `Each [[orchestrator.timers]] has a name (letters, digits, - and _; each once) and an interval like 5m or 1h, at least ${String(MIN_TIMER_INTERVAL_MS / 1000)}s.`;

/**
 * `usage_thresholds`: whole percents from 1 to 100, each once. Their order
 * does not matter; empty is allowed (no `usage.threshold` at all).
 */
export function usageThresholdsProblem(thresholds: readonly number[]): boolean {
  return (
    thresholds.some((one) => !Number.isInteger(one) || one < 1 || one > 100) ||
    new Set(thresholds).size !== thresholds.length
  );
}

export const ORCHESTRATOR_USAGE_THRESHOLDS_RULE =
  "orchestrator.usage_thresholds lists whole percents from 1 to 100, each once (80, 95): usage.threshold fires as a usage window crosses each.";

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
  "An orchestrator prompt has some text in it, and no null character. {EVENT} is replaced by the event, {EVENT_JSON} by the same as JSON.";

/**
 * `template` with every `{EVENT}` replaced by `event`, and every
 * `{EVENT_JSON}` by `json`; one with neither gets the event after it.
 */
export function renderEventPrompt(
  template: string,
  event: string,
  json?: string,
): string {
  const hasText = template.includes(EVENT_PLACEHOLDER);
  const hasJson = template.includes(EVENT_JSON_PLACEHOLDER);
  if (!hasText && !hasJson) return `${template}\n\n${event}`;
  return template
    .split(EVENT_JSON_PLACEHOLDER)
    .map((part) => part.split(EVENT_PLACEHOLDER).join(event))
    .join(json ?? "[]");
}

/**
 * `[orchestrator]` as the document writes it: what is set, and the event
 * filter, the GitHub table and the timers only when they are not the
 * defaults, so a file nobody customised stays short.
 */
export function orchestratorDocument(
  config: OrchestratorConfig,
): Record<string, TomlValue> {
  const document: Record<string, TomlValue> = {};
  if (config.root !== DEFAULT_ORCHESTRATOR_ROOT) document["root"] = config.root;
  for (const key of [
    "profile",
    "presentation",
    "event_prompt",
    "init_prompt",
  ] as const) {
    const value = config[key];
    if (value !== undefined) document[key] = value;
  }
  if (
    config.events.length !== DEFAULT_ORCHESTRATOR_EVENTS.length ||
    config.events.some(
      (one, index) => one !== DEFAULT_ORCHESTRATOR_EVENTS[index],
    )
  )
    document["events"] = [...config.events];
  if (
    config.usage_thresholds.length !== DEFAULT_USAGE_THRESHOLDS.length ||
    config.usage_thresholds.some(
      (one, index) => one !== DEFAULT_USAGE_THRESHOLDS[index],
    )
  )
    document["usage_thresholds"] = [...config.usage_thresholds];
  if (config.delivery_interval !== DEFAULT_DELIVERY_INTERVAL)
    document["delivery_interval"] = config.delivery_interval;
  if (config.reminder_interval !== DEFAULT_REMINDER_INTERVAL)
    document["reminder_interval"] = config.reminder_interval;
  const github: Record<string, TomlValue> = {};
  if (config.github.projects.length > 0)
    github["projects"] = [...config.github.projects];
  if (config.github.interval !== DEFAULT_GITHUB_INTERVAL)
    github["interval"] = config.github.interval;
  if (Object.keys(github).length > 0) document["github"] = github;
  if (config.timers.length > 0)
    document["timers"] = config.timers.map((timer) => ({
      name: timer.name,
      interval: timer.interval,
    }));
  return document;
}
