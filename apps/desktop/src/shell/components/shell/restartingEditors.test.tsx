// @vitest-environment jsdom

/**
 * The in-place restarting state.
 *
 * A workbench that ends for a reason DevHub did not choose does not move the
 * selection: the Editor activity stays selected and the workbench is rebuilt
 * in the same slot. What the person sees in the meantime is this — and it has
 * to be *this*, not an empty rectangle and not a claim that a workbench is on
 * screen when none is.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorRestartingWire } from "../../../ipc/contract";
import { useRestartingEditors } from "./workbenchDialogs";

let listener: ((event: EditorRestartingWire) => void) | undefined;
let subscriptions = 0;

vi.mock("../../client", () => ({
  devhub: () => ({
    onEditorRestarting: (next: (event: EditorRestartingWire) => void) => {
      subscriptions += 1;
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  }),
}));

function Probe({ surfaceKey }: { readonly surfaceKey: string }) {
  const restarting = useRestartingEditors();
  return (
    <div data-testid="state">
      {restarting.has(surfaceKey) ? "editor-restarting" : "editor"}
    </div>
  );
}

const SURFACE = "workspace-editor:63752e9f-c93d-4d49-87f0-70f352eea8b0";

function announce(event: EditorRestartingWire): void {
  act(() => {
    if (!listener) throw new Error("nothing subscribed to editor restarts");
    listener(event);
  });
}

describe("the in-place restarting state", () => {
  afterEach(() => {
    cleanup();
    listener = undefined;
    subscriptions = 0;
  });

  it("shows the workbench is restarting, then stops when it is back", () => {
    render(<Probe surfaceKey={SURFACE} />);
    expect(screen.getByTestId("state")).toHaveTextContent("editor");

    announce({ surfaceKey: SURFACE, restarting: true });
    expect(screen.getByTestId("state")).toHaveTextContent("editor-restarting");

    announce({ surfaceKey: SURFACE, restarting: false });
    expect(screen.getByTestId("state")).toHaveTextContent("editor");
  });

  it("keeps its subscription for as long as it is mounted", () => {
    // The event arrives long after the first render — a crash is not a
    // mount-time occurrence — so a subscription torn down by a re-render or
    // by an effect that re-runs would miss every one that matters.
    const view = render(<Probe surfaceKey={SURFACE} />);
    const afterMount = subscriptions;
    view.rerender(<Probe surfaceKey={SURFACE} />);
    view.rerender(<Probe surfaceKey={SURFACE} />);
    // Re-rendering must not re-subscribe: an effect that re-runs is one that
    // was torn down first, and that gap is exactly where an event is lost.
    expect(subscriptions).toBe(afterMount);
    expect(listener).toBeDefined();

    announce({ surfaceKey: SURFACE, restarting: true });
    expect(screen.getByTestId("state")).toHaveTextContent("editor-restarting");
  });

  it("is about one workbench, not all of them", () => {
    render(<Probe surfaceKey={SURFACE} />);
    announce({ surfaceKey: "global-editor", restarting: true });
    expect(screen.getByTestId("state")).toHaveTextContent("editor");
  });
});
