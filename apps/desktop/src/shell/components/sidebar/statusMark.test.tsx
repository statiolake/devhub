// @vitest-environment jsdom

/**
 * The Agent status mark.
 *
 * Two things are worth holding still here. The first is that the four statuses
 * are four *silhouettes*, not one silhouette in four colours: a reader with no
 * colour, or a screenshot in greyscale, still has to be able to tell working
 * from waiting. The second is that the vocabulary is the one the sibling
 * extension already uses (`vscode-herdr-switcher`, `src/agentPresentation.ts`),
 * because the same Agent is shown in both places and two vocabularies for one
 * Agent is a vocabulary nobody can rely on.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentStatus } from "../../../ipc/appShell";
import { StatusMark } from "./StatusMark";

const STATUSES: readonly AgentStatus[] = [
  "working",
  "waiting",
  "idle",
  "error",
  "unknown",
];

function pathOf(status: AgentStatus): string {
  const { container } = render(<StatusMark status={status} />);
  const path = container.querySelector("path");
  expect(path).not.toBeNull();
  return path?.getAttribute("d") ?? "";
}

describe("the Agent status mark", () => {
  afterEach(cleanup);

  it("names every status for a reader and for hover", () => {
    for (const status of STATUSES) {
      cleanup();
      render(<StatusMark status={status} />);
      const mark = screen.getByRole("img");
      const label = {
        working: "Working",
        waiting: "Waiting",
        idle: "Idle",
        error: "Error",
        unknown: "Unknown",
      }[status];
      expect(mark).toHaveAccessibleName(label);
      expect(mark).toHaveAttribute("title", label);
    }
  });

  it("draws a different shape for each status, so colour is never the only telling", () => {
    const shapes = new Set<string>();
    for (const status of STATUSES) {
      cleanup();
      shapes.add(pathOf(status));
    }
    expect(shapes.size).toBe(STATUSES.length);
  });

  it("carries the status on the element, so the stylesheet colours it in one place", () => {
    for (const status of STATUSES) {
      cleanup();
      render(<StatusMark status={status} />);
      expect(screen.getByRole("img")).toHaveAttribute("data-status", status);
      expect(screen.getByRole("img")).toHaveClass(`status-mark-${status}`);
    }
  });

  it("uses the codicons the extension uses, not lookalikes", () => {
    // The opening move of each codicon's own path data. A silhouette that
    // drifted from the extension's would fail here rather than in someone's
    // eyes a month later.
    cleanup();
    expect(pathOf("working")).toMatch(/^M13\.5 8\.5C/); // loading
    cleanup();
    expect(pathOf("waiting")).toMatch(/^M8 4C/); // circle-filled
    cleanup();
    expect(pathOf("idle")).toMatch(/^M13\.6572 3\.13573C/); // check
    cleanup();
    expect(pathOf("error")).toMatch(/^M14\.831 11\.965L/); // warning
    cleanup();
    expect(pathOf("unknown")).toMatch(/^M8 11C/); // question
  });
});
