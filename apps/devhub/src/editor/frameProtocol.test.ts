import { describe, expect, it } from "vitest";
import { asFrameMessage } from "./frameProtocol";

describe("what the shell will accept from an Editor frame", () => {
  it("takes the two states a Workbench reports", () => {
    expect(asFrameMessage({ kind: "workbench-ready" })).toEqual({
      kind: "workbench-ready",
    });
    expect(
      asFrameMessage({
        kind: "workbench-failed",
        summary: "The editor could not start.",
        detail: "no server",
      }),
    ).toEqual({
      kind: "workbench-failed",
      summary: "The editor could not start.",
      detail: "no server",
    });
  });

  it("supplies its own words for a failure that arrived without any", () => {
    // A frame that fails badly enough may say so badly. The reader still gets
    // a sentence rather than "undefined".
    expect(asFrameMessage({ kind: "workbench-failed" })).toEqual({
      kind: "workbench-failed",
      summary: "The editor could not start.",
      detail: undefined,
    });
  });

  it("takes a destination to open, and nothing that is not a string", () => {
    expect(
      asFrameMessage({ kind: "open-external", url: "https://example.com/a" }),
    ).toEqual({ kind: "open-external", url: "https://example.com/a" });
    // This one ends at an `open`, so a message shaped almost right is refused
    // here rather than narrowed further along.
    expect(asFrameMessage({ kind: "open-external" })).toBeNull();
    expect(asFrameMessage({ kind: "open-external", url: 7 })).toBeNull();
  });

  it("refuses anything it does not recognise", () => {
    for (const value of [
      null,
      undefined,
      "workbench-ready",
      7,
      {},
      { kind: "something-else" },
      { kind: ["workbench-ready"] },
    ]) {
      expect(asFrameMessage(value)).toBeNull();
    }
  });
});
