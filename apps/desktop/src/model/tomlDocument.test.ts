import { describe, expect, it } from "vitest";
import {
  parseTomlValue,
  type TomlValue,
  renderTomlDocument,
  renderValue,
  TomlSyntaxError,
  updateTomlDocument,
} from "./tomlDocument.js";

describe("reading", () => {
  it("reads scalars, arrays, tables and arrays of tables", () => {
    const source = [
      "version = 1",
      "",
      "[general]",
      "import_login_environment = true",
      "",
      "[appearance]",
      "terminal_line_height = 1.2",
      'ansi = [ "#aa0000", "#00bb00" ]',
      "",
      "[[agent_profiles]]",
      'id = "codex"',
      "[agent_profiles.env]",
      'TOKEN = "x"',
      "",
    ].join("\n");
    expect(parseTomlValue(source)).toEqual({
      version: 1,
      general: { import_login_environment: true },
      appearance: {
        terminal_line_height: 1.2,
        ansi: ["#aa0000", "#00bb00"],
      },
      agent_profiles: [{ id: "codex", env: { TOKEN: "x" } }],
    });
  });

  it("reports a syntax error rather than a partial document", () => {
    expect(() => parseTomlValue("version = \n")).toThrow(TomlSyntaxError);
  });
});

describe("rendering values", () => {
  it("escapes what has no literal spelling", () => {
    expect(renderValue('a "quoted"\npath\\here')).toBe(
      '"a \\"quoted\\"\\npath\\\\here"',
    );
    expect(renderValue([])).toBe("[]");
    expect(renderValue(["a", "b"])).toBe('[ "a", "b" ]');
    expect(renderValue({})).toBe("{}");
    expect(renderValue(true)).toBe("true");
  });
});

describe("editing in place", () => {
  const source = [
    "# DevHub configuration.",
    "version = 1",
    "",
    "[appearance]",
    "# I like it small.",
    "terminal_font_size = 13   # not 14",
    'terminal_font_family = "SF Mono"',
    "",
    "[[agent_profiles]]",
    'id = "codex"',
    'display_name = "Codex"',
    "",
    "[[agent_profiles]]",
    'id = "claude"',
    'display_name = "Claude"',
    "",
  ].join("\n");

  /** The parsed document, in the shape the editor takes back. */
  function documentOf(text: string): Record<string, TomlValue> {
    return parseTomlValue(text) as Record<string, TomlValue>;
  }

  const document = documentOf(source);
  const appearance = document["appearance"] as Record<string, TomlValue>;
  const profiles = document["agent_profiles"] as Record<string, TomlValue>[];

  it("returns the file untouched when nothing changed", () => {
    expect(updateTomlDocument(source, document)).toBe(source);
  });

  it("replaces one value and keeps its comment, spacing and neighbours", () => {
    const next = updateTomlDocument(source, {
      ...document,
      appearance: { ...appearance, terminal_font_size: 15 },
    });
    expect(next).toContain("terminal_font_size = 15   # not 14");
    expect(next).toContain("# I like it small.");
    expect(next).toContain("# DevHub configuration.");
    expect(next).toContain('terminal_font_family = "SF Mono"');
  });

  it("appends a new key under the table it belongs to", () => {
    const next = updateTomlDocument(source, {
      ...document,
      appearance: { ...appearance, sidebar_density: "comfortable" },
    });
    const lines = next.split("\n");
    const table = lines.indexOf("[appearance]");
    const added = lines.indexOf('sidebar_density = "comfortable"');
    expect(added).toBeGreaterThan(table);
    // Still inside `[appearance]`, before the next heading.
    expect(added).toBeLessThan(lines.indexOf("[[agent_profiles]]"));
  });

  it("removes a key with its own line and trailing comment", () => {
    const trimmed = { ...appearance };
    delete trimmed["terminal_font_size"];
    const next = updateTomlDocument(source, {
      ...document,
      appearance: trimmed,
    });
    expect(next).not.toContain("terminal_font_size");
    expect(next).not.toContain("# not 14");
    // The comment on its own line above is about the section, and stays.
    expect(next).toContain("# I like it small.");
  });

  it("adds a whole table for a section the file does not have", () => {
    const next = updateTomlDocument(source, {
      ...document,
      general: { import_login_environment: false },
    });
    expect(next).toContain("[general]");
    expect(next).toContain("import_login_environment = false");
    expect(parseTomlValue(next)["general"]).toEqual({
      import_login_environment: false,
    });
  });

  it("matches array-of-tables entries by id, not by position", () => {
    // Reversed order, and only the second entry's value changed.
    const next = updateTomlDocument(source, {
      ...document,
      agent_profiles: [
        { ...profiles[1] },
        { ...profiles[0], display_name: "Codex CLI" },
      ],
    });
    expect(next).toContain('display_name = "Codex CLI"');
    expect(next).toContain('display_name = "Claude"');
    // Two blocks, still two blocks.
    expect(next.match(/\[\[agent_profiles\]\]/g)).toHaveLength(2);
  });

  it("removes an array-of-tables entry with its own block only", () => {
    const next = updateTomlDocument(source, {
      ...document,
      agent_profiles: [profiles[0]],
    });
    expect(next.match(/\[\[agent_profiles\]\]/g)).toHaveLength(1);
    expect(next).toContain('id = "codex"');
    expect(next).not.toContain('id = "claude"');
    expect(next).toContain("# I like it small.");
  });

  it("removes the last entry of a one-entry array and writes the empty array", () => {
    const one = [
      "version = 1",
      "",
      "# The only profile.",
      "[[agent_profiles]]",
      'id = "codex"',
      'display_name = "Codex"',
      "[agent_profiles.env]",
      'TOKEN = "x"',
      "",
    ].join("\n");
    const next = updateTomlDocument(one, {
      ...documentOf(one),
      agent_profiles: [],
    });
    expect(next).not.toContain("[[agent_profiles]]");
    expect(next).not.toContain("[agent_profiles.env]");
    expect(next).toContain("agent_profiles = []");
    expect(parseTomlValue(next)).toEqual({ version: 1, agent_profiles: [] });
  });

  it("removes the last of two entries, then re-adds one, re-parsing each time", () => {
    const emptied = updateTomlDocument(source, {
      ...document,
      agent_profiles: [],
    });
    expect(emptied).not.toContain("[[agent_profiles]]");
    expect(emptied).toContain("agent_profiles = []");
    // The rest of the file is untouched.
    expect(emptied).toContain("# I like it small.");
    expect(emptied).toContain("terminal_font_size = 13   # not 14");
    expect(parseTomlValue(emptied)).toEqual({
      ...document,
      agent_profiles: [],
    });

    const refilled = updateTomlDocument(emptied, {
      ...documentOf(emptied),
      agent_profiles: [profiles[1]],
    });
    // The empty marker gave way to the block spelling rather than joining it.
    expect(refilled).not.toContain("agent_profiles = []");
    expect(refilled.match(/\[\[agent_profiles\]\]/g)).toHaveLength(1);
    expect(parseTomlValue(refilled)).toEqual({
      ...document,
      agent_profiles: [profiles[1]],
    });
  });

  it("keeps an inline array of tables inline", () => {
    const inline =
      'version = 1\nagent_profiles = [ { id = "codex" } ]\nworkspace_sources = []\n';
    const next = updateTomlDocument(inline, {
      ...documentOf(inline),
      agent_profiles: [{ id: "codex", display_name: "Codex" }],
    });
    expect(next).toBe(
      'version = 1\nagent_profiles = [ { id = "codex", display_name = "Codex" } ]\nworkspace_sources = []\n',
    );
  });

  it("appends an array-of-tables entry the file does not have", () => {
    const next = updateTomlDocument(source, {
      ...document,
      agent_profiles: [
        ...profiles,
        { id: "extra", display_name: "Extra", kind: "codex" },
      ],
    });
    const parsed = parseTomlValue(next)["agent_profiles"] as unknown[];
    expect(parsed).toHaveLength(3);
    expect(next).toContain('id = "extra"');
  });

  it("keeps an inline table inline", () => {
    const inline = "version = 1\nappearance = { terminal_font_size = 13 }\n";
    const value = documentOf(inline);
    const next = updateTomlDocument(inline, {
      ...value,
      appearance: { terminal_font_size: 15 },
    });
    expect(next).toBe(
      "version = 1\nappearance = { terminal_font_size = 15 }\n",
    );
  });

  it("leaves an empty sub-table's heading to spell it, not a second definition", () => {
    const withEmptyEnv = [
      "version = 1",
      "",
      "[[agent_profiles]]",
      'id = "codex"',
      'kind = "codex"',
      "",
      "[agent_profiles.env]",
      "",
      "[[agent_profiles]]",
      'id = "claude"',
      'kind = "claude"',
      "",
      "[agent_profiles.env]",
      "",
    ].join("\n");
    const value = documentOf(withEmptyEnv);
    const next = updateTomlDocument(withEmptyEnv, {
      ...value,
      agent_profiles: [
        { id: "codex", kind: "codex", env: {} },
        { id: "claude", kind: "custom", command: "my-agent", env: {} },
      ],
    });
    expect(next).not.toContain("env = {}");
    expect(next.match(/\[agent_profiles\.env\]/g)).toHaveLength(2);
    expect(parseTomlValue(next)).toEqual({
      version: 1,
      agent_profiles: [
        { id: "codex", kind: "codex", env: {} },
        { id: "claude", kind: "custom", command: "my-agent", env: {} },
      ],
    });
  });

  it("empties a sub-table's contents and keeps its heading", () => {
    const withEnv = [
      "version = 1",
      "",
      "[[agent_profiles]]",
      'id = "codex"',
      "",
      "[agent_profiles.env]",
      'TOKEN = "x"',
      "",
    ].join("\n");
    const next = updateTomlDocument(withEnv, {
      ...documentOf(withEnv),
      agent_profiles: [{ id: "codex", env: {} }],
    });
    expect(next).toContain("[agent_profiles.env]");
    expect(next).not.toContain("env = {}");
    expect(parseTomlValue(next)).toEqual({
      version: 1,
      agent_profiles: [{ id: "codex", env: {} }],
    });
  });

  it("leaves an empty top-level table's heading alone", () => {
    const withEmptyGeneral = "version = 1\n\n[general]\n";
    const next = updateTomlDocument(withEmptyGeneral, {
      version: 1,
      general: {},
    });
    expect(next).toBe(withEmptyGeneral);
  });

  it("writes an empty table the document does not have as one line", () => {
    const next = updateTomlDocument("version = 1\n", {
      version: 1,
      general: {},
    });
    expect(next).toContain("general = {}");
    expect(parseTomlValue(next)).toEqual({ version: 1, general: {} });
  });

  it("empties an inline table without re-spelling it as a block", () => {
    const inlineEnv = 'version = 1\nagent_profiles = [ { id = "codex" } ]\n';
    const next = updateTomlDocument(inlineEnv, {
      ...documentOf(inlineEnv),
      agent_profiles: [{ id: "codex", env: {} }],
    });
    expect(parseTomlValue(next)).toEqual({
      version: 1,
      agent_profiles: [{ id: "codex", env: {} }],
    });
  });

  it("round-trips whatever it produced", () => {
    const next = updateTomlDocument(source, {
      ...document,
      appearance: {
        ...appearance,
        terminal_font_size: 15,
        sidebar_density: "comfortable",
      },
      general: { import_login_environment: false },
    });
    expect(parseTomlValue(next)).toEqual({
      ...document,
      appearance: {
        ...appearance,
        terminal_font_size: 15,
        sidebar_density: "comfortable",
      },
      general: { import_login_environment: false },
    });
  });
});

describe("rendering a whole document", () => {
  it("puts scalars first, then tables, then arrays of tables", () => {
    const text = renderTomlDocument({
      version: 1,
      general: { import_login_environment: true },
      agent_profiles: [{ id: "codex", env: { TOKEN: "x" } }],
    });
    expect(parseTomlValue(text)).toEqual({
      version: 1,
      general: { import_login_environment: true },
      agent_profiles: [{ id: "codex", env: { TOKEN: "x" } }],
    });
    expect(text.indexOf("version")).toBeLessThan(text.indexOf("[general]"));
  });
});
