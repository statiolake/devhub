import { describe, expect, it } from "vitest";
import {
  parseSettingsFixtureQuery,
  settingsFixtureSnapshots,
} from "./settings-route";

describe("development Settings visual fixture route", () => {
  it("accepts each deterministic Settings state", () => {
    expect(parseSettingsFixtureQuery("?fixture=settings-ready")).toBe(
      "settings-ready",
    );
    expect(
      parseSettingsFixtureQuery("?fixture=settings-socket-confirmation"),
    ).toBe("settings-socket-confirmation");
    expect(settingsFixtureSnapshots["settings-ready"].diagnostic).toBeNull();
  });

  it("keeps the invalid diagnostic and socket counts exact", () => {
    expect(
      settingsFixtureSnapshots["settings-invalid-diagnostic"].diagnostic,
    ).toEqual({
      code: "invalid_appearance",
      path: "appearance.terminalFontSize",
      line: 12,
      column: 7,
    });
    const socket =
      settingsFixtureSnapshots["settings-socket-confirmation"].runtime
        .socketChange;
    expect(socket).toMatchObject({
      requestedSocketName: "devhub-fixture",
      targetPreflight: "target_devhub_empty",
      scratchSessionCount: 2,
      workspaceSessionCount: 3,
      confirmationRequired: true,
      adapterAvailable: true,
    });
  });

  it("falls through for absent, duplicate, and unknown queries", () => {
    expect(parseSettingsFixtureQuery("")).toBeUndefined();
    expect(
      parseSettingsFixtureQuery(
        "?fixture=settings-ready&fixture=settings-dirty",
      ),
    ).toBeUndefined();
    expect(parseSettingsFixtureQuery("?fixture=settings-live")).toBeUndefined();
  });
});
