import { describe, expect, it } from "vitest";
import {
  terminalModeSupports,
  terminalModeUnsupported,
} from "./terminalMode.js";

describe("which Workspaces terminal mode serves", () => {
  it("serves a folder on this Mac whose editor is not in a container", () => {
    expect(
      terminalModeSupports({
        location: { kind: "local" },
        editor: { kind: "host" },
      }),
    ).toBe(true);
  });

  it("serves a folder on an SSH host, on the host", () => {
    expect(
      terminalModeSupports({
        location: { kind: "ssh" },
        editor: { kind: "host" },
      }),
    ).toBe(true);
  });

  it("says plainly that an editor in a dev container is not supported yet", () => {
    const container = {
      location: { kind: "local" },
      editor: { kind: "devContainer" },
    };
    const onHost = {
      location: { kind: "ssh" },
      editor: { kind: "devContainer" },
    };
    expect(terminalModeSupports(container)).toBe(false);
    expect(terminalModeSupports(onHost)).toBe(false);
    expect(terminalModeUnsupported(container)).toMatch(/dev container yet/u);
    expect(terminalModeUnsupported(onHost)).toMatch(/dev container yet/u);
  });
});
