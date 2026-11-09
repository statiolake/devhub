import { describe, expect, it } from "vitest";
import { TerminalFailure } from "../../ipc/terminal";
import { STALE_RETRIES, retriesAttach } from "./client";

describe("an attach refused as stale", () => {
  it("is made again by itself, a few times, while the surface wants one", () => {
    const stale = new TerminalFailure("stale_target");
    expect(retriesAttach(stale, 0)).toBe(true);
    expect(retriesAttach(stale, STALE_RETRIES - 1)).toBe(true);
    expect(retriesAttach(stale, STALE_RETRIES)).toBe(false);
  });

  it("is the only failure that is: the others are the person's to read", () => {
    expect(retriesAttach(new TerminalFailure("session_unavailable"), 0)).toBe(
      false,
    );
    expect(retriesAttach(new Error("x"), 0)).toBe(false);
  });
});
