// @vitest-environment jsdom

/**
 * The usage-limits readout at the foot of the Sidebar: nothing until a CLI has
 * reported, a slim bar per CLI that has, and the detail — a meter per window,
 * and the CLI that has not reported — in the row tooltip's lines.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
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

  it("draws a bar per CLI for its window that resets soonest, coloured by its strictest window and captioned with it, every window as a meter on hover, and that the other has not reported", () => {
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
    expect(readout).toHaveAccessibleName(
      "Usage limits: Claude 12% until 20:00, 7-day limit nearly reached",
    );
    expect(readout).not.toHaveTextContent("Codex");
    const claude = readout.querySelector(".sidebar-usage-cli")!;
    // The five-hour window resets first: its number, its reset.
    expect(claude).toHaveTextContent(
      "Claude12%(until 20:00)7-day limit nearly reached",
    );
    expect(
      (
        claude.querySelector(".sidebar-usage-fill") as HTMLElement
      ).style.getPropertyValue("--usage-fill"),
    ).toBe("12%");
    // The seven-day window is at its limit: the row wears its colour, and the
    // caption under the bar says which window that is.
    expect(claude).toHaveAttribute("data-level", "at");
    expect(claude.querySelector(".sidebar-usage-caption")).toHaveTextContent(
      "7-day limit nearly reached",
    );
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
        text: "Not read yet",
        style: "note",
      },
    ]);
  });

  it("says quietly that a sign-in has no plan limits, and why a CLI was not read", () => {
    render(
      <UsageLimits
        limits={{
          clis: [
            { cli: "claude", note: "no_plan_limits" },
            { cli: "codex", note: "cli_not_found" },
          ],
        }}
        now={NOW}
      />,
    );
    const readout = screen.getByRole("status");
    expect(readout).toHaveAccessibleName("Usage limits: Claude No plan limits");
    const rows = readout.querySelectorAll(".sidebar-usage-cli");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("ClaudeNo plan limits");
    expect(rows[0]).toHaveAttribute("data-planless", "true");
    // No bar, and no colour: there is no limit to approach.
    expect(rows[0]!.querySelector(".sidebar-usage-track")).toBeNull();
    expect(rows[0]).not.toHaveAttribute("data-level");
    expect(tooltipOf(readout)).toEqual([
      { text: "Claude", style: "name" },
      {
        text: "No plan limits for this Claude sign-in: an API key or a cloud provider",
        style: "note",
      },
      { text: "Codex", style: "name" },
      {
        text: "Not read: the first Codex profile's command is not on this Mac",
        style: "note",
      },
    ]);
  });

  it("draws the windows when a CLI has any, whatever the reader's note", () => {
    render(
      <UsageLimits
        limits={{
          clis: [
            {
              cli: "claude",
              note: "no_plan_limits",
              windows: [
                { window: "5-hour", usedPercent: 40, resetsAt: NOW + HOUR },
              ],
            },
            { cli: "codex" },
          ],
        }}
        now={NOW}
      />,
    );
    const rows = screen
      .getByRole("status")
      .querySelectorAll(".sidebar-usage-cli");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Claude40%(until 19:00)");
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
      const row = screen
        .getByRole("status")
        .querySelector(".sidebar-usage-cli")!;
      const level = row.getAttribute("data-level");
      // Its own window is the reason: nothing to caption.
      expect(row.querySelector(".sidebar-usage-caption")).toBeNull();
      cleanup();
      return level;
    });
    expect(levels).toEqual(["calm", "near", "near", "at"]);
  });

  it("gives every row's bar the same box, however long the words beside it", () => {
    // jsdom lays nothing out, so the stylesheet is applied and each bar's
    // placement read back: one grid for the readout, every row a subgrid of
    // it, every bar in the same column of it, the words in their own.
    const style = document.createElement("style");
    style.textContent = readFileSync("src/shell/styles/shell.css", "utf8");
    document.head.append(style);
    try {
      render(
        <UsageLimits
          limits={{
            clis: [
              {
                cli: "claude",
                windows: [
                  { window: "5-hour", usedPercent: 5, resetsAt: NOW + HOUR },
                  {
                    window: "7-day",
                    usedPercent: 80,
                    resetsAt: NOW + 50 * HOUR,
                  },
                ],
              },
              {
                cli: "codex",
                windows: [{ window: "weekly", usedPercent: 100 }],
              },
            ],
          }}
          now={NOW}
        />,
      );
      const readout = screen.getByRole("status");
      const rows = [...readout.querySelectorAll(".sidebar-usage-cli")];
      expect(rows).toHaveLength(2);
      // Different words beside each bar: a parenthesis and a caption on one,
      // neither on the other.
      expect(rows[0]).toHaveTextContent("(until 19:00)");
      expect(rows[1]!.querySelector(".sidebar-usage-reset")).toBeNull();
      expect(getComputedStyle(readout).display).toBe("grid");
      expect(getComputedStyle(readout).gridTemplateColumns).toBe(
        "3.6em minmax(16px, 1fr) 2.6em minmax(0, max-content)",
      );
      const boxes = rows.map((row) => {
        const track = row.querySelector(".sidebar-usage-track")!;
        expect(track.parentElement).toBe(row);
        return {
          row: [
            getComputedStyle(row).gridColumn,
            getComputedStyle(row).gridTemplateColumns,
          ],
          track: [
            getComputedStyle(track).gridColumn,
            getComputedStyle(track).width,
          ],
        };
      });
      expect(boxes[0]).toEqual({
        row: ["1 / -1", "subgrid"],
        track: ["2", ""],
      });
      expect(boxes[1]).toEqual(boxes[0]);
      const columns = (selector: string) =>
        rows.flatMap((row) =>
          [...row.querySelectorAll(selector)].map(
            (element) => getComputedStyle(element).gridColumn,
          ),
        );
      expect(columns(".sidebar-usage-name")).toEqual(["1", "1"]);
      expect(columns(".sidebar-usage-value")).toEqual(["3", "3"]);
      expect(columns(".sidebar-usage-reset")).toEqual(["4"]);
      // The caption is under the bar, from its left edge to the row's end.
      expect(columns(".sidebar-usage-caption")).toEqual(["2 / -1"]);
    } finally {
      style.remove();
    }
  });
});
