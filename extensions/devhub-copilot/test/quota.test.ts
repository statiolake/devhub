import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCompletionsQuotaLabel,
  formatQuotaLines,
  parseCopilotQuota,
} from "../src/quota";

const freeQuotaResponse = {
  chat: { percentRemaining: 80, unlimited: false, overagePermitted: false },
  completions: {
    percentRemaining: 42.6,
    unlimited: false,
    overagePermitted: false,
  },
  premiumInteractions: {
    percentRemaining: 0,
    unlimited: false,
    overagePermitted: false,
  },
  resetDate: "2026-10-01",
  copilotPlan: "free",
  tokenBasedBillingEnabled: false,
  canUpgradePlan: true,
};

test("parses a Copilot Free checkQuota response", () => {
  const quota = parseCopilotQuota(freeQuotaResponse);
  assert.equal(quota.copilotPlan, "free");
  assert.equal(quota.completions.percentRemaining, 42.6);
  assert.equal(formatCompletionsQuotaLabel(quota), "42%");
  assert.deepEqual(formatQuotaLines(quota), [
    "Plan: free",
    "Completions: 42% remaining",
    "Chat: 80% remaining",
    "Premium requests: 0% remaining",
    "Resets: 2026-10-01",
  ]);
});

test("omits the status bar label when completions are unlimited", () => {
  const quota = parseCopilotQuota({
    ...freeQuotaResponse,
    completions: {
      percentRemaining: 100,
      unlimited: true,
      overagePermitted: false,
    },
    copilotPlan: "individual",
  });
  assert.equal(formatCompletionsQuotaLabel(quota), undefined);
});

test("rejects malformed checkQuota responses instead of defaulting", () => {
  assert.throws(
    () => parseCopilotQuota(null),
    /Unexpected checkQuota response/,
  );
  assert.throws(
    () =>
      parseCopilotQuota({
        ...freeQuotaResponse,
        completions: { percentRemaining: "42" },
      }),
    /snapshot "completions"/,
  );
  assert.throws(
    () => parseCopilotQuota({ ...freeQuotaResponse, resetDate: undefined }),
    /field "resetDate"/,
  );
});
