import { describe, expect, it } from "vitest";
import { chordKeyId, formatChordKey, parseChordKey } from "./chordKeys.js";
import {
  checkKeybindings,
  COMMANDS,
  commandById,
  defaultBindings,
  defaultKeybindings,
  isCommandId,
  isSelectEntryCommand,
  keysForCommand,
  resolveBindings,
  type CommandId,
} from "./commands.js";

describe("the registry itself", () => {
  it("gives every command an id nothing else has", () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("spells every default key in the grammar the config uses", () => {
    // The whole reason the defaults are strings: they go through the same
    // parser the file does, so DevHub cannot ship a key a person could not
    // have written.
    for (const command of COMMANDS) {
      expect(command.defaultKeys.length, command.id).toBeGreaterThan(0);
      for (const text of command.defaultKeys) {
        expect(
          () => parseChordKey(text),
          `${command.id}: ${text}`,
        ).not.toThrow();
      }
    }
  });

  it("writes every default key canonically", () => {
    // So that what the Settings window shows, what the help overlay shows and
    // what a person would have to type to override it are one string.
    for (const command of COMMANDS) {
      for (const text of command.defaultKeys) {
        expect(formatChordKey(parseChordKey(text)), command.id).toBe(text);
      }
    }
  });

  it("never gives one key to two commands", () => {
    const seen = new Map<string, CommandId>();
    for (const binding of defaultBindings()) {
      const id = chordKeyId(binding.key);
      expect(seen.get(id), `${id} is bound twice`).toBeUndefined();
      seen.set(id, binding.commandId);
    }
  });

  it("does give one command two keys where two habits reach it", () => {
    // The other direction is allowed, and the type is what says so.
    const bindings = defaultBindings();
    for (const command of COMMANDS) {
      expect(keysForCommand(bindings, command.id).length, command.id).toBe(
        command.defaultKeys.length,
      );
    }
  });

  it("knows its own ids and nobody else's", () => {
    expect(isCommandId("next_workspace")).toBe(true);
    expect(isCommandId("nope")).toBe(false);
    expect(commandById("nope")).toBeUndefined();
  });

  it("marks exactly the nine digit commands as digit commands", () => {
    const digits = COMMANDS.filter((command) =>
      isSelectEntryCommand(command.id),
    );
    expect(digits.map((command) => command.id)).toEqual([
      "select_entry_1",
      "select_entry_2",
      "select_entry_3",
      "select_entry_4",
      "select_entry_5",
      "select_entry_6",
      "select_entry_7",
      "select_entry_8",
      "select_entry_9",
    ]);
    expect(digits.map((command) => command.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });
});

describe("what the configuration is allowed to say", () => {
  it("accepts a table that only names keys and ids DevHub has", () => {
    expect(
      checkKeybindings({
        prefix: "Ctrl+q",
        chords: { "Shift+n": "previous_workspace", g: "" },
      }),
    ).toEqual([]);
  });

  it("reports an id DevHub does not have rather than ignoring it", () => {
    expect(
      checkKeybindings({ prefix: "Cmd+q", chords: { g: "teleport" } }),
    ).toEqual([{ code: "unknown_command", path: "keybindings.chords.g" }]);
  });

  it("reports a key that is not a key", () => {
    expect(
      checkKeybindings({ prefix: "Cmd+q", chords: { "Shift+{": "next_tab" } }),
    ).toEqual([{ code: "invalid_key", path: "keybindings.chords.Shift+{" }]);
    expect(checkKeybindings({ prefix: "Hyper+q", chords: {} })).toEqual([
      { code: "invalid_key", path: "keybindings.prefix" },
    ]);
  });

  it("reports two spellings of one stroke, because a key does one thing", () => {
    const problems = checkKeybindings({
      prefix: "Cmd+q",
      chords: { "Shift+n": "next_tab", "shift+N": "previous_tab" },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe("duplicate_key");
  });

  it("reports every problem, not the first", () => {
    const problems = checkKeybindings({
      prefix: "Cmd+q",
      chords: { g: "teleport", "Shift+{": "next_tab" },
    });
    expect(problems.map((problem) => problem.code)).toEqual([
      "unknown_command",
      "invalid_key",
    ]);
  });
});

describe("the table actually in effect", () => {
  const defaults = defaultBindings();

  function commandFor(
    spec: Parameters<typeof resolveBindings>[0],
    key: string,
  ): CommandId | undefined {
    const wanted = chordKeyId(parseChordKey(key));
    return resolveBindings(spec).bindings.find(
      (binding) => chordKeyId(binding.key) === wanted,
    )?.commandId;
  }

  it("is the shipped table when the file says nothing", () => {
    const resolved = resolveBindings(defaultKeybindings());
    expect(resolved.bindings).toHaveLength(defaults.length);
    expect(formatChordKey(resolved.prefix)).toBe("Cmd+q");
  });

  it("keeps every key the file does not mention", () => {
    // The reason the file holds overrides and not the whole table: a
    // configuration written today must not delete a command added tomorrow.
    const spec = { prefix: "Cmd+q", chords: { g: "next_tab" } };
    expect(commandFor(spec, "f")).toBe("add_workspace");
    expect(commandFor(spec, "Shift+n")).toBe("next_workspace");
  });

  it("lets a key be moved to another command", () => {
    expect(
      commandFor({ prefix: "Cmd+q", chords: { g: "next_tab" } }, "g"),
    ).toBe("next_tab");
  });

  it("lets a key be taken away with the empty string", () => {
    expect(
      commandFor({ prefix: "Cmd+q", chords: { f: "" } }, "f"),
    ).toBeUndefined();
    // And only that key: the command is still there under any other.
    expect(commandFor({ prefix: "Cmd+q", chords: { f: "" } }, "g")).toBe(
      "open_tab_picker",
    );
  });

  it("changes the prefix", () => {
    expect(
      formatChordKey(resolveBindings({ prefix: "Ctrl+q", chords: {} }).prefix),
    ).toBe("Ctrl+q");
  });

  it("skips an entry it cannot use rather than losing the whole table", () => {
    // The diagnostic has already been raised by `checkKeybindings`; a chord
    // layer that refused to exist over one bad line would take every other
    // chord away with it.
    const spec = {
      prefix: "nonsense++",
      chords: { "Shift+{": "next_tab", g: "teleport" },
    };
    const resolved = resolveBindings(spec);
    expect(formatChordKey(resolved.prefix)).toBe("Cmd+q");
    expect(commandFor(spec, "g")).toBe("open_tab_picker");
  });
});
