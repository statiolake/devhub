// @vitest-environment jsdom

/**
 * New Agent, and how the Agent it starts is shown.
 *
 * Return launches with the profile's own presentation; Command-Return launches
 * with the other one, for that one Agent. The sheet has to say which of the two
 * the key about to be pressed will do, so each row names it at its right end
 * and names the other while Option is held. A profile whose kind has no GUI
 * has nowhere for Option to turn it, and says so by not changing.
 *
 * Under the New rows, the earlier sessions that ran in the Workspace's folder:
 * filled in once the sheet is up, previewed, and launched the same way.
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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PickerValue } from "./PickerContext";
import { PickerContext } from "./PickerContext";
import { AgentPickerSheet } from "./AgentPickerSheet";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const WORKSPACE = "550e8400-e29b-41d4-a716-446655440000";

const ROOT = "/projects/widget";
const PLACE = { kind: "local", path: ROOT };

const PROFILES = [
  {
    id: "claude",
    displayName: "Claude",
    kind: "claude",
    presentation: "tui",
    presentations: ["tui", "gui"],
  },
  {
    id: "codex",
    displayName: "Codex",
    kind: "codex",
    presentation: "gui",
    presentations: ["tui", "gui"],
  },
  {
    id: "cursor",
    displayName: "Cursor",
    kind: "cursor",
    presentation: "tui",
    presentations: ["tui"],
  },
];

const HOUR = 60 * 60 * 1000;

function mount(
  listAgentSessions: PickerValue["listAgentSessions"] = vi
    .fn()
    .mockResolvedValue([]),
  previewAgentSession: PickerValue["previewAgentSession"] = vi
    .fn()
    .mockResolvedValue([]),
) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const value = {
    dispatch,
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
    listAgentSessions,
    previewAgentSession,
    agentProfiles: {
      availability: "available",
      sequence: 1,
      profiles: PROFILES,
    },
  } as unknown as PickerValue;
  render(
    <PickerContext.Provider value={value}>
      <AgentPickerSheet workspaceId={WORKSPACE} onDismiss={vi.fn()} />
    </PickerContext.Provider>,
  );
  return { dispatch, listAgentSessions, previewAgentSession };
}

/** A listing that answers only when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Each row as its name and, after a bar, its second line. */
function optionNames(): string[] {
  return screen.getAllByRole("option").map((option) => {
    const title = option.querySelector(".mac-list-title")?.textContent ?? "";
    const detail = option.querySelector(".mac-list-subtitle")?.textContent;
    return detail === undefined ? title : `${title} | ${detail}`;
  });
}

function row(name: RegExp) {
  return screen.getByRole("option", { name });
}

function narrowTo(query: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: query } });
}

describe("launching from New Agent", () => {
  it("launches with the profile's own presentation on Return", () => {
    const { dispatch } = mount();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(dispatch).toHaveBeenCalledWith({
      type: "request_create_agent",
      workspaceId: WORKSPACE,
      profileId: "claude",
      split: false,
      presentation: "tui",
    });
  });

  it("launches with the other presentation on Command-Return", () => {
    const { dispatch } = mount();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      metaKey: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "claude", presentation: "gui" }),
    );
  });

  it("turns a GUI default into a terminal the same way", () => {
    const { dispatch } = mount();
    narrowTo("codex");
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      metaKey: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "codex", presentation: "tui" }),
    );
  });

  it("opens beside the editor on Option-Return and keeps the presentation", () => {
    const { dispatch } = mount();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      altKey: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ split: true, presentation: "tui" }),
    );
  });

  it("opens beside the editor on Option-click, and with Command-Option-click turns the presentation too", () => {
    const { dispatch } = mount();
    fireEvent.click(row(/^New Codex Session/u), { altKey: true });
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ split: true, presentation: "gui" }),
    );
  });

  it("keeps Command and Option independent when both are held", () => {
    const { dispatch } = mount();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      altKey: true,
      metaKey: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ split: true, presentation: "gui" }),
    );
  });

  it("launches a profile with no GUI as a terminal whatever is held", () => {
    const { dispatch } = mount();
    narrowTo("cursor");
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      metaKey: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "cursor", presentation: "tui" }),
    );
  });

  it("takes Option from a click too", () => {
    const { dispatch } = mount();
    fireEvent.click(row(/^New Codex Session/u), { metaKey: true });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "codex", presentation: "tui" }),
    );
  });
});

describe("what the sheet says will happen", () => {
  it("names each profile's own presentation", () => {
    mount();
    expect(row(/^New Claude Session/u)).toHaveTextContent("TUI");
    expect(row(/^New Codex Session/u)).toHaveTextContent("GUI");
    expect(row(/^New Cursor Session/u)).toHaveTextContent("TUI");
  });

  it("names the other one while Option is held, and only then", () => {
    mount();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Meta", metaKey: true });
    expect(row(/^New Claude Session/u)).toHaveTextContent("GUI");
    expect(row(/^New Codex Session/u)).toHaveTextContent("TUI");
    // Nowhere to turn it, so nothing to say differently.
    expect(row(/^New Cursor Session/u)).toHaveTextContent("TUI");

    fireEvent.keyUp(dialog, { key: "Meta", metaKey: false });
    expect(row(/^New Claude Session/u)).toHaveTextContent("TUI");
    expect(row(/^New Codex Session/u)).toHaveTextContent("GUI");
  });

  it("stops naming the other one when the window loses the keyboard", () => {
    mount();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Meta",
      metaKey: true,
    });
    expect(row(/^New Claude Session/u)).toHaveTextContent("GUI");
    // Option let go in another app is a keyup this sheet never hears.
    fireEvent.blur(window);
    expect(row(/^New Claude Session/u)).toHaveTextContent("TUI");
  });

  it("says what Option does", () => {
    mount();
    expect(screen.getByRole("status")).toHaveTextContent(
      "⌘Return opens it as the other of TUI and GUI.",
    );
  });
});

describe("earlier sessions in the Workspace's folder", () => {
  it("draws the New rows at once and fills the sessions in when they are read", async () => {
    const claude = deferred<readonly unknown[]>();
    const codex = deferred<readonly unknown[]>();
    const list = vi.fn((_place: unknown, profileId: string) =>
      profileId === "claude" ? claude.promise : codex.promise,
    );
    mount(list as unknown as PickerValue["listAgentSessions"]);
    // Asked of the Workspace's own folder, on its machine, for each profile
    // whose CLI keeps sessions — and not for Cursor's.
    expect(list.mock.calls).toEqual([
      [PLACE, "claude"],
      [PLACE, "codex"],
    ]);
    expect(row(/^New Claude Session/u)).toBeInTheDocument();
    expect(row(/^Earlier sessions/u)).toHaveTextContent("Reading…");

    const now = Date.now();
    await act(async () => {
      claude.resolve([
        {
          id: "c-old",
          title: "Write the README",
          updatedAt: now - 3 * 24 * HOUR,
          cwd: ROOT,
          resumableHere: true,
        },
      ]);
      await claude.promise;
    });
    // One listing still out: its quiet row stays.
    expect(row(/^Earlier sessions/u)).toBeInTheDocument();
    await act(async () => {
      codex.resolve([
        {
          id: "x-new",
          title: "Fix the login flow",
          updatedAt: now - 2 * HOUR,
          cwd: ROOT,
          branch: "feature/128-wip",
          resumableHere: true,
        },
      ]);
      await codex.promise;
    });
    expect(
      screen.queryByRole("option", { name: /^Earlier sessions/u }),
    ).toBeNull();
    // New rows first, then the sessions newest first across profiles.
    expect(optionNames()).toEqual([
      "New Claude Session",
      "New Codex Session",
      "New Cursor Session | Cursor — busy and waiting only",
      "Codex Session: Fix the login flow | 2 hours ago · feature/128-wip",
      "Claude Session: Write the README | 3 days ago",
    ]);
  });

  it("narrows to the sessions whose title matches what is typed", async () => {
    mount(
      vi.fn((_place: unknown, profileId: string) =>
        Promise.resolve(
          profileId === "claude"
            ? [
                {
                  id: "a",
                  title: "Fix the login flow",
                  cwd: ROOT,
                  resumableHere: true,
                },
                {
                  id: "b",
                  title: "Write the README",
                  cwd: ROOT,
                  resumableHere: true,
                },
              ]
            : [],
        ),
      ) as unknown as PickerValue["listAgentSessions"],
    );
    await screen.findByRole("option", { name: /README/u });
    narrowTo("readme");
    expect(optionNames()).toEqual([
      expect.stringMatching(/^Claude Session: Write the README/u),
    ]);
  });

  it("resumes the session taken, with Option turning its presentation like a New row's", async () => {
    const { dispatch } = mount(
      vi.fn((_place: unknown, profileId: string) =>
        Promise.resolve(
          profileId === "codex"
            ? [
                {
                  id: "thread-1",
                  title: "Fix the login flow",
                  cwd: ROOT,
                  resumableHere: true,
                },
              ]
            : [],
        ),
      ) as unknown as PickerValue["listAgentSessions"],
    );
    const session = await screen.findByRole("option", {
      name: /^Codex Session: Fix the login flow/u,
    });
    // Codex's own default is GUI; Option makes this one a terminal.
    expect(session).toHaveTextContent("GUI");
    fireEvent.click(session, { metaKey: true });
    expect(dispatch).toHaveBeenCalledWith({
      type: "request_create_agent",
      workspaceId: WORKSPACE,
      profileId: "codex",
      split: false,
      presentation: "tui",
      resume: "thread-1",
    });
  });

  it("previews how the session the person is on ended", async () => {
    const preview = vi.fn().mockResolvedValue([
      { role: "person", text: "Please fix the login flow" },
      { role: "agent", text: "Fixed; the tests pass." },
    ]);
    mount(
      vi.fn((_place: unknown, profileId: string) =>
        Promise.resolve(
          profileId === "claude"
            ? [
                {
                  id: "s-1",
                  title: "Fix the login flow",
                  cwd: ROOT,
                  resumableHere: true,
                },
              ]
            : [],
        ),
      ) as unknown as PickerValue["listAgentSessions"],
      preview as unknown as PickerValue["previewAgentSession"],
    );
    await screen.findByRole("option", { name: /Fix the login flow/u });
    narrowTo("login");
    const ended = await screen.findByRole("list", {
      name: "How the session ended",
    });
    expect(preview).toHaveBeenCalledWith(PLACE, "claude", "s-1", ROOT);
    expect(
      within(ended).getByText("Fixed; the tests pass."),
    ).toBeInTheDocument();
  });

  it("says why when a profile's sessions cannot be read, and keeps the rest", async () => {
    mount(
      vi.fn((_place: unknown, profileId: string) =>
        profileId === "codex"
          ? Promise.reject(new Error("codex app-server ended: boom"))
          : Promise.resolve([
              {
                id: "s-1",
                title: "Write the README",
                cwd: ROOT,
                resumableHere: true,
              },
            ]),
      ) as unknown as PickerValue["listAgentSessions"],
    );
    expect(
      await screen.findByText(/codex app-server ended: boom/u),
    ).toBeInTheDocument();
    expect(row(/^New Codex Session/u)).toBeInTheDocument();
    expect(row(/^Claude Session: Write the README/u)).toBeInTheDocument();
  });
});
