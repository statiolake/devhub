/**
 * The user's configuration file: `~/.config/devhub/config.toml`.
 *
 * A port of `crates/devhub-app-core/src/config/mod.rs`. The rules that matter
 * are kept exactly: unknown keys are an error rather than an ignored typo, the
 * whole file is validated before any of it is adopted, a save is refused when
 * the file changed underneath it, and the last file that parsed stays in
 * effect while a broken one is on disk — with the diagnostic kept, so "still
 * running on the old config" is a state the app can show rather than a silence.
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
  DEFAULT_ACTION_ID,
  DEFAULT_ACTION_NAME,
  DEFAULT_ACTION_TEMPLATE,
} from "./agentActions.js";
import { dateTemplateBracketsBalance } from "./dateTemplate.js";
import { isValidFontFamily } from "./fontFamily.js";
import {
  parseTomlValue,
  renderTomlDocument,
  TomlSyntaxError,
  updateTomlDocument,
  type TomlValue,
} from "./tomlDocument.js";

export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_RELATIVE_PATH = ".config/devhub/config.toml";

/**
 * Where the config lives.
 *
 * `~/.config/devhub/config.toml`, unless `XDG_CONFIG_HOME` says otherwise —
 * which is the convention for everything else under `~/.config`, and is what
 * lets a test or a second instance be pointed somewhere else without moving
 * `HOME` and taking the Keychain, the caches and the app's whole identity
 * with it.
 */
export function defaultConfigPath(
  home: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const xdg = environment["XDG_CONFIG_HOME"];
  return xdg !== undefined && xdg.startsWith("/")
    ? join(xdg, "devhub", "config.toml")
    : join(home, CONFIG_RELATIVE_PATH);
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

export type AgentProfileKind = "codex" | "claude" | "custom";

/**
 * What DevHub says to an Agent when it takes an action on the person's behalf.
 *
 * The `id` names one of DevHub's own actions — it is not a name somebody
 * invents, because an invented action would have nothing to trigger it — and
 * the template is the wording. See `model/agentActions.ts` for the actions
 * themselves, the variables each one offers and the skill notation.
 */
export interface ConfiguredAgentAction {
  readonly id: string;
  readonly display_name: string;
  readonly template: string;
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
    // `custom` is the truthful kind, and it is the reason this profile can be
    // here at all: DevHub has no screen manifest for Cursor, so it cannot say
    // what the Agent is doing and its rows carry the `unknown` mark. That is a
    // correct permanent answer rather than a stage on the way to another one.
    // A kind of `codex` or `claude` would be a claim DevHub cannot make, and
    // the status it produced would be wrong rather than absent.
    //
    // The command is `cursor-agent` and nothing checks for it here. A profile
    // naming a command that is not installed already fails where it is run,
    // visibly, and a second check at the point the default is written would be
    // the same question answered twice — differently, the first time somebody
    // installs it while DevHub is open.
    {
      id: "cursor",
      display_name: "Cursor",
      kind: "custom",
      command: "cursor-agent",
      args: [],
      env: {},
    },
  ];
}

/**
 * The one action DevHub ships.
 *
 * A default, not a fixed set. Actions are how a person starts an agent on an
 * Issue — implement it, review it, whatever else they do — so the list is
 * theirs to write, and this is a first entry to edit rather than a rule. Every
 * action has the same trigger (the Issue flow asks which one), which is what
 * gives an action somebody invented somewhere to be chosen from.
 */
export function defaultAgentActions(): ConfiguredAgentAction[] {
  return [
    {
      id: DEFAULT_ACTION_ID,
      display_name: DEFAULT_ACTION_NAME,
      template: DEFAULT_ACTION_TEMPLATE,
    },
  ];
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

export interface ConfigDiagnostic {
  readonly code: ValidationCode;
  readonly path?: string;
  readonly location?: SourceLocation;
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

function agentActionFromTable(
  value: unknown,
  index: number,
): ConfiguredAgentAction {
  const prefix = `agent_actions[${String(index)}]`;
  const table = requireTable(value, prefix);
  checkKeys(table, ["id", "display_name", "template"], prefix);
  return {
    id: optionalString(table, "id", prefix, ""),
    display_name: optionalString(table, "display_name", prefix, ""),
    template: optionalString(table, "template", prefix, ""),
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
  if (kind !== "codex" && kind !== "claude" && kind !== "custom") {
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
    // A known kind's command defaults to its own name, which is what the two
    // shipped profiles want and why nobody has to write it. `custom` has no
    // such name: the whole of what it says is "run this", so it has to say it.
    command:
      kind === "custom"
        ? requiredString(table, "command", prefix)
        : optionalString(table, "command", prefix, kind),
    args: optionalStringArray(table, "args", prefix, []),
    env,
  };
}

/** Decode one config document. Anything the shape does not allow throws. */
export function parseConfig(input: string): Config {
  let document: unknown;
  try {
    document = parseTomlValue(input);
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
  const rawActions = table["agent_actions"];
  if (rawActions !== undefined && !Array.isArray(rawActions)) {
    fail("invalid_type", "agent_actions");
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
    // The file's list is the list. A file that mentions none has none, which
    // is a person who has decided not to have DevHub say anything — and is
    // different from a file that has not been written yet, which gets the
    // default from `defaults`.
    agentActions:
      rawActions === undefined
        ? defaults.agentActions
        : rawActions.map(agentActionFromTable),
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
    agent_actions: config.agentActions.map((action) => ({
      id: action.id,
      display_name: action.display_name,
      template: action.template,
    })),
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

function ioError(error: unknown): ConfigError {
  if (
    error instanceof Error &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  ) {
    return new ConfigError({ code: "io", path: "ENOENT" });
  }
  return new ConfigError({ code: "io" });
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

/**
 * The one owner of `config.toml` in this process.
 *
 * `load` adopts the file (writing the defaults when there is none); `reload`
 * adopts a newer one, or keeps the last good config and records the diagnostic;
 * `save` writes atomically and only over the revision it was given.
 */
export class ConfigStore {
  private active: LoadedConfig | undefined;
  private diagnostic: ConfigDiagnostic | undefined;

  constructor(readonly path: string) {}

  async load(): Promise<LoadedConfig> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if (!isNotFound(error)) {
        throw ioError(error);
      }
      const text = configToToml(defaultConfig());
      await this.atomicWrite(text);
      bytes = Buffer.from(text, "utf8");
    }
    const loaded = this.decode(bytes);
    this.active = loaded;
    this.diagnostic = undefined;
    return loaded;
  }

  async reload(): Promise<ReloadOutcome> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      const failure = ioError(error);
      this.diagnostic = failure.diagnostic;
      throw failure;
    }
    const revision = contentRevision(bytes);
    if (this.active?.revision === revision) {
      return { kind: "unchanged", revision };
    }
    let loaded: LoadedConfig;
    try {
      loaded = this.decode(bytes);
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

  async save(
    expectedRevision: ContentRevision,
    config: Config,
  ): Promise<LoadedConfig> {
    validateConfig(config);
    let currentBytes: Buffer;
    try {
      currentBytes = await readFile(this.path);
    } catch (error) {
      throw ioError(error);
    }
    const actual = contentRevision(currentBytes);
    if (actual !== expectedRevision) {
      throw new ConfigError({ code: "conflict" }, expectedRevision, actual);
    }
    // Written over the document that is there, not in place of it: the file
    // keeps its comments, its grouping and its order.
    const output = configOntoDocument(currentBytes.toString("utf8"), config);
    const loaded = this.decode(Buffer.from(output, "utf8"));
    await this.atomicWrite(output, expectedRevision);
    this.active = loaded;
    this.diagnostic = undefined;
    return loaded;
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

  private decode(bytes: Buffer): LoadedConfig {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ConfigError({ code: "invalid_utf8" });
    }
    return { config: parseConfig(text), revision: contentRevision(bytes) };
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
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true });
    if (expectedRevision !== undefined) {
      const current = await readFile(this.path);
      const actual = contentRevision(current);
      if (actual !== expectedRevision) {
        throw new ConfigError({ code: "conflict" }, expectedRevision, actual);
      }
    }
    const existingMode = await stat(this.path).then(
      (stats) => stats.mode & 0o777,
      () => undefined,
    );
    const temporary = join(
      parent,
      `.${this.path.split("/").at(-1) ?? "config.toml"}.devhub-${String(process.pid)}-${String(Date.now())}.tmp`,
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
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw ioError(error);
    }
  }
}

/** Re-exported so `writeFile` stays a single import for callers that need it. */
export { writeFile };
