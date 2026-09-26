// @vitest-environment jsdom

/**
 * How an Agent's row is laid out: what leads it, what follows on the same line,
 * and where its one mark is.
 *
 * The word that leads is the Agent's own — the title its program set — at the
 * size a row's name is set in, because the Agents under one Workspace are told
 * apart by what each is doing and not by being called "Claude" and "Codex".
 * What follows it, dimmed, is what tells two of them apart when the doing does
 * not: the ordinal, or a name somebody gave it. The bare kind word is dropped,
 * because it is the one fact on the row that nobody needs — it is what you
 * chose when you started the Agent, and there is a status mark in front of it.
 *
 * An Agent that has said nothing leads with its name instead, because the line
 * is never empty.
 *
 * One mark, and it is the status. Unread is drawn *by* that mark and only when
 * the Agent is idle — see `unreadShows` — because an Agent that is working,
 * waiting or in error is already asking to be looked at.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentControlStateWire,
  AgentStatus,
  AppSnapshot,
} from "../../../ipc/appShell";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { closeDiagnosticLabel } from "../shell/diagnosticLabel";
import { ON_SCRATCH, SCRATCH_ID, scratchWorkspace } from "./scratchFixture";

window.devhub = {
  openModal: () => Promise.resolve(""),
  onMenuCommand: () => () => undefined,
  // The Sidebar asks main for its tooltips now rather than drawing them
  // (`RowTooltip.tsx`), so every render of it reaches these three.
  onSidebarArea: () => () => undefined,
  showTooltip: () => undefined,
  hideTooltip: () => undefined,
  releaseTooltip: () => undefined,
} as unknown as typeof window.devhub;

afterEach(cleanup);

function snapshotWithAgent(
  activity: string | undefined,
  unread: AgentStatus | undefined = undefined,
  controlState: AgentControlStateWire = { kind: "running" },
): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: { context: ON_SCRATCH, presentation: "full" },
    sidebar: { width: 248 },
    splitRatio: 0.55,
    scratchWorkspaceId: SCRATCH_ID,
    workspaces: [
      scratchWorkspace(),
      {
        id: "w-1",
        label: "widget",
        location: { kind: "local" },
        editor: { kind: "host" },
        root: "/projects/widget",
        displayRoot: "/projects/widget",
        key: "/projects/widget",
        selectedPath: "/projects/widget",
        state: { kind: "available" },
        close: { kind: "idle" },
        canCreateAgent: true,
        agents: [
          {
            id: "a-1",
            workspaceId: "w-1",
            profileId: "claude",
            displayName: "Claude 1",
            ordinal: 1,
            status: "working",
            runtimeHealth: "healthy",
            controlState,
            unread,
            activity,
          },
        ],
      },
    ],
  } as unknown as AppSnapshot;
}

function mount(
  activity: string | undefined,
  unread: AgentStatus | undefined = undefined,
  controlState: AgentControlStateWire = { kind: "running" },
): void {
  const value = {
    dispatch: vi.fn().mockResolvedValue(undefined),
    openExternalUrl: vi.fn(),
    agentProfiles: {
      sequence: 1,
      availability: "available",
      // The kind word the row drops, as the row learns it: from the profile
      // the Agent was started from.
      profiles: [{ id: "claude", displayName: "Claude" }],
    },
    usageLimits: { clis: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as SidebarValue;
  render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={snapshotWithAgent(activity, unread, controlState)} />
    </SidebarContext.Provider>,
  );
}

/** The same row, with a name and a status of the test's choosing. */
function mountNamed(
  displayName: string,
  activity: string | undefined,
  status: AgentStatus = "working",
  unread: AgentStatus | undefined = undefined,
): void {
  const value = {
    dispatch: vi.fn().mockResolvedValue(undefined),
    openExternalUrl: vi.fn(),
    agentProfiles: {
      sequence: 1,
      availability: "available",
      profiles: [{ id: "claude", displayName: "Claude" }],
    },
    usageLimits: { clis: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as SidebarValue;
  const snapshot = snapshotWithAgent(activity, unread);
  const withAgent = {
    ...snapshot,
    workspaces: snapshot.workspaces.map((workspace) => ({
      ...workspace,
      agents: workspace.agents.map((agent) => ({
        ...agent,
        displayName,
        status,
      })),
    })),
  } as unknown as AppSnapshot;
  render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={withAgent} />
    </SidebarContext.Provider>,
  );
}

/** An Agent that is idle, which is the one state unread is drawn in. */
function mountIdle(unread: AgentStatus | undefined): void {
  mountNamed("Claude 1", undefined, "idle", unread);
}

/** What an Agent row leads with, and what follows it on the same line. */
function agentLines(): {
  readonly leading: string | undefined;
  readonly after: string | undefined;
} {
  const row = document.querySelector(".agent-row");
  const after = [
    row?.querySelector(".row-name")?.textContent,
    row?.querySelector(".row-note")?.textContent,
  ].filter((part) => part !== null && part !== undefined);
  return {
    leading: row?.querySelector(".row-label")?.textContent ?? undefined,
    after: after.length > 0 ? after.join(" ") : undefined,
  };
}

/** Which mark the row's one status glyph is drawing. */
function statusGlyph(): string | null | undefined {
  return document
    .querySelector(".agent-row .status-mark svg")
    ?.getAttribute("data-glyph");
}

describe("what an Agent's row leads with", () => {
  it("leads with what the Agent is doing, and names itself after it", () => {
    mount("Reading the reconciler");
    expect(agentLines()).toEqual({
      leading: "Reading the reconciler",
      after: "Claude 1",
    });
  });

  /**
   * The kind word is the profile's own name, and it says nothing a person did
   * not already know from the mark in front of it. "Claude 1" is kept because
   * the ordinal is what tells two Claudes apart; a lone "Claude" is dropped.
   */
  it("drops the name when the name is only the kind of Agent it is", () => {
    mountNamed("Claude", "Reading the reconciler");
    expect(agentLines()).toEqual({
      leading: "Reading the reconciler",
      after: undefined,
    });
  });

  /**
   * The row's accessible name is the same facts in words, from the same
   * composition — including the name the *row* drops, because a reader has no
   * mark to read the kind off and the words are all they get.
   */
  it("says all of it in the row's accessible name, kind word included", () => {
    mountNamed("Claude", "Reading the reconciler");
    expect(
      screen.getByRole("button", {
        name: /Claude[\s\S]*Reading the reconciler/u,
      }),
    ).toBeInTheDocument();
  });

  it("leads with its name when the Agent has said nothing", () => {
    mount(undefined);
    // Nothing after it: the name is the leading word, and repeating it would
    // be the row saying one thing twice.
    expect(agentLines()).toEqual({ leading: "Claude 1", after: undefined });
  });
});

/** The lines the Agent row hands the tooltip page.
 *
 * Off the row, which is what the tooltip is about and what the pointer is on
 * in both states — and in the rail it is the only element that has a box to be
 * beside, because there an Agent's select button holds nothing at all.
 */
function agentTooltip(): unknown {
  return JSON.parse(
    document.querySelector(".agent-row")?.getAttribute("data-tooltip-lines") ??
      "[]",
  );
}

/**
 * An Agent's tooltip is one line, where a Workspace's is a list.
 *
 * A Workspace has facts a person cannot see on the row — the path, the branch,
 * the Issue. An Agent has none: the status is the mark, the note is drawn on
 * the row, and the Workspace is the row directly above it. What the box is for
 * is the one thing the rail cuts off, which is the row's own leading text.
 */
describe("what an Agent's tooltip says", () => {
  it("is the row's mark and the row's leading text, and nothing else", () => {
    mount("Reading the reconciler");
    expect(agentTooltip()).toEqual([
      {
        icon: "statusWorking",
        text: "Reading the reconciler",
        tone: "working",
      },
    ]);
  });

  it("falls back to the Agent's name the way the row does", () => {
    mountNamed("Claude 1", undefined, "idle");
    expect(agentTooltip()).toEqual([
      { icon: "statusIdle", text: "Claude 1", tone: "idle" },
    ]);
  });

  /** The unread mark is the row's mark, so it is the tooltip's mark too. */
  it("wears the unread mark and its colour when the row does", () => {
    mountIdle("waiting");
    expect(agentTooltip()).toEqual([
      { icon: "statusUnread", text: "Claude 1", tone: "waiting" },
    ]);
  });

  /**
   * And the reader keeps everything. The box is cut down because the person
   * reading it can see the mark and the row; a screen reader can see neither,
   * so the accessible name is still the whole list of facts in words.
   */
  it("leaves the row's accessible name whole", () => {
    mountNamed("Claude 1", "Reading the reconciler", "waiting");
    const name =
      document
        .querySelector(".agent-row .sidebar-context-button")
        ?.getAttribute("aria-label") ?? "";
    expect(name).toContain("Claude 1");
    expect(name).toContain("Waiting agent");
    expect(name).toContain("Reading the reconciler");
  });
});

/**
 * Where an Agent's mark is: the one leading column every row has, before any
 * depth, so that every Agent's status is at the same x as its Workspace's
 * folder and as every other status in the list. The marks used to sit after
 * the indent, which stepped them right as the tree went deeper and left no
 * column to run an eye down; then they sat in a gutter of their own in front
 * of the glyph column, which was two leading columns to say one thing.
 */
describe("the column an Agent's status is in", () => {
  it("is the row's one icon column, outside the row's own button", () => {
    mount("Reading the reconciler");
    const row = document.querySelector(".agent-row");
    expect(row?.querySelector(".row-glyph > .status-mark")).toBeInTheDocument();
    expect(
      row?.querySelector(".sidebar-context-button .status-mark"),
    ).toBeNull();
  });

  /** The same column on a Workspace row, with that row's own mark in it. One
      column and one mark per row is what makes the collapse to the rail a
      subtraction: the connector and the words come off, the icon does not
      move. */
  it("is the column a Workspace draws its folder in", () => {
    mount("Reading the reconciler");
    const glyph = document.querySelector(
      ".workspace-row:not(.is-scratch) .row-glyph",
    );
    expect(glyph).toBeInTheDocument();
    expect(glyph?.querySelector("svg")).toBeInTheDocument();
    expect(document.querySelector(".row-rail")).toBeNull();
  });
});

describe("how an Agent says it has not been read", () => {
  /**
   * One mark, not two. The dot used to sit in the row's leading rail beside
   * the status glyph, which is two marks about one Agent in a column sixteen
   * pixels wide — and the second one only ever added anything in one case.
   */
  it("is the status mark itself when the Agent finished while nobody looked", () => {
    mountIdle("idle");
    expect(statusGlyph()).toBe("statusUnread");
    expect(document.querySelectorAll(".agent-row .status-mark")).toHaveLength(
      1,
    );
  });

  /**
   * The case the second mark was for, and the reason it is gone: an Agent that
   * is waiting is already asking to be looked at, in its own colour, and a dot
   * beside it only said "and also look at it".
   */
  it("leaves a busy Agent's own mark alone, unread or not", () => {
    mount("Reading the reconciler", "waiting");
    expect(statusGlyph()).toBe("statusWorking");
  });

  it("draws the ordinary idle mark when there is nothing owed", () => {
    mountIdle(undefined);
    expect(statusGlyph()).toBe("statusIdle");
  });

  /** And says so, for the reader who cannot see which mark it is. */
  it("says unread in the mark's own label, and only then", () => {
    mountIdle("waiting");
    expect(document.querySelector(".agent-row .status-mark")).toHaveAttribute(
      "aria-label",
      "Idle, unread",
    );
    cleanup();
    mount("Reading the reconciler", "waiting");
    expect(document.querySelector(".agent-row .status-mark")).toHaveAttribute(
      "aria-label",
      "Working",
    );
  });
});

/**
 * A stop that failed says why.
 *
 * DevHub computes a diagnostic when a stop fails and used to keep it: the tag
 * alone crossed the wire, so the row could say the Agent would not stop and
 * never why. The reason now crosses with the state that carries it, and the
 * row states it in the same vocabulary every other reason is stated in.
 */
describe("an Agent that would not stop", () => {
  it("says why on the row, not merely that the stop failed", () => {
    mount(undefined, undefined, {
      kind: "stop-failed",
      diagnostic: "close_agents_unknown",
    });
    expect(agentLines().after).toContain(
      closeDiagnosticLabel("close_agents_unknown"),
    );
    expect(agentLines().after).not.toBe("Stop failed");
  });

  it("says it in the row's accessible name too", () => {
    mount(undefined, undefined, {
      kind: "stop-failed",
      diagnostic: "close_editor_vetoed",
    });
    expect(
      screen.getByRole("button", {
        name: new RegExp(closeDiagnosticLabel("close_editor_vetoed")),
      }),
    ).toBeInTheDocument();
  });
});
