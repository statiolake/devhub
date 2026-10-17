import type * as vscode from "vscode";
import type { CopilotQuota } from "./quota";

/**
 * Everything the status bar item and its hover are drawn from. Built by the
 * controller from the server's reports, the settings and the active editor,
 * so what is drawn is a function of it and nothing else.
 */
export interface DashboardState {
  /** `devhub.copilot.enable`. */
  enabled: boolean;
  server: "stopped" | "starting" | "running" | "error";
  /** The server reported work in flight (`didChangeStatus` busy). */
  busy: boolean;
  signingIn: boolean;
  account: AccountState;
  /** The server's last status message, or why it is not running. */
  message?: string;
  quota?: { kind: "loaded"; quota: CopilotQuota } | { kind: "failed" };
  /** Epoch milliseconds until which suggestions are snoozed. */
  snoozedUntil?: number;
  now: number;
  locale?: string;
  /** The active editor's language, for the "for <language>" toggles. */
  language?: { id: string; name: string };
  completions: FeatureSetting;
  nextEdits: FeatureSetting;
}

export type AccountState =
  | { kind: "unknown" }
  | { kind: "signedIn"; user?: string }
  /** Signed in to GitHub, but the account has no Copilot. */
  | { kind: "notAuthorized"; user?: string }
  | { kind: "signedOut" };

const SIGNED_IN = new Set(["OK", "MaybeOk", "AlreadySignedIn"]);

/** The account, from the server's `checkStatus` answer. */
export function accountFromStatus(
  response: { status?: unknown; user?: unknown } | null | undefined,
): AccountState {
  const status = typeof response?.status === "string" ? response.status : "";
  const user =
    typeof response?.user === "string" && response.user.length > 0
      ? response.user
      : undefined;
  if (SIGNED_IN.has(status)) {
    return user === undefined
      ? { kind: "signedIn" }
      : { kind: "signedIn", user };
  }
  if (status === "NotAuthorized") {
    return user === undefined
      ? { kind: "notAuthorized" }
      : { kind: "notAuthorized", user };
  }
  return status.length === 0 ? { kind: "unknown" } : { kind: "signedOut" };
}

export interface FeatureSetting {
  /** The value without a language override. */
  global: boolean;
  /** The active language's override, if it has one. */
  language?: boolean;
}

/** The internal command a hover checkbox runs, with the new state appended. */
export const SET_SETTING_COMMAND = "devhub.copilot._setSetting";
export const COMPLETIONS_SETTING = "completions.enabled";
export const NEXT_EDITS_SETTING = "nextEditSuggestions.enabled";
export const SNOOZE_MS = 5 * 60_000;

export function isSnoozed(state: Pick<DashboardState, "snoozedUntil" | "now">) {
  return state.snoozedUntil !== undefined && state.snoozedUntil > state.now;
}

export function effective(setting: FeatureSetting): boolean {
  return setting.language ?? setting.global;
}

export interface StatusBarAppearance {
  text: string;
  /** Status, for screen readers and for the plain tooltip fallback. */
  summary: string;
  warning: boolean;
}

/**
 * The status bar item: the Copilot icon the official one uses for the same
 * state, a spinner while something is in flight.
 */
export function statusBarAppearance(
  state: DashboardState,
): StatusBarAppearance {
  const ready = (summary: string, icon = "$(copilot)") => ({
    text: icon,
    summary,
    warning: false,
  });
  if (!state.enabled) {
    return ready("Copilot is turned off", "$(copilot-unavailable)");
  }
  if (state.server === "starting") {
    return ready("Copilot is starting", "$(loading~spin)");
  }
  if (state.signingIn) {
    return ready("Signing in to GitHub", "$(loading~spin)");
  }
  if (state.server === "error" || state.server === "stopped") {
    return {
      text: "$(copilot-warning)",
      summary: `Copilot: ${state.message ?? "the language server is not running"}`,
      warning: true,
    };
  }
  if (state.account.kind === "signedOut") {
    return ready("Copilot: not signed in", "$(copilot-not-connected)");
  }
  if (state.account.kind === "notAuthorized") {
    return {
      text: "$(copilot-blocked)",
      summary: "Copilot: this GitHub account has no Copilot access",
      warning: true,
    };
  }
  const quota = state.quota?.kind === "loaded" ? state.quota.quota : undefined;
  if (
    quota !== undefined &&
    !quota.completions.unlimited &&
    quota.completions.percentRemaining <= 0
  ) {
    return {
      text: "$(copilot-warning) Quota reached",
      summary: "Copilot: the code completions quota is used up",
      warning: true,
    };
  }
  if (isSnoozed(state)) {
    return ready(
      `Copilot is snoozed until ${formatTime(state.snoozedUntil!, state.locale)}`,
      "$(copilot-snooze)",
    );
  }
  if (!effective(state.completions) && !effective(state.nextEdits)) {
    return ready(
      state.language === undefined
        ? "Copilot suggestions are turned off"
        : `Copilot suggestions are turned off for ${state.language.name}`,
      "$(copilot-unavailable)",
    );
  }
  if (state.busy) {
    return ready("Copilot is working", "$(loading~spin)");
  }
  return ready("Copilot is ready");
}

type Item = vscode.StatusBarHoverItem;
type Leaf = Exclude<Item, vscode.StatusBarHoverSection>;

/**
 * The hover: who is signed in, how the server is, the quota, the toggles for
 * the two kinds of suggestions (everywhere and for the active language),
 * snooze, and the actions the old menu had.
 *
 * `icon` makes a `ThemeIcon`; it is passed in so this stays a plain function
 * the tests can run without the editor.
 */
export function buildHover(
  state: DashboardState,
  icon: (id: string) => vscode.ThemeIcon,
): vscode.StatusBarHover {
  const items: Item[] = [header(state, icon)];

  if (!state.enabled) {
    items.push(
      {
        kind: "text",
        text: "Copilot is turned off. No language server runs and no suggestions are offered.",
        muted: true,
      },
      {
        kind: "buttons",
        id: "power",
        buttons: [
          { label: "Turn On Copilot", command: cmd("devhub.copilot.toggle") },
        ],
      },
    );
    return { items };
  }

  items.push(...serverItems(state));
  items.push(...quotaItems(state));
  items.push(suggestionsSection(state));
  items.push(snoozeItems(state));
  items.push({ kind: "separator" }, accountButtons(state));
  return { items };
}

function header(
  state: DashboardState,
  icon: (id: string) => vscode.ThemeIcon,
): Item {
  const quota = state.quota?.kind === "loaded" ? state.quota.quota : undefined;
  const plan = quota === undefined ? undefined : planName(quota.copilotPlan);
  let description: string | undefined;
  switch (state.account.kind) {
    case "signedIn":
    case "notAuthorized":
      description = [
        state.account.user === undefined
          ? "Signed in"
          : `$(account) ${state.account.user}`,
        plan,
      ]
        .filter((part) => part !== undefined)
        .join(" · ");
      break;
    case "signedOut":
      description = "Not signed in";
      break;
    case "unknown":
      description = state.enabled ? undefined : "Turned off";
      break;
  }
  return {
    kind: "header",
    id: "header",
    label: "Copilot",
    description,
    actions: [
      {
        icon: icon("output"),
        command: cmd("devhub.copilot.showOutput", "Show Output"),
      },
      {
        icon: icon("debug-restart"),
        command: cmd("devhub.copilot.restart", "Restart Language Server"),
      },
      {
        icon: icon("settings-gear"),
        command: cmd("workbench.action.openSettings", "Settings", [
          "devhub.copilot",
        ]),
      },
    ],
  };
}

function serverItems(state: DashboardState): Item[] {
  if (state.server === "starting") {
    return [
      { kind: "progress", id: "server", label: "Starting the language server" },
    ];
  }
  if (state.signingIn) {
    return [
      {
        kind: "progress",
        id: "server",
        label: "Signing in to GitHub",
        detail: "Finish in the browser",
      },
    ];
  }
  if (state.server === "error" || state.server === "stopped") {
    return [
      {
        kind: "text",
        id: "server",
        text: `$(error) ${state.message ?? "The language server is not running."}`,
      },
      {
        kind: "buttons",
        id: "server-actions",
        buttons: [
          {
            label: "$(debug-restart) Restart",
            command: cmd("devhub.copilot.restart", "Restart Language Server"),
          },
          {
            label: "$(output) Show Output",
            command: cmd("devhub.copilot.showOutput"),
            secondary: true,
          },
        ],
      },
    ];
  }
  if (state.account.kind === "notAuthorized") {
    return [
      {
        kind: "text",
        id: "server",
        text: "$(warning) This GitHub account has no Copilot access.",
      },
    ];
  }
  return [
    {
      kind: "text",
      id: "server",
      muted: true,
      text: state.busy
        ? "$(loading~spin) Language server: working"
        : state.account.kind === "signedOut"
          ? "$(circle-large-outline) Language server: waiting for sign-in"
          : "$(pass) Language server: running",
    },
  ];
}

function quotaItems(state: DashboardState): Item[] {
  if (state.account.kind !== "signedIn" || state.quota === undefined) {
    return [];
  }
  if (state.quota.kind === "failed") {
    return [{ kind: "text", text: "Usage is unavailable.", muted: true }];
  }
  const quota = state.quota.quota;
  const reset = formatReset(quota.resetDate, state.locale);
  if (quota.completions.unlimited) {
    return [
      {
        kind: "text",
        id: "quota",
        muted: true,
        text: "$(check) Code completions: included in your plan",
      },
    ];
  }
  const used = Math.min(
    100,
    Math.max(0, 100 - quota.completions.percentRemaining),
  );
  return [
    {
      kind: "progress",
      id: "quota",
      label: "Code completions",
      value: used,
      valueLabel: `${Math.floor(used)}%`,
      description: quota.completions.overagePermitted
        ? "used, overage permitted"
        : "used",
      detail: reset,
    },
  ];
}

function suggestionsSection(state: DashboardState): Item {
  const items: Leaf[] = [];
  const language = state.language;
  const pair = (
    key: string,
    label: string,
    setting: FeatureSetting,
  ): Leaf[] => {
    const overridden =
      language !== undefined &&
      setting.language !== undefined &&
      setting.language !== setting.global;
    const row: Leaf[] = [
      {
        kind: "checkbox",
        id: key,
        label,
        checked: setting.global,
        description: overridden ? "(overridden)" : undefined,
        command: cmd(SET_SETTING_COMMAND, label, [key, null]),
      },
    ];
    if (language !== undefined) {
      row.push({
        kind: "checkbox",
        id: `${key}:language`,
        label: `${label} for ${language.name}`,
        checked: setting.language ?? "mixed",
        triState: true,
        command: cmd(SET_SETTING_COMMAND, `${label} for ${language.name}`, [
          key,
          language.id,
        ]),
      });
    }
    return row;
  };
  items.push(
    ...pair(COMPLETIONS_SETTING, "Code completions", state.completions),
    ...pair(NEXT_EDITS_SETTING, "Next edit suggestions", state.nextEdits),
  );
  return {
    kind: "section",
    id: "suggestions",
    label: "Suggestions",
    description: language?.name,
    items,
  };
}

function snoozeItems(state: DashboardState): Item {
  if (isSnoozed(state)) {
    return {
      kind: "section",
      id: "snooze",
      label: "Snoozed",
      description: `until ${formatTime(state.snoozedUntil!, state.locale)}`,
      items: [
        {
          kind: "buttons",
          id: "snooze-buttons",
          buttons: [
            {
              label: "+5 min",
              command: cmd("devhub.copilot.snooze", "Snooze 5 more minutes"),
              secondary: true,
            },
            {
              label: "$(stop-circle) Resume",
              command: cmd("devhub.copilot.cancelSnooze", "Cancel Snooze"),
              secondary: true,
            },
          ],
        },
      ],
    };
  }
  return {
    kind: "buttons",
    id: "snooze-buttons",
    buttons: [
      {
        label: "$(clock) Snooze 5 min",
        command: cmd(
          "devhub.copilot.snooze",
          "Hide Copilot suggestions for 5 minutes",
        ),
        secondary: true,
      },
    ],
  };
}

function accountButtons(state: DashboardState): Item {
  const signedIn =
    state.account.kind === "signedIn" || state.account.kind === "notAuthorized";
  const running = state.server === "running";
  return {
    kind: "buttons",
    id: "account",
    buttons: [
      signedIn
        ? {
            label: "$(sign-out) Sign Out",
            command: cmd("devhub.copilot.signOut"),
            secondary: true,
            enabled: running,
          }
        : {
            label: "$(sign-in) Sign In to GitHub",
            command: cmd("devhub.copilot.signIn"),
            enabled: running && !state.signingIn,
          },
      {
        label: "Turn Off Copilot",
        command: cmd("devhub.copilot.toggle"),
        secondary: true,
      },
    ],
  };
}

function cmd(command: string, title = "", args?: unknown[]): vscode.Command {
  return args === undefined
    ? { command, title }
    : { command, title, arguments: args };
}

const PLAN_NAMES: Record<string, string> = {
  free: "Copilot Free",
  individual: "Copilot Pro",
  individual_pro: "Copilot Pro+",
  business: "Copilot Business",
  enterprise: "Copilot Enterprise",
  edu: "Copilot Pro (Education)",
};

export function planName(plan: string): string | undefined {
  if (plan.length === 0) {
    return undefined;
  }
  return PLAN_NAMES[plan] ?? `Copilot ${plan}`;
}

/** `Resets Nov 1`, from the server's `resetDate` (an ISO date). */
export function formatReset(
  resetDate: string,
  locale?: string,
): string | undefined {
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/u.test(resetDate)
      ? `${resetDate}T00:00:00`
      : resetDate,
  );
  if (resetDate.length === 0 || Number.isNaN(date.getTime())) {
    return undefined;
  }
  return `Resets ${date.toLocaleDateString(locale, { month: "short", day: "numeric" })}`;
}

function formatTime(epochMs: number, locale?: string): string {
  return new Date(epochMs).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
}
