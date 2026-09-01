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

  it("draws every status on the Sidebar's own grid, so the column is one column", () => {
    // The marks used to be codicon outlines on a 16-unit box, next to stroked
    // 14-unit glyphs, next to filled Octicons — three conventions inside two
    // hundred pixels, which is what made the column unreadable. There is one
    // convention now and it is `sidebar-glyph`; a mark that stopped carrying
    // it would be a mark drawing itself its own way again.
    for (const status of STATUSES) {
      cleanup();
      const { container } = render(<StatusMark status={status} />);
      const svg = container.querySelector("svg");
      expect(svg).toHaveClass("sidebar-glyph");
      expect(svg).toHaveClass("status-glyph");
      expect(svg).toHaveAttribute("viewBox", "0 0 16 16");
    }
  });

  it("keeps the unread dot's silhouette to the unread dot", () => {
    // `waiting` was a filled disc and the unread mark in the same row's rail
    // is a filled disc, sixteen pixels apart in the same blue: one drawing,
    // two meanings, on one row. Whatever `waiting` becomes, it is not a disc.
    cleanup();
    const { container } = render(<StatusMark status="waiting" />);
    expect(container.querySelector("circle")).toBeNull();
  });
});
