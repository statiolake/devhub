// @vitest-environment jsdom

/**
 * A GUI Agent's pane draws its conversation at most once per frame.
 *
 * Events are folded as they arrive, so the fold refuses a bad one at that
 * event; the transcript that is drawn is published once per animation frame,
 * so a burst of streaming deltas is one redraw rather than one per token.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  entryId,
  type ConversationEvent,
  type Transcript,
} from "../../model/conversation";
import type {
  ConversationAttachment,
  ConversationEventListener,
} from "../../ipc/conversation";
import {
  assistant,
  put,
  transcriptOf,
} from "../conversation/transcriptFixtures";
import { ConversationPane } from "./ConversationPane";

const drawn: Transcript[] = [];
vi.mock("../conversation/ConversationSurface", () => ({
  ConversationSurface: ({ transcript }: { transcript: Transcript }) => {
    drawn.push(transcript);
    return null;
  },
}));

const reportFailure = vi.fn();
vi.mock("./AgentsContext", () => ({
  useAgents: () => ({ reportFailure }),
}));

/** Animation frames, run by hand. */
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function runFrame() {
  const due = [...frames.values()];
  frames = new Map();
  act(() => {
    for (const callback of due) callback(performance.now());
  });
}

let listener: ConversationEventListener | undefined;
let answerAttach: (attachment: ConversationAttachment) => void = () => {};

beforeEach(() => {
  drawn.length = 0;
  reportFailure.mockReset();
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  window.devhub = {
    conversation: {
      attach: (_agentId: string, onEvent: ConversationEventListener) => {
        listener = onEvent;
        return new Promise<ConversationAttachment>((resolve) => {
          answerAttach = resolve;
        });
      },
      detach: () => Promise.resolve(),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.devhub;
});

const STREAMING = transcriptOf([put(assistant("a1", "", { streaming: true }))]);

async function attached(revision = 5) {
  const view = render(
    <ConversationPane
      agentId="agent-1"
      label="Agent 1"
      appearance={undefined}
      hidden={false}
    />,
  );
  await act(async () => {
    answerAttach({ transcript: STREAMING, revision });
  });
  return view;
}

function delta(text: string): ConversationEvent {
  return { type: "text-delta", entry: entryId("a1"), block: 0, text };
}

function markdownOf(transcript: Transcript): string {
  const entry = transcript.entries[0]!;
  if (entry.kind !== "assistant") throw new Error("not an answer");
  const block = entry.blocks[0]!;
  if (block.kind !== "text") throw new Error("not text");
  return block.markdown;
}

describe("drawing once per frame", () => {
  it("folds 300 events that arrive in one frame and draws once, with all of them", async () => {
    await attached();
    const before = drawn.length;
    act(() => {
      for (let index = 1; index <= 300; index += 1) {
        listener!(5 + index, delta("x"));
      }
    });
    expect(drawn.length).toBe(before);
    runFrame();
    expect(drawn.length).toBe(before + 1);
    expect(markdownOf(drawn.at(-1)!)).toBe("x".repeat(300));
  });

  it("draws again on the next frame for the events after it", async () => {
    await attached();
    act(() => listener!(6, delta("a")));
    runFrame();
    const after = drawn.length;
    act(() => {
      listener!(7, delta("b"));
      listener!(8, delta("c"));
    });
    runFrame();
    expect(drawn.length).toBe(after + 1);
    expect(markdownOf(drawn.at(-1)!)).toBe("abc");
  });

  it("refuses an event at that event, and draws what was still true", async () => {
    await attached();
    act(() => {
      listener!(6, delta("good"));
      // A delta to an entry that does not exist: the fold refuses it.
      listener!(7, {
        type: "text-delta",
        entry: entryId("nobody"),
        block: 0,
        text: "bad",
      });
    });
    expect(reportFailure).toHaveBeenCalledOnce();
    runFrame();
    expect(markdownOf(drawn.at(-1)!)).toBe("good");
  });

  it("reports a gap in the revisions at the event that shows it", async () => {
    await attached();
    act(() => listener!(9, delta("late")));
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(String(reportFailure.mock.calls[0]![0])).toContain(
      "skipped from event 5 to 9",
    );
  });

  it("draws nothing after it is gone", async () => {
    const view = await attached();
    act(() => listener!(6, delta("x")));
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
  });
});
