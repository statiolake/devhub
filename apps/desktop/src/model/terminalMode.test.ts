import { describe, expect, it } from "vitest";
import { terminalModeSupports } from "./terminalMode.js";

describe("which Workspaces terminal mode serves", () => {
  it("serves a folder on this Mac", () => {
    expect(terminalModeSupports({ location: { kind: "local" } })).toBe(true);
  });

  it("serves a folder whose editor was in a dev container as the local folder", () => {
    const container = {
      location: { kind: "local" },
      editor: { kind: "devContainer" },
    };
    expect(terminalModeSupports(container)).toBe(true);
  });

  it("does not serve SSH Workspaces", () => {
    expect(terminalModeSupports({ location: { kind: "ssh" } })).toBe(false);
  });
});
