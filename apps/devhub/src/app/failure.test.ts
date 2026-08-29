import { describe, expect, it } from "vitest";
import { FALLBACK_ERROR, toAppError, UserFacingFailure } from "./failure";

describe("failure conversion", () => {
  it("keeps the words of a condition the app raised on purpose", () => {
    // The regression this exists for: a deliberate failure was reaching the
    // shell as a bare Error, coming out as the sentence reserved for a shell
    // that is not answering at all, and telling the reader nothing about what
    // had actually happened.
    const failure = toAppError(
      new UserFacingFailure("The editor is open on another Workspace.", "why"),
    );
    expect(failure.summary).toBe("The editor is open on another Workspace.");
    expect(failure.detail).toBe("why");
  });

  it("passes a native error through unchanged", () => {
    const wire = {
      code: "editor_port_unavailable",
      summary: "The editor could not start.",
      detail: "127.0.0.1:55971 is already in use",
      module: "editor",
      timestampMs: 0,
      runtimeVersion: "test",
      actions: ["retry"],
    };
    expect(toAppError(wire)).toMatchObject({
      code: "editor_port_unavailable",
      detail: "127.0.0.1:55971 is already in use",
    });
  });

  it("answers an unrecognised failure with something the reader can act on", () => {
    // An internal message is not a next step. The stable sentence carries the
    // actions that are; the message it replaces was never for the reader.
    expect(toAppError(new Error("native host stopped"))).toEqual(
      FALLBACK_ERROR,
    );
    expect(toAppError(undefined)).toEqual(FALLBACK_ERROR);
  });

  it("unwraps a native error Tauri delivered inside a message", () => {
    const wrapped = new Error(
      JSON.stringify({
        code: "editor_provider_missing",
        summary: "No editor provider.",
        module: "editor",
        timestampMs: 0,
        runtimeVersion: "test",
        actions: ["retry"],
      }),
    );
    expect(toAppError(wrapped).code).toBe("editor_provider_missing");
  });
});
