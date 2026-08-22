import validFixtures from "../../../../../contracts/app-shell/valid.json";
import invalidFixtures from "../../../../../contracts/app-shell/invalid.json";
import { describe, expect, it } from "vitest";
import {
  parseAppEventCursor,
  parseAppIntent,
  parseAppSnapshot,
  type AppEventCursor,
  type AppIntent,
  type AppSnapshot,
} from "./index";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("generated App Shell v1 contract", () => {
  it("accepts every Rust-owned valid fixture", () => {
    const values = validFixtures as unknown[];
    const snapshot = values.find(
      (value) => isRecord(value) && "schemaVersion" in value,
    );
    const intent = values.find(
      (value) => isRecord(value) && value.type === "select_context",
    );
    const replay = values.find((value) => isRecord(value) && "cursor" in value);

    expect(() => parseAppSnapshot(snapshot)).not.toThrow();
    expect(() => parseAppIntent(intent)).not.toThrow();
    expect(() => parseAppEventCursor(replay)).not.toThrow();
  });

  it("rejects every shared invalid fixture", () => {
    for (const value of invalidFixtures as unknown[]) {
      if (isRecord(value) && "type" in value) {
        expect(() => parseAppIntent(value)).toThrow();
      } else if (isRecord(value) && "cursor" in value) {
        expect(() => parseAppEventCursor(value)).toThrow();
      } else {
        expect(() => parseAppSnapshot(value)).toThrow();
      }
    }
  });

  it("keeps the cursor independent from public event continuity", () => {
    const replay: AppEventCursor = parseAppEventCursor({
      cursor: 42,
      historyGap: true,
      snapshot: (validFixtures as unknown[]).find(
        (value) => isRecord(value) && "schemaVersion" in value,
      ),
      events: [{ sequence: 41, kind: "noop" }],
    });
    expect(replay.cursor).toBe(42);
    expect(replay.historyGap).toBe(true);
    expect(replay.events).toEqual([{ sequence: 41, kind: "noop" }]);
  });

  it("keeps the tagged resolution algebra closed", () => {
    const snapshot = parseAppSnapshot(
      (validFixtures as unknown[]).find(
        (value) => isRecord(value) && "schemaVersion" in value,
      ),
    ) as AppSnapshot;
    expect(snapshot.activities[0].resolution).toEqual({
      kind: "enabled",
      surfaceKey: "global-editor",
    });
    expect(snapshot.activities[1].resolution).toEqual({
      kind: "disabled",
      reason: "global-agent-not-applicable",
    });
  });

  it("does not widen parsed values into mutable local state", () => {
    const intent = parseAppIntent(
      (validFixtures as unknown[]).find(
        (value) => isRecord(value) && value.type === "select_activity",
      ),
    ) as AppIntent;
    expect(Object.isFrozen(intent)).toBe(true);
  });
});
