// @vitest-environment jsdom

/**
 * The Task Manager page: the header, the tree sorted and folded, and each
 * action handed to main — drawn from a snapshot, asked for while visible.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TaskManagerApi,
  TaskRowWire,
  TaskSnapshotWire,
} from "../ipc/taskManager";
import { REFRESH_MS, TaskManagerApp } from "./TaskManagerApp";
import { visibleRows } from "./rows";
import { TOKENS_REFRESH_MS } from "./TokensView";
import { visibleTokenRows } from "./tokenRows";
import { fixtureReport } from "../main/cli/tell/tokensTestKit";

const MB = 1024 ** 2;

function row(
  id: string,
  label: string,
  memoryMb: number,
  cpuPercent: number,
  extra: Partial<TaskRowWire> = {},
): TaskRowWire {
  return {
    id,
    kind: "process",
    label,
    memoryBytes: memoryMb * MB,
    residentBytes: (memoryMb * MB) / 2,
    cpuPercent,
    processCount: 1,
    actions: [],
    children: [],
    ...extra,
  };
}

const ANALYZER = row("pid:122", "rust-analyzer", 1800, 48, {
  pid: 122,
  actions: ["kill"],
});
const SNAPSHOT: TaskSnapshotWire = {
  takenAt: 0,
  memoryMetric: "footprint",
  system: {
    totalBytes: 16 * 1024 * MB,
    usedBytes: 14 * 1024 * MB,
    breakdown: {
      appBytes: 9 * 1024 * MB,
      wiredBytes: 3 * 1024 * MB,
      compressedBytes: 2 * 1024 * MB,
      compressorStoredBytes: 6 * 1024 * MB,
      cachedBytes: 1024 * MB,
      freeBytes: 1024 * MB,
    },
    swapUsedBytes: 3 * 1024 * MB,
    swapTotalBytes: 4 * 1024 * MB,
    pressure: "warning",
    pressureSource: "kern.memorystatus_vm_pressure_level",
  },
  total: {
    memoryBytes: 3000 * MB,
    residentBytes: 1200 * MB,
    cpuPercent: 60,
    processCount: 4,
  },
  rows: [
    row("devhub", "DevHub", 800, 5, { kind: "devhub", processCount: 2 }),
    row("workspace:w1", "widget", 2200, 55, {
      kind: "workspace",
      workspaceId: "w1",
      actions: ["reveal"],
      children: [
        row("terminal:w1", "Terminal", 2000, 50, {
          kind: "group",
          children: [ANALYZER, row("pid:120", "zsh", 200, 2)],
        }),
        row("agent:a1", "Fix the build", 200, 5, {
          kind: "agent",
          agentId: "a1",
          actions: ["stop", "reveal"],
        }),
      ],
    }),
  ],
};

function client(): TaskManagerApi & {
  [K in keyof TaskManagerApi]: ReturnType<typeof vi.fn>;
} {
  return {
    snapshot: vi.fn(() => Promise.resolve(SNAPSHOT)),
    stopAgent: vi.fn(() => Promise.resolve()),
    reveal: vi.fn(() => Promise.resolve()),
    kill: vi.fn(() => Promise.resolve(true)),
    copy: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    tokens: vi.fn(() => Promise.resolve(fixtureReport())),
    copyTokens: vi.fn(() => Promise.resolve()),
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.devhub = {
    raiseFailure: vi.fn(),
    onTheme: () => () => undefined,
    onNativeError: () => () => undefined,
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function shown(api: TaskManagerApi) {
  render(<TaskManagerApp client={api} />);
  return screen.findByRole("treegrid");
}

describe("the header", () => {
  it("states the machine's memory, its pressure, swap and DevHub's total", async () => {
    await shown(client());
    const header = screen.getByRole("region", { name: "System memory" });
    expect(header).toHaveTextContent("14.0 GB used of 16.0 GB");
    expect(header).toHaveTextContent("Warning");
    expect(header).toHaveTextContent("Swap3.00 GB of 4.00 GB");
    expect(header).toHaveTextContent("DevHub2.93 GB· 1.17 GB in RAM");
    const legend = within(header).getByRole("list", {
      name: "Where memory is",
    });
    expect(legend).toHaveTextContent("App9.00 GB");
    expect(legend).toHaveTextContent("Wired3.00 GB");
    expect(legend).toHaveTextContent("Compressed2.00 GBholds 6.00 GB");
    expect(legend).toHaveTextContent("Cached files1.00 GB");
    expect(legend).toHaveTextContent("Free1.00 GB");
  });
});

describe("the table", () => {
  it("is heaviest first, a Workspace open to its processes, DevHub folded", async () => {
    const grid = await shown(client());
    const names = within(grid)
      .getAllByRole("row")
      .slice(1)
      .map((one) => one.querySelector(".tm-label")?.textContent);
    expect(names).toEqual([
      "widget",
      "Terminal",
      "rust-analyzer",
      "zsh",
      "Fix the build",
      "DevHub",
    ]);
  });

  it("shows each row's footprint and what of it is in RAM, sortable by either", async () => {
    const grid = await shown(client());
    const analyzer = within(grid)
      .getAllByRole("row")
      .find((one) => one.textContent?.includes("rust-analyzer"))!;
    expect(analyzer).toHaveTextContent("1.76 GB");
    expect(analyzer).toHaveTextContent("900 MB");
    fireEvent.click(within(grid).getByRole("columnheader", { name: "In RAM" }));
    expect(
      within(grid).getByRole("columnheader", { name: "In RAM" }),
    ).toHaveAttribute("aria-sort", "descending");
    const toggled = new Set<string>();
    const resident = visibleRows(
      [
        row("a", "swapped out", 1000, 0, { residentBytes: 10 * MB }),
        row("b", "in RAM", 500, 0, { residentBytes: 500 * MB }),
      ],
      "resident",
      toggled,
    );
    expect(resident.map((one) => one.row.label)).toEqual([
      "in RAM",
      "swapped out",
    ]);
  });

  it("folds a row the person closed, and sorts by CPU when asked", () => {
    const toggled = new Set(["terminal:w1"]);
    expect(
      visibleRows(SNAPSHOT.rows, "cpu", toggled).map((one) => one.row.label),
    ).toEqual(["widget", "Terminal", "Fix the build", "DevHub"]);
  });

  it("asks again while visible, one request at a time", async () => {
    const api = client();
    await shown(api);
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    expect(api.snapshot).toHaveBeenCalledTimes(2);
  });

  it("asks nothing while the window is hidden", async () => {
    const api = client();
    await shown(api);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    });
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });
});

describe("what a row does", () => {
  it("hands each action to main", async () => {
    const api = client();
    const grid = await shown(api);
    fireEvent.click(within(grid).getByRole("button", { name: "Stop" }));
    expect(api.stopAgent).toHaveBeenCalledWith("a1");
    fireEvent.click(within(grid).getAllByRole("button", { name: "Show" })[0]!);
    expect(api.reveal).toHaveBeenCalledWith({
      kind: "workspace",
      workspaceId: "w1",
    });
  });

  it("copies the snapshot, and Escape closes the window", async () => {
    const api = client();
    const grid = await shown(api);
    fireEvent.click(screen.getByRole("button", { name: "Copy Snapshot" }));
    expect(api.copy).toHaveBeenCalled();
    fireEvent.keyDown(grid, { key: "Escape" });
    expect(api.close).toHaveBeenCalled();
  });

  it("says why an action was refused", async () => {
    const api = client();
    api.stopAgent.mockRejectedValueOnce(new Error("it is on screen"));
    const grid = await shown(api);
    fireEvent.click(within(grid).getByRole("button", { name: "Stop" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "it is on screen",
    );
  });
});

describe("the Tokens tab", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  async function tokens(api = client()) {
    await shown(api);
    fireEvent.click(screen.getByRole("tab", { name: "Tokens" }));
    const grid = await screen.findByRole("treegrid", { name: "Tokens" });
    return { api, grid };
  }

  it("asks for Claude's 5-hour window by Agent, and draws the totals and rows", async () => {
    const { api, grid } = await tokens();
    expect(api.tokens).toHaveBeenLastCalledWith({
      range: "window5h",
      by: "agent",
    });
    const totals = screen.getByRole("region", { name: "Token totals" });
    expect(within(totals).getByText("39.6K")).toBeInTheDocument();
    const rows = within(grid).getAllByRole("row").slice(1);
    expect(
      rows.map((one) => one.querySelector(".tm-label")?.textContent),
    ).toEqual(["Builder", "api"]);
    expect(within(rows[0]!).getByText("27.1K")).toBeInTheDocument();
  });

  it("switches to the cache-aware view without asking again, and says the cost is an estimate", async () => {
    const { api } = await tokens();
    const asked = api.tokens.mock.calls.length;
    fireEvent.click(screen.getByRole("radio", { name: "Cache-aware" }));
    expect(
      screen.getByRole("columnheader", { name: "Est. cost" }),
    ).toHaveAttribute("aria-sort", "descending");
    expect(
      screen.getByText(/a Claude plan is not billed this/u),
    ).toBeInTheDocument();
    expect(screen.getAllByText("$0.07").length).toBeGreaterThan(0);
    expect(api.tokens.mock.calls.length).toBe(asked);
  });

  it("is walked and opened from the keyboard", async () => {
    const { grid } = await tokens();
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid).toHaveAttribute("aria-activedescendant", "tk-row-agent:a1");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(within(grid).getByText("Survey the parser")).toBeInTheDocument();
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    expect(within(grid).queryByText("Survey the parser")).toBeNull();
  });

  it("moves the range and the grouping with the arrow keys", async () => {
    const { api } = await tokens();
    const range = screen.getByRole("radiogroup", { name: "Range" });
    fireEvent.keyDown(range, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Today" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.tokens).toHaveBeenLastCalledWith({
      range: "today",
      by: "agent",
    });
    fireEvent.click(screen.getByRole("radio", { name: "Task" }));
    expect(api.tokens).toHaveBeenLastCalledWith({ range: "today", by: "task" });
  });

  it("sorts by a column heading, again for the other way", async () => {
    const { grid } = await tokens();
    const output = screen.getByRole("button", { name: "Output" });
    fireEvent.click(output);
    fireEvent.click(output);
    expect(output.parentElement).toHaveAttribute("aria-sort", "ascending");
    const rows = within(grid).getAllByRole("row").slice(1);
    expect(rows[0]!.querySelector(".tm-label")?.textContent).toBe("api");
  });

  it("asks again while shown, and the processes stop being read", async () => {
    const { api } = await tokens();
    const snapshots = api.snapshot.mock.calls.length;
    const asked = api.tokens.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOKENS_REFRESH_MS + 10);
    });
    expect(api.tokens.mock.calls.length).toBe(asked + 1);
    expect(api.snapshot.mock.calls.length).toBe(snapshots);
  });

  it("chooses a tab with ⌘1 and ⌘2", async () => {
    await shown(client());
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(screen.getByRole("tab", { name: "Tokens" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(
      await screen.findByRole("treegrid", { name: "Processes" }),
    ).toBeInTheDocument();
  });

  it("copies the table as the CLI prints it, in the view shown", async () => {
    const { api } = await tokens();
    fireEvent.click(screen.getByRole("radio", { name: "Cache-aware" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Table" }));
    expect(api.copyTokens).toHaveBeenCalledWith(
      { range: "window5h", by: "agent" },
      "weighted",
    );
  });

  it("folds every row until opened, children sorted as their parents", () => {
    const report = fixtureReport();
    const sort = { key: "total" as const, ascending: false };
    expect(
      visibleTokenRows(report.rows, "raw", sort, new Set()).map(
        (one) => one.row.label,
      ),
    ).toEqual(["Builder", "api"]);
    expect(
      visibleTokenRows(report.rows, "raw", sort, new Set(["agent:a1"])).map(
        (one) => [one.row.label, one.depth],
      ),
    ).toEqual([
      ["Builder", 0],
      ["Survey the parser", 1],
      ["Main conversation", 1],
      ["Subagent inline1", 1],
      ["api", 0],
    ]);
  });
});
