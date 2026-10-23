import assert from "node:assert/strict";
import test from "node:test";
import type * as vscode from "vscode";
import {
  accountFromStatus,
  buildHover,
  formatReset,
  planName,
  SET_SETTING_COMMAND,
  statusBarAppearance,
  type DashboardState,
} from "../src/dashboard";
import { parseCopilotQuota } from "../src/quota";

const icon = (id: string) => ({ id }) as vscode.ThemeIcon;

const quota = parseCopilotQuota({
  chat: { percentRemaining: 80, unlimited: false, overagePermitted: false },
  completions: {
    percentRemaining: 57.4,
    unlimited: false,
    overagePermitted: false,
  },
  premiumInteractions: {
    percentRemaining: 0,
    unlimited: false,
    overagePermitted: false,
  },
  resetDate: "2026-11-01",
  copilotPlan: "free",
});

const ready: DashboardState = {
  server: "running",
  busy: false,
  signingIn: false,
  account: { kind: "signedIn", user: "octocat" },
  quota: { kind: "loaded", quota },
  now: Date.parse("2026-10-17T12:00:00Z"),
  locale: "en-US",
  language: { id: "python", name: "Python" },
  completions: { global: true },
  nextEdits: { global: true, language: false },
};

type Item = vscode.StatusBarHoverItem;
const flatten = (items: readonly Item[]): Item[] =>
  items.flatMap((item) =>
    item.kind === "section" ? [item, ...item.items] : [item],
  );
const find = <K extends Item["kind"]>(
  state: DashboardState,
  kind: K,
  id?: string,
) =>
  flatten(buildHover(state, icon).items).filter(
    (item): item is Extract<Item, { kind: K }> =>
      item.kind === kind && (id === undefined || item.id === id),
  );
const buttonLabels = (state: DashboardState) =>
  find(state, "buttons").flatMap((row) =>
    row.buttons.map((button) => button.label),
  );

test("the status bar icon follows the official Copilot icons", () => {
  const text = (patch: Partial<DashboardState>) =>
    statusBarAppearance({ ...ready, ...patch }).text;
  assert.equal(text({}), "$(copilot)");
  assert.equal(text({ server: "starting" }), "$(loading~spin)");
  assert.equal(text({ busy: true }), "$(loading~spin)");
  assert.equal(text({ signingIn: true }), "$(loading~spin)");
  assert.equal(text({ server: "error" }), "$(copilot-warning)");
  assert.equal(
    text({ account: { kind: "signedOut" } }),
    "$(copilot-not-connected)",
  );
  assert.equal(text({ snoozedUntil: ready.now + 60_000 }), "$(copilot-snooze)");
  assert.equal(text({ snoozedUntil: ready.now - 1 }), "$(copilot)");
  assert.equal(
    text({ completions: { global: true, language: false } }),
    "$(copilot-unavailable)",
  );
  const exhausted = parseCopilotQuota({
    ...quota,
    completions: { ...quota.completions, percentRemaining: 0 },
  });
  assert.equal(
    text({ quota: { kind: "loaded", quota: exhausted } }),
    "$(copilot-warning) Quota reached",
  );
});

test("the header names the account and the plan", () => {
  const [header] = find(ready, "header");
  assert.equal(header.description, "$(account) octocat · Copilot Free");
  assert.deepEqual(
    header.actions?.map((action) => action.command.command),
    [
      "devhub.copilot.showOutput",
      "devhub.copilot.restart",
      "workbench.action.openSettings",
    ],
  );
  assert.equal(
    find({ ...ready, account: { kind: "signedOut" } }, "header")[0].description,
    "Not signed in",
  );
});

test("the completions quota is a meter of what is used, with its reset", () => {
  const [meter] = find(ready, "progress", "quota");
  assert.equal(meter.value, 42.6);
  assert.equal(meter.valueLabel, "42%");
  assert.equal(meter.detail, "Resets Nov 1");
  const unlimited = parseCopilotQuota({
    ...quota,
    completions: { ...quota.completions, unlimited: true },
  });
  assert.equal(
    find({ ...ready, quota: { kind: "loaded", quota: unlimited } }, "progress")
      .length,
    0,
  );
  assert.equal(
    find({ ...ready, account: { kind: "signedOut" } }, "progress").length,
    0,
  );
});

test("starting and signing in are indeterminate meters", () => {
  const [starting] = find({ ...ready, server: "starting" }, "progress");
  assert.equal(starting.value, undefined);
  assert.equal(starting.label, "Starting the language server");
  const [signingIn] = find({ ...ready, signingIn: true }, "progress");
  assert.equal(signingIn.value, undefined);
});

test("each kind of suggestion has a global and a per-language toggle", () => {
  const boxes = find(ready, "checkbox");
  assert.deepEqual(
    boxes.map((box) => [box.label, box.checked, box.triState === true]),
    [
      ["Code completions", true, false],
      ["Code completions for Python", "mixed", true],
      ["Next edit suggestions", true, false],
      ["Next edit suggestions for Python", false, true],
    ],
  );
  assert.equal(boxes[2].description, "(overridden)");
  assert.equal(boxes[0].description, undefined);
  assert.deepEqual(
    boxes.map((box) => [box.command.command, ...(box.command.arguments ?? [])]),
    [
      [SET_SETTING_COMMAND, "completions.enabled", null],
      [SET_SETTING_COMMAND, "completions.enabled", "python"],
      [SET_SETTING_COMMAND, "nextEditSuggestions.enabled", null],
      [SET_SETTING_COMMAND, "nextEditSuggestions.enabled", "python"],
    ],
  );
  assert.equal(
    find({ ...ready, language: undefined }, "checkbox").length,
    2,
    "no editor, no language toggles",
  );
});

test("snooze offers 5 minutes, then more or resume", () => {
  assert.ok(buttonLabels(ready).includes("$(clock) Snooze 5 min"));
  const snoozed = { ...ready, snoozedUntil: ready.now + 5 * 60_000 };
  const [section] = find(snoozed, "section", "snooze");
  assert.match(section.description ?? "", /^until /u);
  assert.ok(buttonLabels(snoozed).includes("+5 min"));
  assert.ok(buttonLabels(snoozed).includes("$(stop-circle) Resume"));
});

test("sign in or sign out, whichever applies", () => {
  assert.ok(buttonLabels(ready).includes("$(sign-out) Sign Out"));
  const signedOut = { ...ready, account: { kind: "signedOut" as const } };
  assert.ok(buttonLabels(signedOut).includes("$(sign-in) Sign In to GitHub"));
  const [account] = find(
    { ...signedOut, server: "starting" },
    "buttons",
    "account",
  );
  assert.equal(account.buttons[0].enabled, false, "not before the server runs");
});

test("an error offers a restart, and the dashboard turns Copilot off", () => {
  assert.ok(
    buttonLabels({ ...ready, server: "error", message: "boom" }).includes(
      "$(debug-restart) Restart",
    ),
  );
  const [text] = find({ ...ready, server: "error", message: "boom" }, "text");
  assert.equal(text.text, "$(error) boom");
  const [account] = find(ready, "buttons", "account");
  assert.equal(account.buttons[1].command.command, "devhub.copilot.disable");
});

test("checkStatus answers map to an account", () => {
  assert.deepEqual(accountFromStatus({ status: "OK", user: "octocat" }), {
    kind: "signedIn",
    user: "octocat",
  });
  assert.deepEqual(accountFromStatus({ status: "AlreadySignedIn" }), {
    kind: "signedIn",
  });
  assert.deepEqual(accountFromStatus({ status: "NotAuthorized", user: "x" }), {
    kind: "notAuthorized",
    user: "x",
  });
  assert.deepEqual(accountFromStatus({ status: "NotSignedIn" }), {
    kind: "signedOut",
  });
  assert.deepEqual(accountFromStatus(null), { kind: "unknown" });
});

test("plan names and reset dates", () => {
  assert.equal(planName("individual"), "Copilot Pro");
  assert.equal(planName("something_new"), "Copilot something_new");
  assert.equal(planName(""), undefined);
  assert.equal(formatReset("2026-11-01", "en-US"), "Resets Nov 1");
  assert.equal(formatReset("", "en-US"), undefined);
  assert.equal(formatReset("not a date", "en-US"), undefined);
});
