// @vitest-environment jsdom

/**
 * What stands in an editor's slot while its workbench is not there.
 *
 * A workbench that ends for a reason DevHub did not choose, or sleeps, does
 * not move the selection: the Editor activity stays selected and the
 * workbench comes back in the same slot. What the person sees in the
 * meantime is this — and it has to be *this*, not an empty rectangle and not
 * a claim that a workbench is on screen when none is. Main says the whole
 * placeholder every time it changes; the page keeps the last word.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorPlaceholderEvent } from "../../../ipc/contract";
import { useEditorPlaceholders } from "./workbenchDialogs";

let listener: ((event: EditorPlaceholderEvent) => void) | undefined;
let subscriptions = 0;

vi.mock("../../client", () => ({
  devhub: () => ({
    onEditorPlaceholder: (next: (event: EditorPlaceholderEvent) => void) => {
      subscriptions += 1;
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  }),
}));

const SURFACE = "workspace-editor:63752e9f-c93d-4d49-87f0-70f352eea8b0";

function Probe({ surfaceKey }: { readonly surfaceKey: string }) {
  const placeholder = useEditorPlaceholders().get(surfaceKey);
  return (
    <div data-testid="state">
      {placeholder === undefined
        ? "editor"
        : `${placeholder.kind}${"frame" in placeholder ? ` ${placeholder.frame}` : ""}`}
    </div>
  );
}

function announce(event: EditorPlaceholderEvent): void {
  act(() => {
    if (!listener) throw new Error("nothing subscribed to editor placeholders");
    listener(event);
  });
}

describe("the editor's placeholder", () => {
  afterEach(() => {
    cleanup();
    listener = undefined;
    subscriptions = 0;
  });

  it("shows the workbench is restarting, then stops when it is back", () => {
    render(<Probe surfaceKey={SURFACE} />);
    expect(screen.getByTestId("state")).toHaveTextContent("editor");

    announce({ surfaceKey: SURFACE, placeholder: { kind: "restarting" } });
    expect(screen.getByTestId("state")).toHaveTextContent("restarting");

    announce({ surfaceKey: SURFACE });
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
    expect(subscriptions).toBe(afterMount);
    expect(listener).toBeDefined();

    announce({ surfaceKey: SURFACE, placeholder: { kind: "restarting" } });
    expect(screen.getByTestId("state")).toHaveTextContent("restarting");
  });

  it("is the last thing said: asleep, waking, then the workbench", () => {
    render(<Probe surfaceKey={SURFACE} />);
    announce({
      surfaceKey: SURFACE,
      placeholder: { kind: "asleep", frame: "data:x" },
    });
    expect(screen.getByTestId("state")).toHaveTextContent("asleep data:x");
    announce({
      surfaceKey: SURFACE,
      placeholder: { kind: "waking", frame: "data:x" },
    });
    expect(screen.getByTestId("state")).toHaveTextContent("waking data:x");
    // A failure while waking replaces the frame rather than keeping it.
    announce({ surfaceKey: SURFACE, placeholder: { kind: "restarting" } });
    expect(screen.getByTestId("state")).toHaveTextContent(/^restarting$/);
    announce({ surfaceKey: SURFACE });
    expect(screen.getByTestId("state")).toHaveTextContent("editor");
  });

  it("is about one workbench, not all of them", () => {
    render(<Probe surfaceKey={SURFACE} />);
    announce({
      surfaceKey: "global-editor",
      placeholder: { kind: "restarting" },
    });
    expect(screen.getByTestId("state")).toHaveTextContent("editor");
  });
});
