import { describe, expect, it } from "vitest";
import {
  commandPaletteRows,
  filterCommandPaletteRows,
  rememberRecentCommand,
} from "./commandPalette.js";
import {
  COMMANDS,
  defaultKeybindings,
  resolveBindings,
  type CommandId,
} from "./commands.js";

const { prefix, bindings } = resolveBindings(defaultKeybindings());

function rows(
  recent: readonly CommandId[] = [],
  available: (id: CommandId) => boolean = () => true,
) {
  return commandPaletteRows({ prefix, bindings, recent, available });
}

describe("the command registry", () => {
  it("gives every command a category and a label", () => {
    for (const command of COMMANDS) {
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.category.length).toBeGreaterThan(0);
    }
  });

  it("binds the palette to the colon character", () => {
    expect(
      bindings.find((binding) => binding.commandId === "open_command_palette")
        ?.key.key,
    ).toBe(":");
  });
});

describe("the command palette's rows", () => {
  it("lists every command but the forwarded prefix and itself", () => {
    const ids = rows().map((row) => row.commandId);
    expect(ids).not.toContain("forward_prefix");
    expect(ids).not.toContain("open_command_palette");
    expect(ids).toContain("navigate_back");
    expect(ids.length).toBe(COMMANDS.length - 2);
  });

  it("titles a row by category and shows its chords", () => {
    const row = rows().find((one) => one.commandId === "add_workspace");
    expect(row?.title).toBe("Workspace: Add Workspace…");
    expect(row?.chords).toEqual(["Cmd+q f"]);
    const back = rows().find((one) => one.commandId === "navigate_back");
    expect(back?.chords).toEqual([]);
  });

  it("hides what would do nothing now", () => {
    const ids = rows([], (id) => id !== "rename_agent").map(
      (row) => row.commandId,
    );
    expect(ids).not.toContain("rename_agent");
  });

  it("puts recently used commands first, most recent first", () => {
    const list = rows(["open_settings", "toggle_sidebar"]);
    expect(list.slice(0, 2).map((row) => row.commandId)).toEqual([
      "open_settings",
      "toggle_sidebar",
    ]);
    expect(list[0]?.recent).toBe(true);
    expect(list[2]?.recent).toBe(false);
  });

  it("remembers a run command at the front, once, within the limit", () => {
    let recent: readonly CommandId[] = [];
    recent = rememberRecentCommand(recent, "open_settings");
    recent = rememberRecentCommand(recent, "toggle_sidebar");
    recent = rememberRecentCommand(recent, "open_settings");
    expect(recent).toEqual(["open_settings", "toggle_sidebar"]);
    expect(
      rememberRecentCommand(
        ["a_1", "a_2"] as unknown as CommandId[],
        "open_settings",
        2,
      ),
    ).toEqual(["open_settings", "a_1"]);
  });
});

describe("filtering the palette", () => {
  it("matches a subsequence of the title, case-insensitively", () => {
    const found = filterCommandPaletteRows(rows(), "tglsdbr").map(
      (row) => row.commandId,
    );
    expect(found).toContain("toggle_sidebar");
    expect(found).not.toContain("open_settings");
  });

  it("matches the command id too", () => {
    const found = filterCommandPaletteRows(rows(), "refresh_repositories");
    expect(found[0]?.commandId).toBe("refresh_repositories");
  });

  it("keeps everything, in order, for an empty query", () => {
    const all = rows();
    expect(filterCommandPaletteRows(all, "")).toEqual(all);
  });

  it("leaves nothing for a query nothing matches", () => {
    expect(filterCommandPaletteRows(rows(), "zzzzqqq")).toEqual([]);
  });
});
