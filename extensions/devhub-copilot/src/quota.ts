/**
 * Quota information returned by the Copilot Language Server `checkQuota`
 * request. The server fetches the signed-in user's entitlement from GitHub and
 * normalizes both Copilot Free (`limited_user_quotas`) and paid plans
 * (`quota_snapshots`) into this shape, so the adapter never calls GitHub itself.
 */
export interface CopilotQuotaSnapshot {
  percentRemaining: number;
  unlimited: boolean;
  overagePermitted: boolean;
}

export interface CopilotQuota {
  chat: CopilotQuotaSnapshot;
  completions: CopilotQuotaSnapshot;
  premiumInteractions: CopilotQuotaSnapshot;
  resetDate: string;
  copilotPlan: string;
}

export function parseCopilotQuota(value: unknown): CopilotQuota {
  if (!isRecord(value)) {
    throw new Error(`Unexpected checkQuota response: ${JSON.stringify(value)}`);
  }
  return {
    chat: parseSnapshot(value.chat, "chat"),
    completions: parseSnapshot(value.completions, "completions"),
    premiumInteractions: parseSnapshot(
      value.premiumInteractions,
      "premiumInteractions",
    ),
    resetDate: requireString(value.resetDate, "resetDate"),
    copilotPlan: requireString(value.copilotPlan, "copilotPlan"),
  };
}

/** Short status bar label for the quota that governs completions and NES. */
export function formatCompletionsQuotaLabel(
  quota: CopilotQuota,
): string | undefined {
  return quota.completions.unlimited
    ? undefined
    : `${Math.floor(quota.completions.percentRemaining)}%`;
}

export function formatQuotaLines(quota: CopilotQuota): string[] {
  const lines = [
    `Plan: ${quota.copilotPlan}`,
    `Completions: ${formatSnapshot(quota.completions)}`,
    `Chat: ${formatSnapshot(quota.chat)}`,
    `Premium requests: ${formatSnapshot(quota.premiumInteractions)}`,
  ];
  if (quota.resetDate.length > 0) {
    lines.push(`Resets: ${quota.resetDate}`);
  }
  return lines;
}

function formatSnapshot(snapshot: CopilotQuotaSnapshot): string {
  if (snapshot.unlimited) {
    return "unlimited";
  }
  const remaining = `${Math.floor(snapshot.percentRemaining)}% remaining`;
  return snapshot.overagePermitted
    ? `${remaining} (overage permitted)`
    : remaining;
}

function parseSnapshot(value: unknown, name: string): CopilotQuotaSnapshot {
  if (
    !isRecord(value) ||
    typeof value.percentRemaining !== "number" ||
    !Number.isFinite(value.percentRemaining) ||
    typeof value.unlimited !== "boolean" ||
    typeof value.overagePermitted !== "boolean"
  ) {
    throw new Error(
      `Unexpected checkQuota snapshot "${name}": ${JSON.stringify(value)}`,
    );
  }
  return {
    percentRemaining: value.percentRemaining,
    unlimited: value.unlimited,
    overagePermitted: value.overagePermitted,
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(
      `Unexpected checkQuota field "${name}": ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
