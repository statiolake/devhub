// @vitest-environment jsdom

/**
 * The one failure a page could not report: the page itself.
 *
 * `window.error` catches a component that throws while rendering — React
 * rethrows it — but by then React has unmounted the whole tree, so the answer
 * is published to a page with nothing left on it. A blank window is the report
 * nobody can act on, and it is the report DevHub gave.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageBoundary } from "./PageBoundary";

const raiseFailure = vi.fn();

// The boundary is on every page and so is `raiseFailure`, which is why the
// boundary reads the bridge page-agnostically rather than through any one
// page's client.
window.devhub = { raiseFailure };

function Breaks(): never {
  throw new Error("the sidebar could not be drawn");
}

afterEach(() => {
  cleanup();
  raiseFailure.mockClear();
});

describe("a component that threw while rendering", () => {
  it("leaves the page saying what happened rather than saying nothing", () => {
    // React logs the error itself; that is not what is under test.
    const quiet = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(
      <PageBoundary>
        <Breaks />
      </PageBoundary>,
    );
    quiet.mockRestore();

    expect(screen.getByLabelText("Error surface")).toHaveTextContent(
      "the sidebar could not be drawn",
    );
  });

  it("tells main, because a page that has stopped keeps no record", () => {
    const quiet = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(
      <PageBoundary>
        <Breaks />
      </PageBoundary>,
    );
    quiet.mockRestore();

    expect(raiseFailure).toHaveBeenCalledTimes(1);
    const raised = raiseFailure.mock.calls[0]?.[0] as { detail?: string };
    expect(raised.detail).toContain("the sidebar could not be drawn");
    // The component stack is the diagnosis, and React hands it over once.
    expect(raised.detail).toContain("Breaks");
  });
});

describe("a page that is working", () => {
  it("is left entirely alone", () => {
    render(
      <PageBoundary>
        <p>the sidebar</p>
      </PageBoundary>,
    );

    expect(screen.getByText("the sidebar")).toBeInTheDocument();
    expect(raiseFailure).not.toHaveBeenCalled();
  });
});
