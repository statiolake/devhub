// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../model/conversation";
import { ActivityLine } from "./ActivityLine";
import {
  activityLabel,
  deriveActivity,
  estimateTokens,
  formatElapsed,
  formatTokens,
} from "./activity";
import {
  assistant,
  put,
  tool,
  transcriptOf,
  user,
} from "./transcriptFixtures";

afterEach(cleanup);

const RUNNING: ConversationEvent = {
  type: "state",
  state: { phase: "ready", turn: "running" },
};

describe("deriveActivity", () => {
  it("is nothing when idle", () => {
    expect(
      deriveActivity(transcriptOf([put(user("u", "hi"))])),
    ).toBeUndefined();
  });
  it("is thinking while awaiting the first token", () => {
    const t = transcriptOf([put(user("u", "hi")), RUNNING]);
    expect(deriveActivity(t)).toEqual({ phase: "thinking" });
  });
  it("tells thinking from responding by the streaming block", () => {
    const thinking = transcriptOf([
      put(user("u", "hi")),
      RUNNING,
      put(
        assistant("a", [{ kind: "thinking", text: "hmm" }], {
          streaming: true,
        }),
      ),
    ]);
    expect(deriveActivity(thinking)).toEqual({ phase: "thinking" });
    const text = transcriptOf([
      put(user("u", "hi")),
      RUNNING,
      put(
        assistant(
          "a",
          [
            { kind: "thinking", text: "hmm" },
            { kind: "text", markdown: "ok" },
          ],
          { streaming: true },
        ),
      ),
    ]);
    expect(deriveActivity(text)).toEqual({ phase: "responding" });
  });
  it("names a running tool", () => {
    const t = transcriptOf([
      put(user("u", "hi")),
      RUNNING,
      put(tool("t", "Bash: ls", { status: "running" })),
    ]);
    expect(activityLabel(deriveActivity(t)!)).toBe("Running Bash…");
  });
});

describe("formatting and tokens", () => {
  it("formats", () => {
    expect(formatElapsed(12_900)).toBe("12s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatTokens(850)).toBe("850");
    expect(formatTokens(1200)).toBe("1.2k");
  });
  it("estimates from streamed text since the last message", () => {
    const t = transcriptOf([
      put(assistant("old", "x".repeat(4000))),
      put(user("u", "hi")),
      RUNNING,
      put(
        assistant("a", [{ kind: "thinking", text: "y".repeat(400) }], {
          streaming: true,
        }),
      ),
    ]);
    expect(estimateTokens(t)).toBe(100);
  });
});

describe("ActivityLine", () => {
  it("draws nothing when idle, the phase and elapsed time when running", () => {
    const { container, rerender } = render(
      <ActivityLine transcript={transcriptOf([])} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <ActivityLine
        transcript={transcriptOf([put(user("u", "hi")), RUNNING])}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Thinking…0s");
  });
});
