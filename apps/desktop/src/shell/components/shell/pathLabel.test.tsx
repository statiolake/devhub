// @vitest-environment jsdom

/**
 * A path is truncated, never reordered.
 *
 * The trick this replaced moved the ellipsis to the leading edge by setting
 * `direction: rtl` on the line, which reorders the neutral characters a path
 * is full of: `~/dev` — short enough to need no truncation at all — was drawn
 * as `dev/~`. So what is asserted here is the order of the characters and
 * which half is allowed to give way, not any particular pixel width.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PathLabel, splitPath } from "./PathLabel";

describe("a path on one line", () => {
  afterEach(cleanup);

  it("reads in the order it was written, however short", () => {
    render(<PathLabel path="~/dev" />);
    expect(screen.getByLabelText("~/dev")).toHaveTextContent(/^~\/dev$/);
  });

  it("keeps the last segment out of the half that gives way", () => {
    // The head is the shrinkable element, so the folder's own name is the last
    // thing to be lost rather than the first.
    // The separator goes with the tail, so a truncated line reads as one path
    // with a piece missing — `/Users/someone/dev/git…/devhub` — rather than as
    // two strings that happen to sit next to each other.
    expect(splitPath("/Users/someone/dev/github/devhub")).toEqual({
      head: "/Users/someone/dev/github",
      tail: "/devhub",
    });
  });

  it("has nothing to give way when there is one segment", () => {
    expect(splitPath("devhub")).toEqual({ head: "", tail: "devhub" });
    expect(splitPath("/devhub")).toEqual({ head: "", tail: "/devhub" });
  });

  it("says the whole path once, to a reader and on hover", () => {
    render(<PathLabel path="/Users/someone/dev/github/devhub" />);
    const label = screen.getByLabelText("/Users/someone/dev/github/devhub");
    expect(label).toHaveAttribute("title", "/Users/someone/dev/github/devhub");
    // The two halves are presentation; a reader must not hear the path split
    // into two announcements.
    expect(label.querySelectorAll("[aria-hidden=true]")).toHaveLength(2);
  });
});
