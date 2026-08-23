import validFixtures from "../../../../../contracts/settings/valid.json";
import invalidFixtures from "../../../../../contracts/settings/invalid.json";
import { describe, expect, it } from "vitest";
import {
  parseSettingsConfig,
  parseSettingsError,
  parseSettingsSnapshot,
  validateSettings,
  type SettingsSnapshot,
} from "./index";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("generated Settings v1 contract", () => {
  it("accepts every Rust-owned valid fixture", () => {
    for (const value of validFixtures as unknown[]) {
      expect(() => validateSettings(value)).not.toThrow();
    }

    const snapshot = (validFixtures as unknown[]).find(
      (value) => isRecord(value) && "runtime" in value,
    );
    expect(() => parseSettingsSnapshot(snapshot)).not.toThrow();
    expect(() =>
      parseSettingsConfig(isRecord(snapshot) ? snapshot.config : undefined),
    ).not.toThrow();
    expect(() =>
      parseSettingsError({
        code: "invalid_config",
        diagnostic: null,
        currentRevision: null,
      }),
    ).not.toThrow();
  });

  it("rejects every shared invalid fixture", () => {
    for (const value of invalidFixtures as unknown[]) {
      expect(() => validateSettings(value)).toThrow();
    }
  });

  it("preserves immutable snapshots and content revisions", () => {
    const snapshot = (validFixtures as unknown[]).find(
      (value) => isRecord(value) && "runtime" in value,
    ) as SettingsSnapshot;
    const parsed = parseSettingsSnapshot(snapshot);
    expect(parsed.sequence).toBe(1);
    expect(parsed.revision).toHaveLength(64);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.runtime.socketChange.adapterAvailable).toBe(false);
    expect(parsed.runtime.socketChange.state).toBe("stable");
  });
});
