// @vitest-environment jsdom

/**
 * Earlier sessions of the repository's other worktrees, and the names their
 * Agents were given, in the two resume lists: New Agent's earlier sessions
 * and `/resume`.
 *
 * A session of another worktree says which branch and worktree it ran in, and
 * taking it goes on with it *there* — never in the Workspace the list was
 * asked for. A session whose Agent somebody named leads with that name, and
 * still says what the CLI called it.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PickerValue } from "./PickerContext";
import { PickerContext } from "./PickerContext";
import { AgentPickerSheet } from "./AgentPickerSheet";
import { SessionPicker } from "../components/shell/SessionPicker";
import type { PastSessionWire } from "../../ipc/contract";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const WORKSPACE = "550e8400-e29b-41d4-a716-446655440000";
const ROOT = "/projects/widget";
const PLACE = { kind: "local", path: ROOT };

const SESSIONS: readonly PastSessionWire[] = [
  {
    id: "s-here",
    title: "Write the README",
    cwd: ROOT,
    branch: "main",
    resumableHere: true,
    agentName: "Docs",
  },
  {
    id: "s-topic",
    title: "Refactor the parser",
    cwd: "/projects/widget_topic",
    resumableHere: false,
    worktree: {
      root: "/projects/widget_topic",
      branch: "topic",
      present: true,
    },
  },
  {
    id: "s-gone",
    title: "Old experiment",
    cwd: "/projects/widget_gone",
    resumableHere: false,
    worktree: { root: "/projects/widget_gone", branch: "old", present: false },
  },
];

function mountNewAgent() {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const resumeSessionElsewhere = vi.fn().mockResolvedValue(undefined);
  const onDismiss = vi.fn();
  const value = {
    dispatch,
    resumeSessionElsewhere,
    state: {
      status: "ready",
      snapshot: {
        workspaces: [
          {
            id: WORKSPACE,
            location: { kind: "local" },
            root: ROOT,
            agents: [],
          },
        ],
      },
    },
    listAgentSessions: vi.fn((_place: unknown, profileId: string) =>
      Promise.resolve(profileId === "claude" ? SESSIONS : []),
    ),
    previewAgentSession: vi.fn().mockResolvedValue([]),
    agentProfiles: {
      availability: "available",
      sequence: 1,
      profiles: [
        {
          id: "claude",
          displayName: "Claude",
          kind: "claude",
          presentation: "tui",
          presentations: ["tui", "gui"],
        },
      ],
    },
  } as unknown as PickerValue;
  render(
    <PickerContext.Provider value={value}>
      <AgentPickerSheet workspaceId={WORKSPACE} onDismiss={onDismiss} />
    </PickerContext.Provider>,
  );
  return { dispatch, resumeSessionElsewhere, onDismiss };
}

function optionNames(): string[] {
  return screen.getAllByRole("option").map((option) => {
    const title = option.querySelector(".mac-list-title")?.textContent ?? "";
    const detail = option.querySelector(".mac-list-subtitle")?.textContent;
    return detail === undefined ? title : `${title} | ${detail}`;
  });
}

describe("New Agent's earlier sessions", () => {
  it("lists the other worktrees' sessions with their branch and worktree, and a named Agent's by its name", async () => {
    mountNewAgent();
    await screen.findByRole("option", { name: /Refactor the parser/u });
    expect(optionNames()).toEqual([
      "New Claude Session",
      "Claude Session: Docs | Write the README · main",
      "Claude Session: Refactor the parser | topic (worktree widget_topic)",
      "Claude Session: Old experiment | old (worktree widget_gone, removed — made again)",
    ]);
  });

  it("finds a session by its Agent's name or its worktree's branch", async () => {
    mountNewAgent();
    await screen.findByRole("option", { name: /Refactor the parser/u });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "docs" },
    });
    expect(optionNames()[0]).toBe(
      "Claude Session: Docs | Write the README · main",
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "topic" },
    });
    expect(optionNames()[0]).toMatch(/Refactor the parser/u);
  });

  it("goes on with another worktree's session there, not in this Workspace", async () => {
    const { dispatch, resumeSessionElsewhere, onDismiss } = mountNewAgent();
    fireEvent.click(
      await screen.findByRole("option", { name: /Old experiment/u }),
    );
    expect(resumeSessionElsewhere).toHaveBeenCalledWith({
      place: PLACE,
      profileId: "claude",
      session: "s-gone",
      worktree: {
        root: "/projects/widget_gone",
        branch: "old",
        present: false,
      },
      cwd: "/projects/widget_gone",
      presentation: "tui",
      split: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("resumes this Workspace's own session in it, as before", async () => {
    const { dispatch, resumeSessionElsewhere } = mountNewAgent();
    fireEvent.click(await screen.findByRole("option", { name: /Docs/u }));
    expect(resumeSessionElsewhere).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "request_create_agent",
        resume: "s-here",
      }),
    );
  });
});

describe("/resume", () => {
  function mountResume() {
    const onChoose = vi.fn();
    const onChooseElsewhere = vi.fn();
    render(
      <SessionPicker
        title="Resume a Session"
        question="Which?"
        cli="Claude"
        source={{
          list: () => Promise.resolve(SESSIONS),
          preview: () => Promise.resolve([]),
        }}
        onChoose={onChoose}
        onChooseElsewhere={onChooseElsewhere}
        onCancel={vi.fn()}
      />,
    );
    return { onChoose, onChooseElsewhere };
  }

  it("offers another worktree's session, and hands it over to be gone on with there", async () => {
    const { onChoose, onChooseElsewhere } = mountResume();
    const topic = await screen.findByRole("option", {
      name: /Refactor the parser/u,
    });
    expect(topic).toHaveTextContent("topic (worktree widget_topic)");
    fireEvent.click(topic);
    expect(onChooseElsewhere).toHaveBeenCalledWith(SESSIONS[1]);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("titles a named Agent's session by its name, and resumes it in place", async () => {
    const { onChoose } = mountResume();
    fireEvent.click(await screen.findByRole("option", { name: /^Docs/u }));
    expect(onChoose).toHaveBeenCalledWith("s-here");
  });
});
