import { describe, expect, it } from "vitest";
import {
  terminalModeSupports,
  terminalModeUnsupported,
} from "./terminalMode.js";

describe("which Workspaces terminal mode serves in phase 1", () => {
  it("serves a folder on this Mac whose editor is not in a container", () => {
    expect(
      terminalModeSupports({
        location: { kind: "local" },
        editor: { kind: "host" },
      }),
    ).toBe(true);
  });

  it("says plainly that SSH and dev container Workspaces are not supported yet", () => {
    const ssh = { location: { kind: "ssh" }, editor: { kind: "host" } };
    const container = {
      location: { kind: "local" },
      editor: { kind: "devContainer" },
    };
    expect(terminalModeSupports(ssh)).toBe(false);
    expect(terminalModeSupports(container)).toBe(false);
    expect(terminalModeUnsupported(ssh)).toMatch(/SSH hosts yet/u);
    expect(terminalModeUnsupported(container)).toMatch(/dev container yet/u);
  });
});
