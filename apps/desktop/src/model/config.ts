/**
 * The user's configuration: `~/.config/devhub/settings.toml` and
 * `settings.local.toml`.
 *
 * A port of `crates/devhub-app-core/src/config/mod.rs`. The rules that matter
 * are kept exactly: unknown keys are an error rather than an ignored typo, the
 * whole file is validated before any of it is adopted, a save is refused when
 * the file changed underneath it, and the last file that parsed stays in
 * effect while a broken one is on disk — with the diagnostic kept, so "still
 * running on the old config" is a state the app can show rather than a silence.
 *
 * What is new is that "the file" is two of them. `settings.toml` is the shared
 * half, kept in a dotfiles repository and identical on every machine;
 * `settings.local.toml` is what is only true here — the shell's path, where
 * this machine keeps its repositories. They are read as one, with local's word
 * over global's, and a save writes only local. `settingsScopes.ts` has the
 * merge rules and the reasoning; everything above this module still sees one
 * configuration.
 *
 * A save keeps the document the person wrote: `tomlDocument.ts` rewrites only
 * the spans whose values actually changed, so comments, grouping, key order and
 * spacing survive — the same guarantee `toml_edit` gave the Rust.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ACTION_TRIGGERS,
  BUILT_IN_ACTIONS,
  triggerOf,
  type AgentActionTrigger,
} from "./agentActions.js";
import { dateTemplateBracketsBalance } from "./dateTemplate.js";
import { isValidFontFamily } from "./fontFamily.js";
import { currentProfile, type ProfileLocations } from "./profile.js";
import { mergeScopes, subtractScope } from "./settingsScopes.js";
import {
  parseTomlValue,
  renderTomlDocument,
  TomlSyntaxError,
  updateTomlDocument,
  type TomlValue,
} from "./tomlDocument.js";

export const CONFIG_SCHEMA_VERSION = 1;

export const GLOBAL_CONFIG_FILE_NAME = "settings.toml";
export const LOCAL_CONFIG_FILE_NAME = "settings.local.toml";
/** The single file DevHub kept before the settings were split in two. */
export const LEGACY_CONFIG_FILE_NAME = "config.toml";

/**
 * The two files one configuration is spread across, and the one it came from.
 *
 * `global` is the shared half — meant to be a symlink into a dotfiles
 * repository, and never written by DevHub. `local` is this machine's half, and
 * the only file a save touches. `legacy` is the pre-split `config.toml`, which
 * `load` renames into place once and then never looks at again.
 */
export interface ConfigPaths {
  readonly global: string;
  readonly local: string;
  readonly legacy?: string;
}

/** Both files as they were last read; `global` absent means there is no file. */
interface ScopeText {
  readonly global: string | undefined;
  readonly local: string;
}

/**
 * The identity of the pair.
 *
 * Both files go into it because a save has to be refused when *either* has
 * moved: an open Settings window that saved against a stale shared file would
 * subtract against answers that are no longer there and write a local file
 * that means something else.
 */
function scopeRevision(scopes: ScopeText): ContentRevision {
  return contentRevision(
    `${contentRevision(scopes.global ?? "")}:${contentRevision(scopes.local)}`,
  );
}

function decodeUtf8(bytes: Buffer, scope: ConfigScope): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError({ code: "invalid_utf8", scope });
  }
}

/**
 * Where the settings live.
 *
 * `~/.config/devhub/` for the default profile, `~/.config/devhub-<profile>/`
 * for any other, and `$XDG_CONFIG_HOME` in place of `~/.config` when it says
 * so. The directory is not spelled here: `profile.ts` derives it along with
 * every other location a profile decides, so a second DevHub cannot end up
 * separated everywhere but its settings.
 */
export function defaultConfigPaths(
  home: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ConfigPaths {
  const directory = currentProfile(home, environment).configDirectory;
  return {
    global: join(directory, GLOBAL_CONFIG_FILE_NAME),
    local: join(directory, LOCAL_CONFIG_FILE_NAME),
    legacy: join(directory, LEGACY_CONFIG_FILE_NAME),
  };
}

export const DEFAULT_EXCLUDE_NAMES: readonly string[] = [
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".cache",
];

const DEFAULT_SHELL = "/bin/zsh";
const DEFAULT_GIT = "git";
const DEFAULT_TMUX = "tmux";
const DEFAULT_TMUX_SOCKET = "devhub";
const DEFAULT_FONT_FAMILY = "ui-monospace";
const MAX_TERMINAL_MARGIN = 64;

export type WorkspaceKind = "directory" | "git_repository" | "git_worktree";

export interface FilesystemSource {
  readonly type: "filesystem";
  readonly id: string;
  readonly path: string;
  readonly min_depth: number;
  readonly max_depth?: number;
  readonly kinds: readonly WorkspaceKind[];
  readonly include_hidden: boolean;
  readonly exclude_names: readonly string[];
}

export interface CommandSource {
  readonly type: "command";
  readonly id: string;
  readonly command: readonly string[];
  readonly timeout_ms: number;
}

/**
 * One folder, named by today's date: `~/workspace/daily/YYYY/MMDD`.
 *
 * The tokens and their meanings are in `model/dateTemplate.ts`. There is no
 * depth and no walk, because there is nothing to search: the template names
 * exactly one folder, and that folder is today's.
 *
 * `create_if_missing` is what makes it useful on the day it matters. A daily
 * folder does not exist until something makes it, and the moment a person
 * wants it is the moment before it exists — so the row is offered anyway, and
 * choosing it makes the folder. Turned off, the source is simply silent on any
 * day the folder is not there yet.
 */
export interface DateSource {
  readonly type: "date";
  readonly id: string;
  readonly path: string;
  readonly create_if_missing: boolean;
}

export type WorkspaceSource = FilesystemSource | CommandSource | DateSource;

export type AgentProfileKind = "codex" | "claude" | "cursor" | "custom";

/**
 * The program a known kind runs when the file does not name one.
 *
 * For Codex and Claude this is the kind's own name, which is why nobody has to
 * write a `command` for them. Cursor is the reason this is a function rather
 * than the identity: its kind is `cursor` and its program is `cursor-agent`.
 *
 * The distinction is not pedantic. `cursor` is itself a real command on any
 * machine with the editor installed — it opens the editor — so defaulting to
 * the kind's name would not have failed loudly with "command not found". It
 * would have started the wrong program, only for the people who left the
 * command out, and the pane would have shown something that was never an Agent
 * while the sidebar waited for a screen the manifest describes.
 */
export function defaultCommandForKind(
  kind: Exclude<AgentProfileKind, "custom">,
): string {
  return kind === "cursor" ? "cursor-agent" : kind;
}

/**
 * What DevHub says to an Agent when it takes an action on the person's behalf.
 *
 * **The trigger is data now, not a lookup.** It used to be inferred from the id
 * — an id DevHub shipped had the trigger DevHub shipped it with, and everything
 * else was an Issue action — which meant a person could not write a second
 * commit button, and meant the file's shape did not say what it meant. It is
 * spelled in the file (`[agent_actions.commit.tidy_up]`) and read from there.
 *
 * See `model/agentActions.ts` for the triggers, the variables each one offers
 * and the skill notation.
 */
export interface ConfiguredAgentAction {
  /** What fires it: the Issue flow, or one of the workspace's own buttons. */
  readonly trigger: AgentActionTrigger;
  readonly id: string;
  readonly display_name: string;
  readonly template: string;
  /**
   * Whether the wording is put in front of the person before it is sent.
   *
   * True by default, and per action rather than per place it is fired from: a
   * template is a sentence somebody wrote once and may be right every time
   * ("commit what is here") or worth a look every time ("implement this
   * Issue"), and that is a property of the wording, not of the button. The
   * caller never chooses — it queues an intent and this decides which state
   * that intent starts in (`main/agent/injection.ts`).
   */
  readonly confirm_before_send: boolean;
  /**
   * Whether this action exists at all.
   *
   * The way a person removes one DevHub ships. Built-ins are merged in by id
   * rather than listed by the file, which is what stops a file written before
   * an action existed from deleting it — the bug that lost the three shortcut
   * buttons from every configuration that had ever been saved. The cost of that
   * is that "not mentioned" can no longer mean "gone", so being gone is said
   * out loud.
   */
  readonly enabled: boolean;
  /**
   * Where it sits among the actions with its trigger.
   *
   * A number rather than the file's key order, because a table's keys are a set
   * — TOML says nothing about their order surviving a rewrite — and the order
   * of four buttons in a row is something a person arranges and expects to keep.
   */
  readonly order: number;
}

export interface ConfiguredAgentProfile {
  readonly id: string;
  readonly display_name: string;
  readonly kind: AgentProfileKind;
  /**
   * The program tmux runs as the Agent's session command.
   *
   * Absent in the file means the kind's own name, which is what the two
   * shipped profiles want and why nobody has to write it. It is separate from
   * `kind` because the two answer different questions: this one is what to
   * start, and `kind` is whose screen it is — which is the only thing status
   * detection can be keyed on.
   */
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface GeneralConfig {
  readonly import_login_environment: boolean;
}

export interface RuntimeConfig {
  readonly shell: string;
  readonly git: string;
  readonly tmux: string;
  readonly tmux_socket_name: string;
  readonly tmux_args: readonly string[];
}

export interface TerminalPalette {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly cursorText: string;
  readonly selectionBackground: string;
  readonly selectionForeground: string;
  readonly ansi: readonly string[];
}

export interface TerminalThemeConfig {
  readonly light: TerminalPalette;
  readonly dark: TerminalPalette;
}

/**
 * The three appearances DevHub can run in, and the only values `appearance.mode`
 * takes.
 *
 * One list, exported, because three places have to agree on it: the config
 * validator, the Settings popup that offers the choice, and the main-process
 * mapping onto Electron's `themeSource`. A fourth spelling of the same three
 * words is how a value becomes selectable in the UI and rejected by the loader.
 */
export const APPEARANCE_MODES: readonly string[] = ["auto", "light", "dark"];

export interface AppearanceConfig {
  /**
   * Which appearance DevHub runs in: `auto`, `light` or `dark`.
   *
   * Not a palette. This is the answer DevHub gives the OS — it decides what
   * Electron reports the system appearance to be, for every native surface in
   * the process and for `window.autoDetectColorScheme` in each workbench. The
   * colours themselves still come from the workbench's own theme, which is why
   * `appearance.color_scheme` stayed retired. See `shell/appearanceMode.ts`.
   */
  readonly mode: string;
  readonly terminalFontFamily: string;
  readonly terminalFontSize: number;
  readonly terminalLineHeight: number;
  readonly sidebarDensity: string;
  readonly terminalMargin: number;
  readonly terminalTheme: TerminalThemeConfig;
}

export interface Config {
  readonly version: number;
  readonly general: GeneralConfig;
  readonly runtimes: RuntimeConfig;
  readonly appearance: AppearanceConfig;
  readonly workspaceSources: readonly WorkspaceSource[];
  readonly agentProfiles: readonly ConfiguredAgentProfile[];
  readonly agentActions: readonly ConfiguredAgentAction[];
}

/**
 * The configuration a non-default profile actually runs on.
 *
 * `runtimes.tmux_socket_name` is the one setting a person can write that would
 * undo the separation a profile exists for: a development DevHub whose
 * settings were seeded from the production one carries
 * `tmux_socket_name = "devhub"`, and two DevHubs on one tmux server manage each
 * other's sessions.
 *
 * The profile wins, rather than the app refusing to start. Refusing would be
 * correct if the setting were a request DevHub could not honour, but it is
 * not: separation is the whole meaning of asking for a second profile, so the
 * profile's socket *is* what was asked for, and a shared settings file that
 * names the production socket is the ordinary case rather than a mistake to
 * report. The override is logged so that "my socket name is ignored here" is
 * something the person is told rather than something they discover.
 */
export function withProfileRuntimes(
  config: Config,
  locations: ProfileLocations,
): { config: Config; overriddenSocketName?: string } {
  if (
    locations.isDefault ||
    config.runtimes.tmux_socket_name === locations.tmuxSocketName
  ) {
    return { config };
  }
  return {
    config: {
      ...config,
      runtimes: {
        ...config.runtimes,
        tmux_socket_name: locations.tmuxSocketName,
      },
    },
    overriddenSocketName: config.runtimes.tmux_socket_name,
  };
}

export function defaultTerminalLight(): TerminalPalette {
  return {
    background: "#FFFFFF",
    foreground: "#202020",
    cursor: "#202020",
    cursorText: "#FFFFFF",
    selectionBackground: "#BFD9F2",
    selectionForeground: "#202020",
    ansi: [
      "#202020",
      "#cf222e",
      "#116329",
      "#B69500",
      "#0550ae",
      "#8250df",
      "#0069CC",
      "#606060",
      "#606060",
      "#ad0707",
      "#1a7f37",
      "#9a6700",
      "#0969da",
      "#6639ba",
      "#1f6feb",
      "#1f2328",
    ],
  };
}

export function defaultTerminalDark(): TerminalPalette {
  return {
    background: "#121314",
    foreground: "#BBBEBF",
    cursor: "#BBBEBF",
    cursorText: "#121314",
    selectionBackground: "#245C73",
    selectionForeground: "#BBBEBF",
    ansi: [
      "#555555",
      "#ff7b72",
      "#7ee787",
      "#e5ba7d",
      "#79c0ff",
      "#d2a8ff",
      "#3994BC",
      "#BBBEBF",
      "#8C8C8C",
      "#f48771",
      "#72C892",
      "#ffa657",
      "#48A0C7",
      "#B267E6",
      "#53A5CA",
      "#ededed",
    ],
  };
}

export function defaultAppearance(): AppearanceConfig {
  return {
    mode: "auto",
    terminalFontFamily: DEFAULT_FONT_FAMILY,
    terminalFontSize: 13,
    terminalLineHeight: 1.2,
    sidebarDensity: "compact",
    terminalMargin: 4,
    terminalTheme: {
      light: defaultTerminalLight(),
      dark: defaultTerminalDark(),
    },
  };
}

export function defaultRuntimes(): RuntimeConfig {
  return {
    shell: DEFAULT_SHELL,
    git: DEFAULT_GIT,
    tmux: DEFAULT_TMUX,
    tmux_socket_name: DEFAULT_TMUX_SOCKET,
    tmux_args: [],
  };
}

/**
 * Where DevHub looks for a workspace when nobody has said: nowhere.
 *
 * Empty, and deliberately. Every default this ever had was one person's
 * layout — a program that prints today's folder, `~/dev`, `~/workspace/work` —
 * and none of them is true of the next machine. A source whose root is not
 * there is a source that *fails*, so a shipped guess does not degrade into
 * silence; it opens a new installation's first picker onto errors about folders
 * the person has never heard of.
 *
 * There is no guess that is better than no guess here, because where somebody
 * keeps their projects is not something DevHub can work out. So the picker
 * starts with the two things that do not need to be configured — New Project
 * and Clone Project — and says, where the list would be, that no sources have
 * been added yet. That sentence is the default: it asks the one question DevHub
 * cannot answer, at the moment the answer would be useful.
 *
 * A person who wants today's dated folder or a walk of their home directory has
 * both available (`type = "date"`, `type = "filesystem"`); what changed is that
 * DevHub no longer assumes it.
 */
export function defaultWorkspaceSources(): WorkspaceSource[] {
  return [];
}

export function defaultAgentProfiles(): ConfiguredAgentProfile[] {
  return [
    {
      id: "codex",
      display_name: "Codex",
      kind: "codex",
      command: "codex",
      args: [],
      env: {},
    },
    {
      id: "claude",
      display_name: "Claude",
      kind: "claude",
      command: "claude",
      args: [],
      env: {},
    },
    // Cursor has a manifest now, so `custom` — which used to be the truthful
    // kind here, because DevHub had no idea what a Cursor screen looked like —
    // would understate what DevHub can say. `cursor` reads the two states the
    // manifest is confident about: a turn running, and a turn stopped to ask.
    //
    // What it still will not say is `idle`. The manifest has no idle rule (see
    // `agent/detect/manifests.ts` for why, and why that is the safe direction),
    // so a Cursor row shows `working`, `waiting`, or `?`, and the injection
    // queue — which sends only on `idle` — never types into a Cursor pane. The
    // change from `custom` is therefore strictly additive: rows that used to be
    // permanently `?` now light up while Cursor is busy or asking, and nothing
    // that was previously not sent starts being sent.
    //
    // The command is `cursor-agent` and nothing checks for it here. A profile
    // naming a command that is not installed already fails where it is run,
    // visibly, and a second check at the point the default is written would be
    // the same question answered twice — differently, the first time somebody
    // installs it while DevHub is open.
    {
      id: "cursor",
      display_name: "Cursor",
      kind: "cursor",
      command: "cursor-agent",
      args: [],
      env: {},
    },
  ];
}

/**
 * The actions DevHub ships: the Issue flow's, and one per shortcut button.
 *
 * Defaults, not a fixed set. What fires an action is DevHub's and what it says
 * is the person's, and this list is where the second half starts — so a file
 * that mentions no actions has none, which is somebody who has decided DevHub
 * should say nothing. An action whose id DevHub does not ship is an Issue
 * action, which is how "implement it" and "review it" both get somewhere to be
 * chosen from.
 */
export function defaultAgentActions(): ConfiguredAgentAction[] {
  const seen = new Map<AgentActionTrigger, number>();
  return BUILT_IN_ACTIONS.map((action) => {
    const order = seen.get(action.trigger) ?? 0;
    seen.set(action.trigger, order + 1);
    return {
      trigger: action.trigger,
      id: action.id,
      display_name: action.displayName,
      template: action.template,
      confirm_before_send: true,
      enabled: true,
      // Position within its own trigger, which is what `order` means
      // everywhere. See `overlay`.
      order,
    };
  });
}

export function defaultConfig(): Config {
  return {
    version: CONFIG_SCHEMA_VERSION,
    general: { import_login_environment: true },
    runtimes: defaultRuntimes(),
    appearance: defaultAppearance(),
    workspaceSources: defaultWorkspaceSources(),
    agentProfiles: defaultAgentProfiles(),
    agentActions: defaultAgentActions(),
  };
}

export type ValidationCode =
  | "io"
  | "state_unavailable"
  | "invalid_utf8"
  | "parse"
  | "missing_required_field"
  | "unknown_key"
  | "invalid_type"
  | "unsupported_version"
  | "invalid_string"
  | "invalid_id"
  | "duplicate_identity"
  | "invalid_runtime"
  | "invalid_socket_name"
  | "forbidden_tmux_argument"
  | "invalid_appearance"
  | "invalid_font_family"
  | "invalid_workspace_path"
  | "invalid_workspace_depth"
  | "invalid_workspace_kind"
  | "invalid_date_template"
  | "invalid_exclusion"
  | "invalid_command"
  | "invalid_timeout"
  | "invalid_profile"
  | "invalid_profile_kind"
  | "invalid_environment_key"
  | "conflict"
  | "serialization";

export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

/**
 * Which of the two files a problem is in.
 *
 * Worth carrying because the fix differs: a broken `settings.local.toml` is
 * fixed here, while a broken `settings.toml` is fixed in the dotfiles
 * repository it is a symlink into — and telling a person only that "the
 * settings are broken" sends them to open the wrong file first.
 */
export type ConfigScope = "global" | "local";

export interface ConfigDiagnostic {
  readonly code: ValidationCode;
  readonly path?: string;
  readonly location?: SourceLocation;
  readonly scope?: ConfigScope;
}

export class ConfigError extends Error {
  constructor(
    readonly diagnostic: ConfigDiagnostic,
    readonly expectedRevision?: string,
    readonly actualRevision?: string,
  ) {
    super(
      diagnostic.path
        ? `CONFIG_${diagnostic.code} at ${diagnostic.path}`
        : `CONFIG_${diagnostic.code}`,
    );
    this.name = "ConfigError";
  }

  get code(): ValidationCode {
    return this.diagnostic.code;
  }
}

function fail(
  code: ValidationCode,
  path?: string,
  location?: SourceLocation,
): never {
  throw new ConfigError({ code, path, location });
}

/**
 * The identity of a file's exact bytes. A save carries the revision it was
 * started from, so an edit made in another window (or in an editor) is a
 * refusal rather than a silent overwrite.
 */
export type ContentRevision = string;

export function contentRevision(bytes: Buffer | string): ContentRevision {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface LoadedConfig {
  readonly config: Config;
  readonly revision: ContentRevision;
}

export type ReloadOutcome =
  | { readonly kind: "unchanged"; readonly revision: ContentRevision }
  | { readonly kind: "applied"; readonly loaded: LoadedConfig };

// --------------------------------------------------------------- validation

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys a past DevHub read and this one does not, with why they went.
 *
 * An unknown key is an error on purpose: a typo must not be quietly ignored.
 * But a key DevHub itself told people to write is not their typo, and refusing
 * to start over one would make DevHub's own change of mind their problem. So a
 * retired key loads, is ignored, and says so once at info level — loud enough
 * that "I set that and nothing happened" has an answer, quiet enough that it
 * is not a failure. The next save drops it from the document, because a save
 * states the whole config and this is no longer part of it.
 */
const RETIRED_KEYS: Readonly<Record<string, string>> = {
  "appearance.color_scheme":
    "the shell follows the active VS Code theme, so DevHub has no colour scheme of its own; to choose light or dark for DevHub itself, use `appearance.mode`",
  "runtimes.herdr":
    "an Agent is now a tmux session on DevHub's own socket, so there is no separate Agent runtime to point at; the program to run is each profile's own `command`",
};

function checkKeys(
  table: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): void {
  for (const key of Object.keys(table)) {
    if (allowed.includes(key)) continue;
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    const retired = RETIRED_KEYS[path];
    if (retired !== undefined) {
      console.info(
        `[devhub] config: ${path} is no longer used and is ignored — ${retired}. The next save drops it from the file.`,
      );
      continue;
    }
    fail("unknown_key", path);
  }
}

function requireTable(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail("invalid_type", path);
  }
  return value;
}

function optionalString(
  table: Record<string, unknown>,
  key: string,
  path: string,
  fallback: string,
): string {
  const value = table[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") fail("invalid_type", `${path}.${key}`);
  return value;
}

/**
 * A string the document must carry. Absence is a missing field, not a default:
 * there is no value DevHub could supply that would be the author's intent.
 */
function requiredString(
  table: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = table[key];
  if (value === undefined) fail("missing_required_field", `${path}.${key}`);
  if (typeof value !== "string") fail("invalid_type", `${path}.${key}`);
  return value;
}

function optionalNumber(
  table: Record<string, unknown>,
  key: string,
  path: string,
  fallback: number,
): number {
  const value = table[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number") fail("invalid_type", `${path}.${key}`);
  return value;
}

function optionalBoolean(
  table: Record<string, unknown>,
  key: string,
  path: string,
  fallback: boolean,
): boolean {
  const value = table[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail("invalid_type", `${path}.${key}`);
  return value;
}

function optionalStringArray(
  table: Record<string, unknown>,
  key: string,
  path: string,
  fallback: readonly string[],
): string[] {
  const value = table[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail("invalid_type", `${path}.${key}`);
  }
  return value as string[];
}

const PALETTE_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursor_text",
  "selection_background",
  "selection_foreground",
  "ansi",
] as const;

function paletteFromTable(
  value: unknown,
  path: string,
  fallback: TerminalPalette,
): TerminalPalette {
  const table = requireTable(value, path);
  checkKeys(table, PALETTE_KEYS, path);
  return {
    background: optionalString(table, "background", path, fallback.background),
    foreground: optionalString(table, "foreground", path, fallback.foreground),
    cursor: optionalString(table, "cursor", path, fallback.cursor),
    cursorText: optionalString(table, "cursor_text", path, fallback.cursorText),
    selectionBackground: optionalString(
      table,
      "selection_background",
      path,
      fallback.selectionBackground,
    ),
    selectionForeground: optionalString(
      table,
      "selection_foreground",
      path,
      fallback.selectionForeground,
    ),
    ansi: optionalStringArray(table, "ansi", path, fallback.ansi),
  };
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function paletteIsValid(palette: TerminalPalette): boolean {
  return (
    palette.ansi.length === 16 &&
    [
      palette.background,
      palette.foreground,
      palette.cursor,
      palette.cursorText,
      palette.selectionBackground,
      palette.selectionForeground,
      ...palette.ansi,
    ].every(isHexColor)
  );
}

export function isValidSocketName(value: string): boolean {
  return (
    value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(value)
  );
}

export function isSafeTmuxArgument(argument: string): boolean {
  return argument === "-u" || argument === "-2";
}

function isEnvironmentName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function validateId(id: string, path: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) {
    fail("invalid_id", path);
  }
}

function validatePath(path: string, key: string): void {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path === "~user" ||
    (!path.startsWith("/") && path !== "~" && !path.startsWith("~/"))
  ) {
    fail("invalid_workspace_path", key);
  }
}

function validateRuntimes(runtimes: RuntimeConfig): void {
  for (const [key, value] of [
    ["shell", runtimes.shell],
    ["git", runtimes.git],
    ["tmux", runtimes.tmux],
  ] as const) {
    if (value.includes("\0")) {
      fail("invalid_string", `runtimes.${key}`);
    }
    const valid =
      value.startsWith("/") ||
      value === "~" ||
      value.startsWith("~/") ||
      (value.length > 0 && !value.includes("/"));
    if (!valid) {
      fail("invalid_runtime", `runtimes.${key}`);
    }
  }
  if (!isValidSocketName(runtimes.tmux_socket_name)) {
    fail("invalid_socket_name", "runtimes.tmux_socket_name");
  }
  runtimes.tmux_args.forEach((argument, index) => {
    if (argument.includes("\0")) {
      fail("invalid_string", `runtimes.tmux_args[${String(index)}]`);
    }
    if (!isSafeTmuxArgument(argument)) {
      fail("forbidden_tmux_argument", `runtimes.tmux_args[${String(index)}]`);
    }
  });
}

function validateAppearance(appearance: AppearanceConfig): void {
  // Named on its own, and by the key it came from: a font family is the one
  // value in this table a person types freely, so a refusal that says only
  // "appearance" is a refusal they cannot act on.
  if (!isValidFontFamily(appearance.terminalFontFamily)) {
    fail("invalid_font_family", "appearance.terminal_font_family");
  }
  if (
    appearance.terminalFontSize < 9 ||
    appearance.terminalFontSize > 24 ||
    !Number.isFinite(appearance.terminalLineHeight) ||
    appearance.terminalLineHeight < 1 ||
    appearance.terminalLineHeight > 2 ||
    !APPEARANCE_MODES.includes(appearance.mode) ||
    (appearance.sidebarDensity !== "compact" &&
      appearance.sidebarDensity !== "comfortable") ||
    appearance.terminalMargin > MAX_TERMINAL_MARGIN ||
    !paletteIsValid(appearance.terminalTheme.light) ||
    !paletteIsValid(appearance.terminalTheme.dark)
  ) {
    fail("invalid_appearance", "appearance");
  }
}

function validateWorkspaceSources(sources: readonly WorkspaceSource[]): void {
  const seen = new Map<string, number>();
  sources.forEach((source, index) => {
    const prefix = `workspace_sources[${String(index)}]`;
    const previous = seen.get(source.id);
    if (previous !== undefined) {
      fail("duplicate_identity", `${prefix}.id (also ${String(previous)})`);
    }
    seen.set(source.id, index);
    validateId(source.id, `${prefix}.id`);
    if (source.type === "filesystem") {
      validatePath(source.path, `${prefix}.path`);
      const maxDepth = source.max_depth ?? source.min_depth;
      if (maxDepth < source.min_depth || maxDepth > 16) {
        fail("invalid_workspace_depth", `${prefix}.max_depth`);
      }
      if (source.kinds.length === 0) {
        fail("invalid_workspace_kind", `${prefix}.kinds`);
      }
      const hasDirectory = source.kinds.includes("directory");
      const hasGit = source.kinds.some(
        (kind) => kind === "git_repository" || kind === "git_worktree",
      );
      if (hasDirectory && hasGit) {
        fail("invalid_workspace_kind", `${prefix}.kinds`);
      }
      source.exclude_names.forEach((name, excludeIndex) => {
        if (
          name.length === 0 ||
          name.includes("\0") ||
          name.includes("/") ||
          name.includes("\\") ||
          /[*?[\]{}]/.test(name)
        ) {
          fail(
            "invalid_exclusion",
            `${prefix}.exclude_names[${String(excludeIndex)}]`,
          );
        }
      });
    } else if (source.type === "date") {
      validatePath(source.path, `${prefix}.path`);
      // The one thing about a template that can be wrong without knowing what
      // day it is. Taking the rest of the path literally instead would offer a
      // folder nobody named, on a path nobody would recognise as the mistake.
      if (!dateTemplateBracketsBalance(source.path)) {
        fail("invalid_date_template", `${prefix}.path`);
      }
    } else {
      if (
        source.command.length === 0 ||
        source.command.some((argument) => argument.includes("\0"))
      ) {
        fail("invalid_command", `${prefix}.command`);
      }
      if (source.timeout_ms < 100 || source.timeout_ms > 30000) {
        fail("invalid_timeout", `${prefix}.timeout_ms`);
      }
    }
  });
}

/**
 * The actions, as a set rather than one at a time.
 *
 * Ids follow the same rule every other identifier in this file follows, because
 * they are the same kind of thing: what the config calls an entry, and what the
 * flow's answer names. Two actions with one id would make the flow's answer
 * ambiguous, so the second is refused the way a duplicate source is.
 */
function validateAgentActions(actions: readonly ConfiguredAgentAction[]): void {
  const seen = new Map<string, number>();
  actions.forEach((action, index) => {
    const prefix = `agent_actions[${String(index)}]`;
    const previous = seen.get(action.id);
    if (previous !== undefined) {
      fail("duplicate_identity", `${prefix}.id (also ${String(previous)})`);
    }
    seen.set(action.id, index);
    validateId(action.id, `${prefix}.id`);
    // A nameless action is a row in the flow with nothing written on it.
    if (action.display_name.trim().length === 0) {
      fail("invalid_profile", `${prefix}.display_name`);
    }
  });
}

function validateAgentProfiles(
  profiles: readonly ConfiguredAgentProfile[],
): void {
  const seen = new Map<string, number>();
  profiles.forEach((profile, index) => {
    const prefix = `agent_profiles[${String(index)}]`;
    const previous = seen.get(profile.id);
    if (previous !== undefined) {
      fail("duplicate_identity", `${prefix}.id (also ${String(previous)})`);
    }
    seen.set(profile.id, index);
    validateId(profile.id, `${prefix}.id`);
    if (
      profile.display_name.trim().length === 0 ||
      profile.display_name.includes("\0")
    ) {
      fail("invalid_profile", `${prefix}.display_name`);
    }
    if (profile.command.trim().length === 0 || profile.command.includes("\0")) {
      fail("invalid_profile", `${prefix}.command`);
    }
    if (profile.args.some((argument) => argument.includes("\0"))) {
      fail("invalid_profile", `${prefix}.args`);
    }
    for (const [key, value] of Object.entries(profile.env)) {
      if (!isEnvironmentName(key)) {
        fail("invalid_environment_key", `${prefix}.env`);
      }
      if (value.includes("\0")) {
        fail("invalid_string", `${prefix}.env`);
      }
    }
  });
}

export function validateConfig(config: Config): void {
  if (config.version !== CONFIG_SCHEMA_VERSION) {
    fail("unsupported_version", "version");
  }
  validateRuntimes(config.runtimes);
  validateAppearance(config.appearance);
  validateWorkspaceSources(config.workspaceSources);
  validateAgentProfiles(config.agentProfiles);
  validateAgentActions(config.agentActions);
}

// ------------------------------------------------------------------ parsing

const TOP_LEVEL_KEYS = [
  "version",
  "general",
  "runtimes",
  "appearance",
  "workspace_sources",
  "agent_profiles",
  "agent_actions",
] as const;

function workspaceSourceFromTable(
  value: unknown,
  index: number,
): WorkspaceSource {
  const prefix = `workspace_sources[${String(index)}]`;
  const table = requireTable(value, prefix);
  const type = table["type"];
  if (type === "date") {
    checkKeys(table, ["id", "type", "path", "create_if_missing"], prefix);
    return {
      type: "date",
      id: optionalString(table, "id", prefix, ""),
      path: optionalString(table, "path", prefix, ""),
      create_if_missing: optionalBoolean(
        table,
        "create_if_missing",
        prefix,
        true,
      ),
    };
  }
  if (type === "command") {
    checkKeys(table, ["id", "type", "command", "timeout_ms"], prefix);
    return {
      type: "command",
      id: optionalString(table, "id", prefix, ""),
      command: optionalStringArray(table, "command", prefix, []),
      timeout_ms: optionalNumber(table, "timeout_ms", prefix, 2000),
    };
  }
  if (type === "filesystem") {
    checkKeys(
      table,
      [
        "id",
        "type",
        "path",
        "min_depth",
        "max_depth",
        "kinds",
        "include_hidden",
        "exclude_names",
      ],
      prefix,
    );
    const maxDepth = table["max_depth"];
    if (maxDepth !== undefined && typeof maxDepth !== "number") {
      fail("invalid_type", `${prefix}.max_depth`);
    }
    const kinds = optionalStringArray(table, "kinds", prefix, ["directory"]);
    for (const kind of kinds) {
      if (
        kind !== "directory" &&
        kind !== "git_repository" &&
        kind !== "git_worktree"
      ) {
        fail("invalid_workspace_kind", `${prefix}.kinds`);
      }
    }
    return {
      type: "filesystem",
      id: optionalString(table, "id", prefix, ""),
      path: optionalString(table, "path", prefix, ""),
      min_depth: optionalNumber(table, "min_depth", prefix, 0),
      max_depth: maxDepth as number | undefined,
      kinds: kinds as WorkspaceKind[],
      include_hidden: optionalBoolean(table, "include_hidden", prefix, false),
      exclude_names: optionalStringArray(
        table,
        "exclude_names",
        prefix,
        DEFAULT_EXCLUDE_NAMES,
      ),
    };
  }
  return fail("invalid_type", `${prefix}.type`);
}

/**
 * The actions, as the file spells them, over the ones DevHub ships.
 *
 * `[agent_actions.<trigger>.<id>]`, a table two deep. Tables and not an array
 * of tables, and that is the whole point of the shape: `settings.local.toml`
 * merges into `settings.toml` key by key for tables and *replaces whole* for
 * arrays (`model/settingsScopes.ts`), so the old array meant a local file that
 * had ever saved one action was a local file that had deleted every other —
 * including the three DevHub added afterwards, which is why nobody had commit,
 * push or pull-request buttons. Keyed tables cannot do that: a key somebody
 * writes is a key somebody wrote, and everything else is still there.
 *
 * Built-ins are the starting set rather than a list the file has to repeat.
 * A file that mentions none has all of them; a file that mentions one changes
 * that one; `enabled = false` is how one is taken away.
 */
/**
 * The actions, back out as `[agent_actions.<trigger>.<id>]`.
 *
 * Every action is written in full, including the ones DevHub ships unchanged.
 * The thinning-out is `subtractScope`'s job and it does it key by key against
 * whatever the shared file says, which is a different question from what
 * DevHub's defaults are — writing the defaults out here as absences would
 * answer the wrong one, and would put back the "a file that predates an action
 * deletes it" bug in a new place.
 */
function agentActionsToTable(
  actions: readonly ConfiguredAgentAction[],
): Record<string, TomlValue> {
  const table: Record<string, TomlValue> = {};
  for (const action of actions) {
    const group = (table[action.trigger] ??= {}) as Record<string, TomlValue>;
    // Counted before the entry is added, because the entry being written is
    // not one of the ones already there: reading the length inside the literal
    // below numbered the first action in every group -1.
    const position = Object.keys(group).length;
    group[action.id] = {
      display_name: action.display_name,
      template: action.template,
      confirm_before_send: action.confirm_before_send,
      enabled: action.enabled,
      // The position within its trigger, which is the only thing `order` ever
      // means. Writing the index in this flat list instead would make a file
      // that parsed back to a different arrangement than it was written from.
      order: position,
    };
  }
  return table;
}

function agentActionsFromValue(
  value: unknown,
  defaults: readonly ConfiguredAgentAction[],
): ConfiguredAgentAction[] {
  if (value === undefined) return [...defaults];
  // A file written before this shape existed. Every entry names its own id, and
  // the id is what says which action it was — so the trigger is recovered the
  // way it used to be inferred, and the built-ins the array had dropped come
  // back because the built-ins are no longer the array's to drop.
  if (Array.isArray(value)) {
    return overlay(defaults, value.map(legacyAgentAction));
  }
  const table = requireTable(value, "agent_actions");
  checkKeys(table, [...ACTION_TRIGGERS], "agent_actions");
  const written: ConfiguredAgentAction[] = [];
  for (const trigger of ACTION_TRIGGERS) {
    const raw = table[trigger];
    if (raw === undefined) continue;
    const group = requireTable(raw, `agent_actions.${trigger}`);
    for (const id of Object.keys(group)) {
      written.push(agentActionFromTable(group[id], trigger, id));
    }
  }
  return overlay(defaults, written);
}

/**
 * The shipped set, with the file's word over it, in a stable order.
 *
 * An id the file names that DevHub also ships is one action, changed. An id it
 * does not is one added, and it goes after everything with its trigger that was
 * there already — a new button appears at the end of the row rather than in the
 * middle of it. `order` moves either of them.
 */
function overlay(
  defaults: readonly ConfiguredAgentAction[],
  written: readonly ConfiguredAgentAction[],
): ConfiguredAgentAction[] {
  const merged = [...defaults];
  const taken = new Set<number>();
  for (const mine of written) {
    const at = merged.findIndex(
      (shipped, index) =>
        !taken.has(index) &&
        shipped.id === mine.id &&
        shipped.trigger === mine.trigger,
    );
    if (at === -1) {
      // Appended, not merged onto whatever happens to share its name. Two
      // entries with one id is a file that has to be refused, and an overlay
      // that quietly folded the second into the first would swallow the very
      // thing validation exists to catch.
      merged.push(mine);
      continue;
    }
    taken.add(at);
    merged[at] = mine;
  }
  // Grouped by trigger, and ordered within each group. Two separate facts, so
  // two separate steps: a single sort over the whole list would be comparing
  // positions that only mean anything within one group, which is not an
  // ordering at all and does not survive `Array.sort`.
  return ACTION_TRIGGERS.flatMap((trigger) =>
    merged
      .filter((action) => action.trigger === trigger)
      .map((action, index) => ({ action, index }))
      .sort((left, right) =>
        left.action.order === right.action.order
          ? left.index - right.index
          : left.action.order - right.action.order,
      )
      // Normalised, so `order` is always the position it means: the number a
      // file wrote is a request about where to sit, and what is kept is where
      // it ended up. Without this the same configuration would compare
      // unequal to itself across a save.
      .map((entry, position) => ({ ...entry.action, order: position })),
  );
}

/** One entry of the old `[[agent_actions]]` array. */
function legacyAgentAction(
  value: unknown,
  index: number,
): ConfiguredAgentAction {
  const prefix = `agent_actions[${String(index)}]`;
  const table = requireTable(value, prefix);
  checkKeys(
    table,
    ["id", "display_name", "template", "confirm_before_send"],
    prefix,
  );
  const id = optionalString(table, "id", prefix, "");
  return {
    trigger: triggerOf(id),
    id,
    display_name: optionalString(table, "display_name", prefix, ""),
    template: optionalString(table, "template", prefix, ""),
    confirm_before_send: optionalBoolean(
      table,
      "confirm_before_send",
      prefix,
      true,
    ),
    enabled: true,
    // After whatever DevHub ships under the same trigger, in the array's own
    // order. The old shape had no way to say where an action sat, so the only
    // honest answer is "where it was written".
    order: BUILT_IN_ACTIONS.length + index,
  };
}

function agentActionFromTable(
  value: unknown,
  trigger: AgentActionTrigger,
  id: string,
): ConfiguredAgentAction {
  const prefix = `agent_actions.${trigger}.${id}`;
  const table = requireTable(value, prefix);
  checkKeys(
    table,
    ["display_name", "template", "confirm_before_send", "enabled", "order"],
    prefix,
  );
  const shipped = BUILT_IN_ACTIONS.find((one) => one.id === id);
  return {
    trigger,
    id,
    // A built-in that is only being switched off, or reordered, does not have
    // to restate its own wording. Anything DevHub did not ship has no wording
    // to fall back on, so an empty name is a name and validation refuses it.
    display_name: optionalString(
      table,
      "display_name",
      prefix,
      shipped?.displayName ?? "",
    ),
    template: optionalString(
      table,
      "template",
      prefix,
      shipped?.template ?? "",
    ),
    // Absent means "show me the wording". Anybody who wants a template to go
    // straight out has said so; nobody is surprised by a sheet they did not
    // ask to be rid of.
    confirm_before_send: optionalBoolean(
      table,
      "confirm_before_send",
      prefix,
      true,
    ),
    enabled: optionalBoolean(table, "enabled", prefix, true),
    // An action DevHub ships keeps its shipped position; one somebody wrote
    // goes after everything shipped under that trigger, which is where a new
    // button belongs — at the end of the row, not in the middle of it.
    // An action DevHub ships keeps its shipped position; one somebody wrote
    // goes after everything shipped under that trigger, which is where a new
    // button belongs — at the end of the row, not in the middle of it.
    order: optionalNumber(
      table,
      "order",
      prefix,
      shipped === undefined
        ? BUILT_IN_ACTIONS.length
        : BUILT_IN_ACTIONS.filter(
            (one) => one.trigger === trigger && one !== shipped,
          ).length,
    ),
  };
}

function agentProfileFromTable(
  value: unknown,
  index: number,
): ConfiguredAgentProfile {
  const prefix = `agent_profiles[${String(index)}]`;
  const table = requireTable(value, prefix);
  checkKeys(
    table,
    ["id", "display_name", "kind", "command", "args", "env"],
    prefix,
  );
  const kind = table["kind"];
  if (
    kind !== "codex" &&
    kind !== "claude" &&
    kind !== "cursor" &&
    kind !== "custom"
  ) {
    fail("invalid_profile_kind", `${prefix}.kind`);
  }
  const rawEnv = table["env"];
  const env: Record<string, string> = {};
  if (rawEnv !== undefined) {
    const envTable = requireTable(rawEnv, `${prefix}.env`);
    for (const [key, entry] of Object.entries(envTable)) {
      if (typeof entry !== "string") {
        fail("invalid_type", `${prefix}.env.${key}`);
      }
      env[key] = entry;
    }
  }
  return {
    id: optionalString(table, "id", prefix, ""),
    display_name: optionalString(table, "display_name", prefix, ""),
    kind,
    // A known kind's command defaults to the program that kind runs — see
    // `defaultCommandForKind`, which is not always the kind's own name.
    // `custom` has no such program: the whole of what it says is "run this",
    // so it has to say it.
    command:
      kind === "custom"
        ? requiredString(table, "command", prefix)
        : optionalString(table, "command", prefix, defaultCommandForKind(kind)),
    args: optionalStringArray(table, "args", prefix, []),
    env,
  };
}

/**
 * What one file literally says, before any of it means anything.
 *
 * Kept apart from `interpretConfig` because a configuration is read from two
 * files, and the two have to be combined at exactly this point: after the TOML
 * is understood, before the defaults are filled in. Merge later — once each
 * side is a finished `Config` — and a default the local file never wrote is
 * indistinguishable from a value it did, so it wins over the shared file's real
 * one. See `settingsScopes.ts`.
 */
export function parseConfigText(input: string): Record<string, unknown> {
  try {
    return parseTomlValue(input);
  } catch (error) {
    throw new ConfigError({
      code: "parse",
      location:
        error instanceof TomlSyntaxError &&
        error.line !== undefined &&
        error.column !== undefined
          ? { line: error.line, column: error.column }
          : undefined,
    });
  }
}

/** Decode one config document. Anything the shape does not allow throws. */
export function parseConfig(input: string): Config {
  return interpretConfig(parseConfigText(input));
}

/** The same, from a table that has already been read (and possibly merged). */
export function interpretConfig(document: unknown): Config {
  const table = requireTable(document, "");
  checkKeys(table, TOP_LEVEL_KEYS, "");

  const defaults = defaultConfig();
  const version = optionalNumber(table, "version", "", 0);

  const generalTable = requireTable(table["general"] ?? {}, "general");
  checkKeys(generalTable, ["import_login_environment"], "general");

  const runtimesTable = requireTable(table["runtimes"] ?? {}, "runtimes");
  checkKeys(
    runtimesTable,
    ["shell", "git", "tmux", "tmux_socket_name", "tmux_args"],
    "runtimes",
  );

  const appearanceTable = requireTable(table["appearance"] ?? {}, "appearance");
  checkKeys(
    appearanceTable,
    [
      "mode",
      "terminal_font_family",
      "terminal_font_size",
      "terminal_line_height",
      "sidebar_density",
      "terminal_margin",
      "terminal_theme",
    ],
    "appearance",
  );
  const themeTable = requireTable(
    appearanceTable["terminal_theme"] ?? {},
    "appearance.terminal_theme",
  );
  checkKeys(themeTable, ["light", "dark"], "appearance.terminal_theme");

  const rawSources = table["workspace_sources"];
  if (rawSources !== undefined && !Array.isArray(rawSources)) {
    fail("invalid_type", "workspace_sources");
  }
  const rawProfiles = table["agent_profiles"];
  if (rawProfiles !== undefined && !Array.isArray(rawProfiles)) {
    fail("invalid_type", "agent_profiles");
  }

  const config: Config = {
    version,
    general: {
      import_login_environment: optionalBoolean(
        generalTable,
        "import_login_environment",
        "general",
        true,
      ),
    },
    runtimes: {
      shell: optionalString(runtimesTable, "shell", "runtimes", DEFAULT_SHELL),
      git: optionalString(runtimesTable, "git", "runtimes", DEFAULT_GIT),
      tmux: optionalString(runtimesTable, "tmux", "runtimes", DEFAULT_TMUX),
      tmux_socket_name: optionalString(
        runtimesTable,
        "tmux_socket_name",
        "runtimes",
        DEFAULT_TMUX_SOCKET,
      ),
      tmux_args: optionalStringArray(
        runtimesTable,
        "tmux_args",
        "runtimes",
        [],
      ),
    },
    appearance: {
      terminalFontFamily: optionalString(
        appearanceTable,
        "terminal_font_family",
        "appearance",
        DEFAULT_FONT_FAMILY,
      ),
      terminalFontSize: optionalNumber(
        appearanceTable,
        "terminal_font_size",
        "appearance",
        13,
      ),
      terminalLineHeight: optionalNumber(
        appearanceTable,
        "terminal_line_height",
        "appearance",
        1.2,
      ),
      mode: optionalString(appearanceTable, "mode", "appearance", "auto"),
      sidebarDensity: optionalString(
        appearanceTable,
        "sidebar_density",
        "appearance",
        "compact",
      ),
      terminalMargin: optionalNumber(
        appearanceTable,
        "terminal_margin",
        "appearance",
        4,
      ),
      terminalTheme: {
        light: paletteFromTable(
          themeTable["light"] ?? {},
          "appearance.terminal_theme.light",
          defaultTerminalLight(),
        ),
        dark: paletteFromTable(
          themeTable["dark"] ?? {},
          "appearance.terminal_theme.dark",
          defaultTerminalDark(),
        ),
      },
    },
    workspaceSources:
      rawSources === undefined
        ? defaults.workspaceSources
        : rawSources.map(workspaceSourceFromTable),
    agentProfiles:
      rawProfiles === undefined
        ? defaults.agentProfiles
        : rawProfiles.map(agentProfileFromTable),
    // The file's word over the actions DevHub ships, rather than in place of
    // them. See `agentActionsFromValue` for why that is the difference between
    // a configuration that keeps working when DevHub adds an action and one
    // that silently loses it.
    agentActions: agentActionsFromValue(
      table["agent_actions"],
      defaults.agentActions,
    ),
  };

  validateConfig(config);
  return config;
}

/**
 * One workspace source, as the file spells it.
 *
 * A function with a switch rather than a chain of conditionals in the middle of
 * `configDocument`: each kind's keys are written out in one place, and adding a
 * fourth kind is a case rather than another branch nested inside two others.
 */
function sourceToTable(source: WorkspaceSource): Record<string, TomlValue> {
  switch (source.type) {
    case "date":
      return {
        type: source.type,
        id: source.id,
        path: source.path,
        create_if_missing: source.create_if_missing,
      };
    case "command":
      return {
        type: source.type,
        id: source.id,
        command: [...source.command],
        timeout_ms: source.timeout_ms,
      };
    case "filesystem":
      return {
        type: source.type,
        id: source.id,
        path: source.path,
        min_depth: source.min_depth,
        ...(source.max_depth === undefined
          ? {}
          : { max_depth: source.max_depth }),
        kinds: [...source.kinds],
        include_hidden: source.include_hidden,
        exclude_names: [...source.exclude_names],
      };
  }
}

/** The on-disk shape of a config: what the file is expected to say. */
export function configDocument(config: Config): Record<string, TomlValue> {
  return {
    version: config.version,
    general: {
      import_login_environment: config.general.import_login_environment,
    },
    runtimes: {
      shell: config.runtimes.shell,
      git: config.runtimes.git,
      tmux: config.runtimes.tmux,
      tmux_socket_name: config.runtimes.tmux_socket_name,
      tmux_args: [...config.runtimes.tmux_args],
    },
    appearance: {
      mode: config.appearance.mode,
      terminal_font_family: config.appearance.terminalFontFamily,
      terminal_font_size: config.appearance.terminalFontSize,
      terminal_line_height: config.appearance.terminalLineHeight,
      sidebar_density: config.appearance.sidebarDensity,
      terminal_margin: config.appearance.terminalMargin,
      terminal_theme: {
        light: paletteToTable(config.appearance.terminalTheme.light),
        dark: paletteToTable(config.appearance.terminalTheme.dark),
      },
    },
    workspace_sources: config.workspaceSources.map(sourceToTable),
    agent_actions: agentActionsToTable(config.agentActions),
    agent_profiles: config.agentProfiles.map((profile) => ({
      id: profile.id,
      display_name: profile.display_name,
      kind: profile.kind,
      command: profile.command,
      args: [...profile.args],
      env: { ...profile.env },
    })),
  } as Record<string, TomlValue>;
}

/** A whole document, for when there is no file to preserve. */
export function configToToml(config: Config): string {
  validateConfig(config);
  return renderTomlDocument(configDocument(config));
}

/**
 * The same config, written over the document that is already on disk.
 *
 * Only the values that differ are replaced. A config the person hand-wrote
 * comes back looking like the one they hand-wrote.
 */
export function configOntoDocument(source: string, config: Config): string {
  validateConfig(config);
  return updateTomlDocument(source, configDocument(config));
}

function paletteToTable(palette: TerminalPalette) {
  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursor,
    cursor_text: palette.cursorText,
    selection_background: palette.selectionBackground,
    selection_foreground: palette.selectionForeground,
    ansi: [...palette.ansi],
  };
}

// -------------------------------------------------------------------- store

function ioError(error: unknown, scope?: ConfigScope): ConfigError {
  if (
    error instanceof Error &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  ) {
    return new ConfigError({ code: "io", path: "ENOENT", scope });
  }
  return new ConfigError({ code: "io", scope });
}

/** The same error, said about a particular file. */
function inScope(error: unknown, scope: ConfigScope): unknown {
  return error instanceof ConfigError
    ? new ConfigError(
        { ...error.diagnostic, scope },
        error.expectedRevision,
        error.actualRevision,
      )
    : error;
}

/**
 * Whether this scope is the one that spelled the value a diagnostic names.
 *
 * A validation failure happens on the merged table, which belongs to neither
 * file, so the file to blame has to be found again from the key path. The walk
 * stops at the first thing that is not a table, because a scope that supplies
 * an array supplies all of it (see `settingsScopes.ts`) — a complaint about
 * `workspace_sources[2].path` is a complaint about whoever wrote the list.
 */
function definesPath(table: Readonly<Record<string, unknown>>, path: string) {
  let current: unknown = table;
  for (const segment of path.split(".")) {
    // `runtimes.tmux_args[0]` names a key; so does `[1].id (also 0)`.
    const key = segment.replace(/\[.*$/, "").replace(/ .*$/, "");
    if (key === "") {
      return true;
    }
    if (!isPlainObject(current) || !(key in current)) {
      return false;
    }
    current = current[key];
    if (!isPlainObject(current)) {
      return true;
    }
  }
  return true;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

/**
 * The one owner of DevHub's settings files in this process.
 *
 * There are two of them — `settings.toml`, shared and read-only here, and
 * `settings.local.toml`, this machine's and the only one DevHub writes — and
 * the store's job is that nothing above it has to know that. `load` adopts
 * them; `reload` adopts newer ones, or keeps the last good config and records
 * the diagnostic; `save` writes the local file atomically and only over the
 * revision it was given. A revision names the pair, so an edit to *either*
 * file underneath an open Settings window is the refusal it always was.
 */
/**
 * The parts of a configuration a screen can be put back to its defaults.
 *
 * Named by their `Config` property, because that is what a reset acts on. The
 * mapping from a screen to the names it owns lives with the screens; nothing
 * here knows what a "section" is.
 */
export type ConfigScopeKey =
  | "general"
  | "runtimes"
  | "appearance"
  | "workspaceSources"
  | "agentProfiles"
  | "agentActions";

export class ConfigStore {
  private active: LoadedConfig | undefined;
  private diagnostic: ConfigDiagnostic | undefined;
  /** The shared file as last read, to subtract the next save against. */
  private globalRaw: Readonly<Record<string, unknown>> = {};

  constructor(readonly paths: ConfigPaths) {}

  async load(): Promise<LoadedConfig> {
    await this.adoptLegacyFile();
    let scopes: ScopeText;
    try {
      scopes = await this.read();
    } catch (error) {
      if (!(error instanceof ConfigError && error.code === "io")) {
        throw error;
      }
      if (error.diagnostic.path !== "ENOENT") {
        throw error;
      }
      // No local file yet. Write down the defaults the shared file does not
      // already give — which is all of them when there is no shared file, and
      // none of them when it happens to give everything.
      const global = await this.readGlobal();
      const globalRaw =
        global === undefined ? {} : this.parseScope(global, "global");
      const text = renderTomlDocument(
        subtractScope(configDocument(defaultConfig()), globalRaw),
      );
      await this.atomicWrite(text);
      scopes = { global, local: text };
    }
    const loaded = this.decode(scopes);
    this.active = loaded;
    this.diagnostic = undefined;
    return loaded;
  }

  async reload(): Promise<ReloadOutcome> {
    let scopes: ScopeText;
    try {
      scopes = await this.read();
    } catch (error) {
      if (error instanceof ConfigError) {
        this.diagnostic = error.diagnostic;
      }
      throw error;
    }
    const revision = scopeRevision(scopes);
    if (this.active?.revision === revision) {
      return { kind: "unchanged", revision };
    }
    let loaded: LoadedConfig;
    try {
      loaded = this.decode(scopes);
    } catch (error) {
      if (error instanceof ConfigError) {
        this.diagnostic = error.diagnostic;
      }
      throw error;
    }
    this.active = loaded;
    this.diagnostic = undefined;
    return { kind: "applied", loaded };
  }

  current(): LoadedConfig | undefined {
    return this.active;
  }

  lastDiagnostic(): ConfigDiagnostic | undefined {
    return this.diagnostic;
  }

  /**
   * Write a whole configuration down as the part of it that is local.
   *
   * The Settings window edits everything at once, so what arrives here is the
   * complete config — but writing all of it locally would shadow the shared
   * file entirely on the first save and never read it again. So the shared
   * file's answers are subtracted first, and only what is left is written.
   *
   * The shared file is never written. It is somebody's dotfiles repository,
   * usually reached through a symlink, and a DevHub that wrote to it would be
   * committing to that repository on a person's behalf. Moving a setting into
   * it stays a thing a person (or an agent) does deliberately.
   */
  async save(
    expectedRevision: ContentRevision,
    config: Config,
  ): Promise<LoadedConfig> {
    validateConfig(config);
    const scopes = await this.read();
    const actual = scopeRevision(scopes);
    if (actual !== expectedRevision) {
      throw new ConfigError({ code: "conflict" }, expectedRevision, actual);
    }
    const globalRaw =
      scopes.global === undefined
        ? {}
        : this.parseScope(scopes.global, "global");
    // Written over the document that is there, not in place of it: the file
    // keeps its comments, its grouping and its order.
    const output = updateTomlDocument(
      scopes.local,
      subtractScope(configDocument(config), globalRaw),
    );
    const written: ScopeText = { global: scopes.global, local: output };
    const loaded = this.decode(written);
    await this.atomicWrite(output, contentRevision(scopes.local));
    this.active = loaded;
    this.diagnostic = undefined;
    return loaded;
  }

  /**
   * Put part of the configuration back to what it would be without this
   * machine's file.
   *
   * "Reset this screen" means one thing, and this is it: take the local file's
   * word out of the picture for these keys and keep whatever is left — the
   * shared file's answer if it has one, DevHub's default if it does not. It is
   * *not* "write the defaults down", which would look identical the moment you
   * pressed it and then quietly stop tracking a shared file that changed.
   *
   * It is written as an ordinary save because it is one. `subtractScope` drops
   * a key whose value the shared file already gives, so handing back the
   * shared-and-default answer is exactly what removes it from the local file —
   * one mechanism for "this is not mine to say", not two.
   */
  async resetScope(
    expectedRevision: ContentRevision,
    keys: readonly ConfigScopeKey[],
  ): Promise<LoadedConfig> {
    const scopes = await this.read();
    const globalRaw =
      scopes.global === undefined
        ? {}
        : this.parseScope(scopes.global, "global");
    const current = this.decode(scopes).config;
    // What the settings would say with this machine's file taken away: the
    // shared file alone, read as a whole document. `version` is supplied
    // rather than read, because it is not one of the answers a scope holds —
    // it names the schema *a file* is written in, and the shared file need not
    // state it or exist at all. Reading it off an absent shared file said
    // version 0, and every reset on a machine without one failed outright.
    const withoutLocal = interpretConfig({
      ...globalRaw,
      version: CONFIG_SCHEMA_VERSION,
    });
    const reset = { ...current };
    for (const key of keys) {
      // One assignment per key rather than a switch: every scope key names a
      // property of `Config` with the same name, which is what makes "reset
      // this screen" a list of names instead of a method per screen.
      (reset as Record<string, unknown>)[key] = withoutLocal[key];
    }
    return this.save(expectedRevision, reset);
  }

  /**
   * Notice an edit made outside the app.
   *
   * The Rust polled on a thread; here it is a timer on the main process. Both
   * are polling: a config file is edited by a person, not by a hot loop, and a
   * watcher that has to be correct across editors that write-and-rename is more
   * machinery than the cost of a stat every few seconds.
   */
  watch(
    intervalMs: number,
    callback: (outcome: ReloadOutcome | ConfigDiagnostic) => void,
  ): () => void {
    const interval = Math.max(10, intervalMs);
    const timer = setInterval(() => {
      void this.reload().then(
        (outcome) => {
          if (outcome.kind === "applied") {
            callback(outcome);
          }
        },
        (error: unknown) => {
          callback(
            error instanceof ConfigError
              ? error.diagnostic
              : { code: "io" as const },
          );
        },
      );
    }, interval);
    // A config poll must never be the reason the process stays alive.
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => {
      clearInterval(timer);
    };
  }

  /** The shared file's text, or `undefined` when there is not one. */
  private async readGlobal(): Promise<string | undefined> {
    try {
      return decodeUtf8(await readFile(this.paths.global), "global");
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error instanceof ConfigError ? error : ioError(error, "global");
    }
  }

  /** Both files as text. A missing local file is the `ENOENT` io error. */
  private async read(): Promise<ScopeText> {
    const global = await this.readGlobal();
    let local: string;
    try {
      local = decodeUtf8(await readFile(this.paths.local), "local");
    } catch (error) {
      throw error instanceof ConfigError ? error : ioError(error, "local");
    }
    return { global, local };
  }

  private parseScope(
    text: string,
    scope: ConfigScope,
  ): Readonly<Record<string, unknown>> {
    try {
      return parseConfigText(text);
    } catch (error) {
      throw inScope(error, scope);
    }
  }

  /**
   * The two files, read as one configuration.
   *
   * They are merged as raw tables and interpreted once, rather than each being
   * interpreted and the results combined — see `parseConfigText`. A validation
   * failure therefore belongs to the merged table, so the file to blame is
   * looked up again from the key path the failure names.
   */
  private decode(scopes: ScopeText): LoadedConfig {
    const globalRaw =
      scopes.global === undefined
        ? {}
        : this.parseScope(scopes.global, "global");
    const localRaw = this.parseScope(scopes.local, "local");
    let config: Config;
    try {
      config = interpretConfig(mergeScopes(globalRaw, localRaw));
    } catch (error) {
      const path =
        error instanceof ConfigError ? error.diagnostic.path : undefined;
      throw path === undefined
        ? error
        : inScope(
            error,
            definesPath(localRaw, path) || !definesPath(globalRaw, path)
              ? "local"
              : "global",
          );
    }
    this.globalRaw = globalRaw;
    return { config, revision: scopeRevision(scopes) };
  }

  /** The keys the shared file answers, for a window that wants to say so. */
  sharedKeys(): Readonly<Record<string, unknown>> {
    return this.globalRaw;
  }

  /**
   * Take the pre-split `config.toml` over as this machine's local file.
   *
   * A rename rather than a copy, and only when there is no local file yet:
   * either the old file is the local one now or it is gone, so there is never
   * a moment where two files both look like the settings and DevHub is quietly
   * reading one of them.
   */
  private async adoptLegacyFile(): Promise<void> {
    const legacy = this.paths.legacy;
    if (legacy === undefined) {
      return;
    }
    const present = await stat(this.paths.local).then(
      () => true,
      () => false,
    );
    if (present) {
      return;
    }
    try {
      await mkdir(dirname(this.paths.local), { recursive: true });
      await rename(legacy, this.paths.local);
    } catch (error) {
      if (!isNotFound(error)) {
        throw ioError(error, "local");
      }
    }
  }

  /**
   * Write through a temporary file in the same directory and rename over the
   * target, so a crash mid-write leaves the previous config intact rather than
   * a half-written one that will not parse.
   */
  private async atomicWrite(
    text: string,
    expectedRevision?: ContentRevision,
  ): Promise<void> {
    const parent = dirname(this.paths.local);
    await mkdir(parent, { recursive: true });
    if (expectedRevision !== undefined) {
      const current = await readFile(this.paths.local);
      const actual = contentRevision(current);
      if (actual !== expectedRevision) {
        throw new ConfigError({ code: "conflict" }, expectedRevision, actual);
      }
    }
    const existingMode = await stat(this.paths.local).then(
      (stats) => stats.mode & 0o777,
      () => undefined,
    );
    const temporary = join(
      parent,
      `.${this.paths.local.split("/").at(-1) ?? "settings.local.toml"}.devhub-${String(process.pid)}-${String(Date.now())}.tmp`,
    );
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (existingMode !== undefined) {
        await chmod(temporary, existingMode);
      }
      await rename(temporary, this.paths.local);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw ioError(error);
    }
  }
}

/** Re-exported so `writeFile` stays a single import for callers that need it. */
export { writeFile };
