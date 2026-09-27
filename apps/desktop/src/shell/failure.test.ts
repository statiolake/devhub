/**
 * The page's one conversion of a failure: a refusal main worded crosses IPC
 * inside an `Error`'s message and is shown with main's own title, and only a
 * failure nobody worded is the app shell's catch-all.
 */

import { describe, expect, it } from "vitest";
import type { AppError } from "../ipc/appShell";
import { FALLBACK_ERROR, toAppError } from "./failure";

describe("a failure as the page shows it", () => {
  it("keeps the title main gave a refusal it knows by name, as Electron carries it", () => {
    const refusal: AppError = {
      code: "conversation_not_resumable",
      summary: "DevHub cannot go on with this session.",
      detail:
        "DevHub cannot tell which Claude session this terminal Agent is in",
      module: "agent",
      timestampMs: 1,
      runtimeVersion: "0.1.0",
      actions: ["retry"],
    };
    const carried = new Error(
      `Error invoking remote method 'conversation:continue-in-gui': Error: ${JSON.stringify(refusal)}`,
    );
    expect(toAppError(carried)).toEqual(refusal);
  });

  it("is the catch-all, with the message as the detail, only for a failure nobody worded", () => {
    expect(toAppError(new Error("boom"))).toEqual({
      ...FALLBACK_ERROR,
      detail: "boom",
    });
  });
});
