// @vitest-environment jsdom

/**
 * Run in Background: while the turn waits on a call's work that the CLI can
 * move (`Transcript.foregroundTasks`), its row offers it, and Ctrl+B moves
 * all of it, as in Claude Code's own terminal. Moved, the call stands for
 * the work in the background and leaves the offer behind.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyEvents,
  entryId,
  type ConversationEvent,
  type Transcript,
} from "../../model/conversation";
import { draw, fakeActions, installResizeObserver } from "./surfaceTestKit";
import { put, tool, transcriptOf } from "./transcriptFixtures";

beforeAll(() => {
  installResizeObserver();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const RUNNING: ConversationEvent = {
  type: "state",
  state: { phase: "ready", turn: "running" },
};
const BUILD = entryId("tool:build");

function building(): Transcript {
  return transcriptOf([
    RUNNING,
    put(
      tool("tool:build", "Bash: npm run build", {
        input: { command: "npm run build" },
        status: "running",
      }),
    ),
  ]);
}

const waitingOn = (transcript: Transcript): Transcript =>
  applyEvents(transcript, [
    { type: "foreground-tasks", tasks: [{ id: "b7", call: BUILD }] },
  ]);

/** What the CLI says once it moved the command: its call returned, its task runs. */
const moved = (transcript: Transcript): Transcript =>
  applyEvents(transcript, [
    { type: "foreground-tasks", tasks: [] },
    put(
      tool("tool:build", "Bash: npm run build", {
        input: { command: "npm run build" },
        status: "succeeded",
        background: { state: "running", summary: undefined },
      }),
    ),
    {
      type: "background-tasks",
      tasks: [
        {
          id: "b7",
          kind: "shell",
          title: "Build the app",
          call: BUILD,
          startedAt: undefined,
          stoppable: true,
        },
      ],
    },
  ]);

const action = () =>
  screen.queryByRole("button", { name: "Run in Background" });
const row = () =>
  document.querySelector<HTMLElement>(".conversation-tool-entry")!;

describe("Run in Background on a call's row", () => {
  it("is offered only while the turn waits on work the CLI can move", () => {
    const { redraw } = draw(building());
    // Running, but not (yet) a task the CLI could move.
    expect(action()).toBeNull();
    redraw(waitingOn(building()));
    expect(action()).toBeInTheDocument();
    expect(row().querySelector("summary")).toContainElement(action());
  });

  it("asks for that call, without folding the call open", () => {
    const { actions } = draw(waitingOn(building()));
    const details = row().querySelector("details")!;
    fireEvent.click(action()!);
    expect(actions.runInBackground).toHaveBeenCalledWith(BUILD);
    expect(details.open).toBe(false);
  });

  it("goes once the call is moved: the row says it runs in the background, and the task is under the composer", () => {
    const { redraw } = draw(waitingOn(building()));
    redraw(moved(waitingOn(building())));
    expect(action()).toBeNull();
    expect(row()).toHaveAttribute("data-status", "running");
    expect(row().querySelector(".conversation-tool-status")).toHaveTextContent(
      "In the background",
    );
    expect(
      screen.getByRole("button", { name: /1 background task$|Build the app/ }),
    ).toBeInTheDocument();
  });

  it("reports a request that failed", async () => {
    const refused = new Error("no foreground task");
    const actions = fakeActions({
      runInBackground: vi.fn(() => Promise.reject(refused)),
    });
    draw(waitingOn(building()), actions);
    fireEvent.click(action()!);
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(refused),
    );
  });
});

describe("Ctrl+B", () => {
  it("moves everything the turn waits on, from the composer or the transcript", () => {
    const { actions } = draw(waitingOn(building()));
    fireEvent.keyDown(document.querySelector("textarea")!, {
      key: "b",
      ctrlKey: true,
    });
    fireEvent.keyDown(document.querySelector(".conversation-scroll")!, {
      key: "b",
      ctrlKey: true,
    });
    expect(actions.runInBackground).toHaveBeenCalledTimes(2);
    expect(actions.runInBackground).toHaveBeenCalledWith(undefined);
    expect(actions.interrupt).not.toHaveBeenCalled();
  });

  it("is left to the field while nothing can move, and with another modifier", () => {
    const { actions, redraw } = draw(building());
    const field = document.querySelector("textarea")!;
    const key = fireEvent.keyDown(field, { key: "b", ctrlKey: true });
    // Not taken: the field's own Ctrl+B (back a character, on a Mac) stands.
    expect(key).toBe(true);
    redraw(waitingOn(building()));
    fireEvent.keyDown(field, { key: "b", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(field, { key: "b", metaKey: true });
    fireEvent.keyDown(field, { key: "b", ctrlKey: true, isComposing: true });
    expect(actions.runInBackground).not.toHaveBeenCalled();
  });
});
