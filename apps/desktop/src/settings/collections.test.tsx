// @vitest-environment jsdom

/**
 * The two collections, as list and inspector.
 *
 * What is asserted is the shape rather than the pixels: one entry is selected
 * at a time, the inspector is that entry's, the arrows move the selection, `+`
 * appends and selects what it appended, `−` removes the selected one and
 * nothing else, and a collection with nothing in it says so instead of showing
 * an empty form.
 *
 * Also here: the combination the config refuses cannot be reached. The old
 * three-checkbox "Match" control could be ticked into `["directory",
 * "git_repository"]`, which saves and comes back refused; the popup that
 * replaced it has no such position.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsConfig } from "../ipc/settings";
import { MATCH_CHOICES } from "./rules";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig } from "./testHarness";

afterEach(cleanup);

const SOURCES: SettingsConfig["workspaceSources"] = [
  {
    type: "filesystem",
    id: "personal",
    path: "~/dev",
    minDepth: 1,
    maxDepth: 2,
    kinds: ["git_repository"],
    includeHidden: false,
    excludeNames: [],
  },
  {
    type: "command",
    id: "ghq",
    command: ["ghq", "list", "-p"],
    timeoutMs: 2000,
  },
];

/** The same list with a date source after it, for the tests about that form. */
const WITH_DATED: SettingsConfig["workspaceSources"] = [
  ...SOURCES,
  {
    type: "date",
    id: "daily",
    path: "~/workspace/daily/YYYY/MMDD",
    createIfMissing: true,
  },
];

async function open(section: string, config: SettingsConfig) {
  const { saves, client } = testClient(config);
  render(<SettingsApp client={client} />);
  fireEvent.click(await screen.findByRole("tab", { name: section }));
  return { saves };
}

// Scoped to the source list: a popup button's `<option>` elements carry the
// same role, and the window has several of those.
const list = () => screen.getByRole("listbox");
const options = () => within(list()).queryAllByRole("option");
const selected = () =>
  options().find((option) => option.getAttribute("aria-selected") === "true");

describe("a collection of workspace sources", () => {
  it("selects the first entry and shows that entry's form", async () => {
    await open("Workspaces", testConfig({ workspaceSources: SOURCES }));

    expect(options()).toHaveLength(2);
    expect(selected()).toHaveTextContent("personal");
    expect(screen.getByLabelText("Workspace source identifier")).toHaveValue(
      "personal",
    );
    // The other entry's fields are not on screen at all — that is the whole
    // difference from the stacked forms this replaced.
    expect(screen.queryByLabelText("Command timeout")).not.toBeInTheDocument();
  });

  it("moves the selection with the arrow keys", async () => {
    await open("Workspaces", testConfig({ workspaceSources: SOURCES }));

    fireEvent.keyDown(list(), { key: "ArrowDown" });

    expect(selected()).toHaveTextContent("ghq");
    // A command source is a different form, not the same form with fields
    // greyed out.
    expect(screen.getByLabelText("Command timeout")).toHaveValue("2000");
    expect(
      screen.queryByLabelText("Workspace root path"),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(list(), { key: "ArrowUp" });
    expect(selected()).toHaveTextContent("personal");
  });

  it("shows a date source as its own form, and saves what is typed there", async () => {
    // A third kind of source, not a folder source with the depth fields
    // hidden: what it needs is a template and one switch.
    const { saves } = await open(
      "Workspaces",
      testConfig({ workspaceSources: WITH_DATED }),
    );
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(selected()).toHaveTextContent("daily");
    expect(screen.queryByLabelText("Command timeout")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Workspace root path"),
    ).not.toBeInTheDocument();

    const field = screen.getByLabelText("Dated workspace path");
    expect(field).toHaveValue("~/workspace/daily/YYYY/MMDD");
    fireEvent.change(field, { target: { value: "~/notes/YYYY-MM-DD" } });
    fireEvent.blur(field);

    await vi.waitFor(() => {
      const saved = saves.at(-1)?.workspaceSources.at(2);
      expect(saved?.type === "date" ? saved.path : undefined).toBe(
        "~/notes/YYYY-MM-DD",
      );
    });
  });

  it("refuses a template whose brackets do not close", async () => {
    await open("Workspaces", testConfig({ workspaceSources: WITH_DATED }));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "ArrowDown" });

    const field = screen.getByLabelText("Dated workspace path");
    fireEvent.change(field, { target: { value: "~/notes/[YYYY" } });
    fireEvent.blur(field);
    expect(field).toBeInvalid();
  });

  it("appends a source, selects it, and gives it an identifier nobody has", async () => {
    const { saves } = await open(
      "Workspaces",
      testConfig({ workspaceSources: SOURCES }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Source" }));

    expect(options()).toHaveLength(3);
    expect(selected()).toHaveTextContent("source-1");
    await vi.waitFor(() => {
      expect(saves.at(-1)?.workspaceSources.map((item) => item.id)).toEqual([
        "personal",
        "ghq",
        "source-1",
      ]);
    });
  });

  it("removes the selected source and nothing else", async () => {
    const { saves } = await open(
      "Workspaces",
      testConfig({ workspaceSources: SOURCES }),
    );

    fireEvent.keyDown(list(), { key: "End" });
    fireEvent.click(screen.getByRole("button", { name: "Remove Source" }));

    expect(options()).toHaveLength(1);
    await vi.waitFor(() => {
      expect(saves.at(-1)?.workspaceSources.map((item) => item.id)).toEqual([
        "personal",
      ]);
    });
  });

  it("says the collection is empty instead of showing an empty form", async () => {
    await open("Workspaces", testConfig({ workspaceSources: [] }));

    expect(options()).toHaveLength(0);
    expect(screen.getByText("No workspace sources")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Workspace source identifier"),
    ).not.toBeInTheDocument();
    // The empty state carries the one action that resolves it.
    expect(
      screen.getAllByRole("button", { name: "Add Source" }).length,
    ).toBeGreaterThan(0);
  });

  it("adds a name to the ignore list only once it has been typed", async () => {
    const { saves } = await open(
      "Workspaces",
      testConfig({ workspaceSources: SOURCES }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Name" }));
    const blank = screen.getByLabelText("New skipped name");

    // The bug this pins: Add used to append "" to the list, so the debounced
    // save asked DevHub to accept an empty exclusion — refused, with a notice
    // about a value nobody had typed, before the person reached the keyboard.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(saves).toEqual([]);

    fireEvent.change(blank, { target: { value: "dist" } });
    fireEvent.keyDown(blank, { key: "Enter" });

    await vi.waitFor(() => {
      const source = saves.at(-1)?.workspaceSources[0];
      expect(source?.type === "filesystem" ? source.excludeNames : []).toEqual([
        "dist",
      ]);
    });
  });

  it("takes the blank row away again when it is left empty", async () => {
    const { saves } = await open(
      "Workspaces",
      testConfig({ workspaceSources: SOURCES }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Name" }));
    fireEvent.blur(screen.getByLabelText("New skipped name"));

    expect(screen.queryByLabelText("New skipped name")).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(saves).toEqual([]);
  });

  it("cannot be asked for a combination of kinds the config refuses", async () => {
    await open("Workspaces", testConfig({ workspaceSources: SOURCES }));

    const popup = screen.getByLabelText("What to match");
    expect(
      within(popup)
        .getAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(MATCH_CHOICES.map(([choice]) => choice));
  });
});

describe("a collection of agent profiles", () => {
  const PROFILES: SettingsConfig["agentProfiles"] = [
    {
      id: "codex",
      displayName: "Codex",
      kind: "codex",
      command: "codex",
      args: [],
      env: {},
    },
    {
      id: "claude",
      displayName: "Claude",
      kind: "claude",
      command: "claude",
      args: ["--verbose"],
      env: { TOKEN: "x" },
    },
  ];

  it("is the same shape as the other one", async () => {
    await open("Agents", testConfig({ agentProfiles: PROFILES }));

    expect(options()).toHaveLength(2);
    expect(selected()).toHaveTextContent("Codex");

    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(screen.getByLabelText("Agent display name")).toHaveValue("Claude");
    expect(screen.getByLabelText("Argument 1")).toHaveValue("--verbose");
  });

  it("keeps a renamed variable where it was", async () => {
    const { saves } = await open(
      "Agents",
      testConfig({
        agentProfiles: [
          {
            id: "codex",
            displayName: "Codex",
            kind: "codex",
            command: "codex",
            args: [],
            env: { FIRST: "1", SECOND: "2" },
          },
        ],
      }),
    );

    const name = screen.getByLabelText("Environment variable 1 name");
    fireEvent.change(name, { target: { value: "RENAMED" } });
    fireEvent.keyDown(name, { key: "Enter" });

    await vi.waitFor(() => {
      expect(Object.keys(saves.at(-1)?.agentProfiles[0].env ?? {})).toEqual([
        "RENAMED",
        "SECOND",
      ]);
    });
  });

  it("says the collection is empty", async () => {
    await open("Agents", testConfig({ agentProfiles: [] }));
    expect(screen.getByText("No agent profiles")).toBeInTheDocument();
  });
});

describe("the actions an agent is sent", () => {
  it("lists the person's own actions, and lets them add and remove one", async () => {
    // The membership *is* theirs now: every action has the same trigger — the
    // Issue flow asks which one to start with — so an action somebody adds has
    // somewhere to be chosen from, which is what a fixed set could not offer.
    const { saves } = await open("Actions", testConfig({}));

    expect(selected()).toHaveTextContent("Work on the Issue");
    fireEvent.click(screen.getByRole("button", { name: "Add Action" }));

    await vi.waitFor(() => {
      expect(saves.at(-1)?.agentActions).toHaveLength(2);
    });
    expect(saves.at(-1)?.agentActions[1]?.id).toBe("action-1");

    fireEvent.click(screen.getByRole("button", { name: "Remove Action" }));
    await vi.waitFor(() => {
      expect(saves.at(-1)?.agentActions).toHaveLength(1);
    });
  });

  it("saves the name and the wording", async () => {
    const { saves } = await open("Actions", testConfig({}));

    const name = screen.getByLabelText("Agent action name");
    fireEvent.change(name, { target: { value: "Review it" } });
    fireEvent.blur(name);
    await vi.waitFor(() => {
      expect(saves.at(-1)?.agentActions[0]?.displayName).toBe("Review it");
    });

    const message = screen.getByLabelText("Agent action message");
    fireEvent.change(message, { target: { value: "review {{ISSUE_URL}}" } });
    fireEvent.blur(message);
    await vi.waitFor(() => {
      expect(saves.at(-1)?.agentActions[0]?.template).toBe(
        "review {{ISSUE_URL}}",
      );
    });
  });

  it("refuses two actions with one identifier", async () => {
    await open(
      "Actions",
      testConfig({
        agentActions: [
          { id: "implement", displayName: "Work on it", template: "a" },
          { id: "review", displayName: "Review it", template: "b" },
        ],
      }),
    );
    const id = screen.getByLabelText("Agent action identifier");
    fireEvent.change(id, { target: { value: "review" } });
    fireEvent.blur(id);
    expect(id).toBeInvalid();
  });

  it("says which variables the message may use, and what $name does", async () => {
    await open("Actions", testConfig({}));
    const note = screen.getByText(/are replaced when it is sent/u);
    expect(note).toHaveTextContent("{{ISSUE_URL}}");
    expect(note).toHaveTextContent("{{ISSUE_NO}}");
    expect(note).toHaveTextContent(/Claude Code is sent \/name/u);
  });
});
