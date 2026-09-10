// @vitest-environment jsdom

/**
 * How an Agent's row is laid out: what leads it, what is under that, and where
 * its marks are.
 *
 * The word is the Agent's own — the title its program set. It *leads* the row,
 * at the size a row's name is set in, because the Agents under one Workspace
 * are told apart by what each is doing and not by being called "Claude" and
 * "Codex". The name follows on the quiet second line, and it is still always
 * there: a row that said only "Reading the reconciler" would not say which of
 * three Agents was reading it.
 *
 * An Agent that has said nothing leads with its name instead, because the
 * leading line is never empty.
 */

import { readFileSync } from "node:fs";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentControlStateWire,
  AgentStatus,
  AppSnapshot,
} from "../../../ipc/appShell";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { Sidebar } from "./Sidebar";
import { closeDiagnosticLabel } from "../shell/diagnosticLabel";

window.devhub = {
  openModal: () => Promise.resolve(""),
  onMenuCommand: () => () => undefined,
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
    selection: { context: { kind: "global" }, presentation: "full" },
    sidebar: { width: 248 },
    splitRatio: 0.55,
    workspaces: [
      {
        id: "w-1",
        label: "widget",
        root: "/projects/widget",
        selectedPath: "/projects/widget",
        state: { kind: "available" },
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
    dispatch: vi.fn(),
    openExternalUrl: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <Sidebar
        snapshot={snapshotWithAgent(activity, unread, controlState)}
        onDispatch={vi.fn()}
      />
    </AppShellContext.Provider>,
  );
}

/** The text of an Agent row's leading line, and of the line under it. */
function agentLines(): {
  readonly leading: string | undefined;
  readonly under: string | undefined;
} {
  const row = document.querySelector(".agent-row");
  return {
    leading: row?.querySelector(".row-label")?.textContent ?? undefined,
    under: row?.querySelector(".row-line-secondary")?.textContent ?? undefined,
  };
}

describe("what an Agent's row leads with", () => {
  it("leads with what the Agent is doing, and names itself underneath", () => {
    mount("Reading the reconciler");
    expect(agentLines()).toEqual({
      leading: "Reading the reconciler",
      under: "Claude 1",
    });
  });

  it("says both in the row's accessible name too", () => {
    mount("Reading the reconciler");
    expect(
      screen.getByRole("button", { name: /Claude 1.*Reading the reconciler/ }),
    ).toBeInTheDocument();
  });

  it("leads with its name when the Agent has said nothing", () => {
    mount(undefined);
    // No second line at all: the name has been promoted to the first, and
    // repeating it below would be the row saying one thing twice.
    expect(agentLines()).toEqual({ leading: "Claude 1", under: undefined });
  });
});

describe("where an Agent's unread mark is", () => {
  it("sits in the row's leading rail, and nowhere else", () => {
    mount("Reading the reconciler", "waiting");
    const row = document.querySelector(".agent-row");
    expect(row?.querySelector(".row-rail > .row-unread")).toBeInTheDocument();
    // One mark, at one end. Two of them at opposite ends of the row is the
    // arrangement this replaced.
    expect(row?.querySelectorAll(".row-unread")).toHaveLength(1);
  });

  it("is absent when the Agent is not owed an answer", () => {
    mount("Reading the reconciler");
    expect(document.querySelector(".row-unread")).toBeNull();
  });

  /**
   * The dot says why it is there, in the colour of the status that earned it.
   * A finish and a question are not the same errand, and one blue dot for both
   * is the dot saying they are. The class is the whole of the difference: the
   * colours themselves are the status tokens, in `shell.css`.
   */
  it("wears the colour of the reason it is there", () => {
    for (const reason of [
      "waiting",
      "idle",
      "error",
      "working",
      "unknown",
    ] as const) {
      mount("Reading the reconciler", reason);
      expect(document.querySelector(".row-unread")).toHaveClass(
        `row-unread-${reason}`,
      );
      cleanup();
    }
  });

  it("draws each reason in that status's own colour, and invents none", () => {
    // Vitest runs from the package root, and the stylesheet is one file, not
    // a module this test can import under jsdom.
    const css = readFileSync("src/shell/styles/shell.css", "utf8");
    for (const [reason, token] of [
      ["waiting", "--status-waiting"],
      ["idle", "--status-idle"],
      ["error", "--status-error"],
      ["working", "--status-working"],
      // Not a verdict, and it does not get a status colour: the same secondary
      // ink the `unknown` status mark takes.
      ["unknown", "--secondary"],
    ] as const) {
      expect(css).toContain(
        `.row-unread-${reason} {\n  background: var(${token});\n}`,
      );
    }
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
    expect(agentLines().under).toContain(
      closeDiagnosticLabel("close_agents_unknown"),
    );
    expect(agentLines().under).not.toBe("Stop failed");
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
