// @vitest-environment jsdom

/**
 * The usage-limits readout at the foot of the Sidebar: quiet until a CLI has
 * reported, one line when one has, and the detail — including the CLI that
 * has not — in the row tooltip's lines.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TooltipLineWire } from "../../../ipc/contract";
import { UsageLimits } from "./UsageLimits";

afterEach(cleanup);

const NOW = Date.UTC(2026, 8, 25, 9, 0);
const HOUR = 60 * 60 * 1000;

function tooltipOf(element: HTMLElement): readonly TooltipLineWire[] {
  return JSON.parse(
    element.dataset["tooltipLines"] ?? "[]",
  ) as TooltipLineWire[];
}

describe("the usage-limits readout", () => {
  it("draws nothing while neither CLI has reported", () => {
    const { container } = render(
      <UsageLimits
        limits={{ clis: [{ cli: "claude" }, { cli: "codex" }] }}
        now={NOW}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says what is used per CLI, and that the other has not reported", () => {
    render(
      <UsageLimits
        limits={{
          clis: [
            {
              cli: "claude",
              limit: { usedPercent: 97.6, resetsAt: NOW + 2 * HOUR },
            },
            { cli: "codex" },
          ],
        }}
        now={NOW}
      />,
    );
    const readout = screen.getByRole("status");
    expect(readout).toHaveTextContent("Claude 98%");
    expect(readout).not.toHaveTextContent("Codex");
    const lines = tooltipOf(readout).map((line) => line.text);
    expect(lines[0]).toBe("Claude usage limit");
    expect(lines[1]).toBe("98% used");
    expect(lines[2]).toMatch(/^Resets /u);
    expect(lines.slice(3)).toEqual([
      "Codex usage limit",
      "No Codex GUI Agent has reported it yet",
    ]);
  });

  it("says a reading from before its reset is history, not the present", () => {
    render(
      <UsageLimits
        limits={{
          clis: [
            { cli: "claude" },
            { cli: "codex", limit: { usedPercent: 40, resetsAt: NOW - HOUR } },
          ],
        }}
        now={NOW}
      />,
    );
    const readout = screen.getByRole("status");
    expect(readout).toHaveTextContent("Codex 40%");
    expect(tooltipOf(readout).at(-1)).toMatchObject({
      style: "note",
      text: expect.stringMatching(/nothing reported since$/u) as string,
    });
  });
});
