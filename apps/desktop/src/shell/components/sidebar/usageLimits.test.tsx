// @vitest-environment jsdom

/**
 * The usage-limits readout at the foot of the Sidebar: nothing until a CLI has
 * reported, a slim bar per CLI that has, and the detail — a meter per window,
 * and the CLI that has not reported — in the row tooltip's lines.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TooltipLineWire } from "../../../ipc/contract";
import { UsageLimits } from "./UsageLimits";

afterEach(cleanup);

// The reset reads on the local calendar: the zone is pinned, and NOW is
// 18:00 on 25 September in it.
let zone: string | undefined;
beforeAll(() => {
  zone = process.env["TZ"];
  process.env["TZ"] = "Asia/Tokyo";
});
afterAll(() => {
  if (zone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = zone;
});

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

  it("draws a bar per CLI for its window nearest the limit, every window as a meter on hover, and that the other has not reported", () => {
    render(
      <UsageLimits
        limits={{
          clis: [
            {
              cli: "claude",
              windows: [
                { window: "5-hour", usedPercent: 12, resetsAt: NOW + 2 * HOUR },
                {
                  window: "7-day",
                  usedPercent: 97.6,
                  resetsAt: NOW + 50 * HOUR,
                },
              ],
            },
            { cli: "codex" },
          ],
        }}
        now={NOW}
      />,
    );
    const readout = screen.getByRole("status");
    expect(readout).toHaveAccessibleName("Usage limits: Claude 98% until 9/27");
    expect(readout).not.toHaveTextContent("Codex");
    const claude = readout.querySelector(".sidebar-usage-cli")!;
    // The seven-day window resets on another day: the date alone.
    expect(claude).toHaveTextContent("Claude98%(until 9/27)");
    // At its limit: coloured, by the rule every usage meter keeps.
    expect(claude).toHaveAttribute("data-level", "at");
    expect(
      (
        claude.querySelector(".sidebar-usage-fill") as HTMLElement
      ).style.getPropertyValue("--usage-fill"),
    ).toBe("97.6%");
    expect(tooltipOf(readout)).toEqual([
      { text: "Claude", style: "name" },
      {
        kind: "meter",
        label: "5-hour",
        usedPercent: 12,
        resetsAt: NOW + 2 * HOUR,
      },
      {
        kind: "meter",
        label: "7-day",
        usedPercent: 97.6,
        resetsAt: NOW + 50 * HOUR,
      },
      { text: "Codex", style: "name" },
      {
        text: "Not reported yet: no Codex GUI Agent has said",
        style: "note",
      },
    ]);
  });

  it("shows the current window over one that is history, and a CLI whose readings are all history faded", () => {
    render(
      <UsageLimits
        limits={{
          clis: [
            {
              cli: "claude",
              windows: [
                { window: "5-hour", usedPercent: 90, resetsAt: NOW - HOUR },
                { window: "7-day", usedPercent: 30, resetsAt: NOW + HOUR },
              ],
            },
            {
              cli: "codex",
              windows: [
                { window: "5-hour", usedPercent: 96, resetsAt: NOW - HOUR },
              ],
            },
          ],
        }}
        now={NOW}
      />,
    );
    const [claude, codex] = [
      ...screen.getByRole("status").querySelectorAll(".sidebar-usage-cli"),
    ];
    // Resets within the hour, today: the time.
    expect(claude).toHaveTextContent("Claude30%(until 19:00)");
    expect(claude).not.toHaveAttribute("data-stale");
    // Its reset is past: no parenthesis rather than an old time.
    expect(codex).toHaveTextContent(/^Codex96%$/u);
    expect(codex.querySelector(".sidebar-usage-reset")).toBeNull();
    expect(codex).toHaveAttribute("data-stale", "true");
    // History is not a warning.
    expect(codex).toHaveAttribute("data-level", "calm");
    expect(screen.getByRole("status")).toHaveAccessibleName(
      "Usage limits: Claude 30% until 19:00, Codex 96% before its last reset",
    );
  });

  it("leaves the parenthesis out when the reset was not reported", () => {
    render(
      <UsageLimits
        limits={{
          clis: [
            { cli: "codex", windows: [{ window: "weekly", usedPercent: 41 }] },
          ],
        }}
        now={NOW}
      />,
    );
    const codex = screen
      .getByRole("status")
      .querySelector(".sidebar-usage-cli")!;
    expect(codex).toHaveTextContent(/^Codex41%$/u);
    expect(codex.querySelector(".sidebar-usage-reset")).toBeNull();
  });

  it("colours a row by the shared rule: quiet below 75%, warning from 75%, danger from 90%", () => {
    const levels = [74, 75, 89, 90].map((usedPercent) => {
      render(
        <UsageLimits
          limits={{
            clis: [
              {
                cli: "claude",
                windows: [
                  { window: "5-hour", usedPercent, resetsAt: NOW + HOUR },
                ],
              },
            ],
          }}
          now={NOW}
        />,
      );
      const level = screen
        .getByRole("status")
        .querySelector(".sidebar-usage-cli")!
        .getAttribute("data-level");
      cleanup();
      return level;
    });
    expect(levels).toEqual(["calm", "near", "near", "at"]);
  });
});
