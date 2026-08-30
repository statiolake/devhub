import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  ConfigStore,
  configOntoDocument,
  configToToml,
  contentRevision,
  defaultConfig,
  isSafeTmuxArgument,
  isValidSocketName,
  parseConfig,
  type ValidationCode,
} from "./config.js";
import { isValidFontFamily, MAX_FONT_FAMILY_LENGTH } from "./fontFamily.js";
import { makeScratchDir, removeScratchDir } from "./testScratch.js";

function codeOf(run: () => unknown): ValidationCode | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ConfigError ? error.code : undefined;
  }
  return undefined;
}

const MINIMAL = "version = 1\n";
const EMPTY_FONT = 'version = 1\n[appearance]\nterminal_font_family = ""\n';

function pathOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ConfigError ? error.diagnostic.path : undefined;
  }
  return undefined;
}

describe("parsing", () => {
  it("fills every section from defaults when only the version is present", () => {
    const config = parseConfig(MINIMAL);
    expect(config).toEqual(defaultConfig());
  });

  it("refuses an unknown key rather than ignoring a typo", () => {
    expect(codeOf(() => parseConfig("version = 1\nnonsense = true\n"))).toBe(
      "unknown_key",
    );
    expect(
      codeOf(() => parseConfig("version = 1\n[general]\nnope = true\n")),
    ).toBe("unknown_key");
    expect(
      codeOf(() =>
        parseConfig(
          "version = 1\n[appearance.terminal_theme.light]\nnope = 1\n",
        ),
      ),
    ).toBe("unknown_key");
  });

  it("still loads a file with a retired key, and says so once", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const retired = 'version = 1\n[appearance]\ncolor_scheme = "dark"\n';
    try {
      expect(parseConfig(retired)).toEqual(defaultConfig());
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0][0]).toContain("appearance.color_scheme");
    } finally {
      info.mockRestore();
    }
    // And the next save drops it, rather than keeping a key nothing reads.
    const saved = configOntoDocument(retired, parseConfig(retired));
    expect(saved).not.toContain("color_scheme");
  });

  it("refuses a version it does not implement", () => {
    expect(codeOf(() => parseConfig("version = 2\n"))).toBe(
      "unsupported_version",
    );
  });

  it("reports a syntax error as a parse diagnostic", () => {
    expect(codeOf(() => parseConfig("version = \n"))).toBe("parse");
  });

  it("rejects a runtime that is neither a path nor a bare command name", () => {
    expect(
      codeOf(() => parseConfig('version = 1\n[runtimes]\nshell = "bin/zsh"\n')),
    ).toBe("invalid_runtime");
    expect(
      parseConfig('version = 1\n[runtimes]\nshell = "~/bin/zsh"\n').runtimes
        .shell,
    ).toBe("~/bin/zsh");
  });

  it("allows only the two tmux arguments that cannot change targeting", () => {
    expect(isSafeTmuxArgument("-u")).toBe(true);
    expect(isSafeTmuxArgument("-2")).toBe(true);
    expect(isSafeTmuxArgument("-L")).toBe(false);
    expect(
      codeOf(() =>
        parseConfig('version = 1\n[runtimes]\ntmux_args = ["-L", "other"]\n'),
      ),
    ).toBe("forbidden_tmux_argument");
  });

  it("validates the socket name character set", () => {
    expect(isValidSocketName("devhub")).toBe(true);
    expect(isValidSocketName("dev/hub")).toBe(false);
    expect(isValidSocketName("")).toBe(false);
  });

  it("rejects appearance values outside the supported range", () => {
    expect(
      codeOf(() =>
        parseConfig("version = 1\n[appearance]\nterminal_font_size = 40\n"),
      ),
    ).toBe("invalid_appearance");
    expect(
      codeOf(() =>
        parseConfig('version = 1\n[appearance]\nsidebar_density = "roomy"\n'),
      ),
    ).toBe("invalid_appearance");
  });

  it("takes any font family CSS would take", () => {
    // The four spellings a person actually types: a bare name, a name with a
    // space, a fallback list, and a quoted name. None of them is DevHub's
    // business to second-guess — CSS resolves the name, and falls back when it
    // cannot.
    for (const family of [
      "Menlo",
      "SF Mono",
      "JetBrains Mono, Menlo, monospace",
      '"Fira Code"',
      "ui-monospace",
    ]) {
      expect(isValidFontFamily(family)).toBe(true);
      const document = `version = 1\n[appearance]\nterminal_font_family = ${JSON.stringify(family)}\n`;
      expect(parseConfig(document).appearance.terminalFontFamily).toBe(family);
    }
  });

  it("names the font family itself when it is the value that is wrong", () => {
    // Not "appearance": the diagnostic is what the Settings window turns into
    // a sentence, so it has to carry which key was refused.
    expect(codeOf(() => parseConfig(EMPTY_FONT))).toBe("invalid_font_family");
    expect(pathOf(() => parseConfig(EMPTY_FONT))).toBe(
      "appearance.terminal_font_family",
    );
    expect(isValidFontFamily("")).toBe(false);
    expect(isValidFontFamily("   ")).toBe(false);
    expect(isValidFontFamily("Men\u0000lo")).toBe(false);
    expect(isValidFontFamily("M".repeat(MAX_FONT_FAMILY_LENGTH + 1))).toBe(
      false,
    );
    expect(isValidFontFamily("M".repeat(MAX_FONT_FAMILY_LENGTH))).toBe(true);
  });

  it("rejects a duplicate identity in either array", () => {
    const sources = [
      "version = 1",
      "[[workspace_sources]]",
      'type = "command"',
      'id = "one"',
      'command = ["a"]',
      "[[workspace_sources]]",
      'type = "command"',
      'id = "one"',
      'command = ["b"]',
      "",
    ].join("\n");
    expect(codeOf(() => parseConfig(sources))).toBe("duplicate_identity");
  });

  it("rejects a filesystem source that mixes directory and git kinds", () => {
    const source = [
      "version = 1",
      "[[workspace_sources]]",
      'type = "filesystem"',
      'id = "mixed"',
      'path = "~/dev"',
      'kinds = ["directory", "git_repository"]',
      "",
    ].join("\n");
    expect(codeOf(() => parseConfig(source))).toBe("invalid_workspace_kind");
  });

  it("rejects an environment key that is not an environment name", () => {
    const profile = [
      "version = 1",
      "[[agent_profiles]]",
      'id = "codex"',
      'display_name = "Codex"',
      'kind = "codex"',
      "[agent_profiles.env]",
      '"not a name" = "x"',
      "",
    ].join("\n");
    expect(codeOf(() => parseConfig(profile))).toBe("invalid_environment_key");
  });
});

describe("round trip", () => {
  it("re-parses to the same config", () => {
    const config = defaultConfig();
    expect(parseConfig(configToToml(config))).toEqual(config);
  });

  it("empties a collection and fills it again, re-parsing each time", () => {
    const full = configToToml(defaultConfig());
    const config = parseConfig(full);
    expect(config.workspaceSources.length).toBeGreaterThan(0);

    const emptied = configOntoDocument(full, {
      ...config,
      workspaceSources: [],
    });
    expect(emptied).not.toContain("[[workspace_sources]]");
    expect(parseConfig(emptied).workspaceSources).toEqual([]);
    // Emptying one collection leaves the other alone.
    expect(parseConfig(emptied).agentProfiles).toEqual(config.agentProfiles);

    const refilled = configOntoDocument(emptied, {
      ...parseConfig(emptied),
      workspaceSources: config.workspaceSources,
    });
    expect(parseConfig(refilled)).toEqual(config);
  });

  it("empties every collection at once and still re-parses", () => {
    const full = configToToml(defaultConfig());
    const emptied = configOntoDocument(full, {
      ...parseConfig(full),
      workspaceSources: [],
      agentProfiles: [],
    });
    const reparsed = parseConfig(emptied);
    expect(reparsed.workspaceSources).toEqual([]);
    expect(reparsed.agentProfiles).toEqual([]);
  });
});

describe("store", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = makeScratchDir("config");
    path = join(directory, "config.toml");
  });

  afterEach(() => {
    removeScratchDir(directory);
  });

  it("writes the defaults when there is no file yet", async () => {
    const store = new ConfigStore(path);
    const loaded = await store.load();
    expect(loaded.config).toEqual(defaultConfig());
    expect(parseConfig(await readFile(path, "utf8"))).toEqual(defaultConfig());
  });

  it("reports an unchanged file without re-adopting it", async () => {
    const store = new ConfigStore(path);
    await store.load();
    const outcome = await store.reload();
    expect(outcome.kind).toBe("unchanged");
  });

  it("adopts an external edit and reports it applied", async () => {
    const store = new ConfigStore(path);
    await store.load();
    await writeFile(
      path,
      "version = 1\n[appearance]\nterminal_font_size = 15\n",
    );
    const outcome = await store.reload();
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.loaded.config.appearance.terminalFontSize).toBe(15);
  });

  it("keeps the last good config and records the diagnostic when the file breaks", async () => {
    const store = new ConfigStore(path);
    const good = await store.load();
    await writeFile(path, "version = 1\nnonsense = true\n");
    await expect(store.reload()).rejects.toBeInstanceOf(ConfigError);
    expect(store.current()).toEqual(good);
    expect(store.lastDiagnostic()?.code).toBe("unknown_key");
  });

  it("refuses a save over a file that changed underneath it", async () => {
    const store = new ConfigStore(path);
    const loaded = await store.load();
    await writeFile(
      path,
      "version = 1\n[appearance]\nterminal_font_size = 15\n",
    );
    const failure = await store.save(loaded.revision, loaded.config).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).code).toBe("conflict");
  });

  it("saves over the revision it was given and returns the new one", async () => {
    const store = new ConfigStore(path);
    const loaded = await store.load();
    const next = {
      ...loaded.config,
      appearance: { ...loaded.config.appearance, terminalFontSize: 16 },
    };
    const saved = await store.save(loaded.revision, next);
    expect(saved.config.appearance.terminalFontSize).toBe(16);
    expect(saved.revision).toBe(contentRevision(await readFile(path)));
  });
});

describe("saving over a hand-written file", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = makeScratchDir("config-roundtrip");
    path = join(directory, "config.toml");
  });

  afterEach(() => {
    removeScratchDir(directory);
  });

  it("keeps the comments, grouping and order the person wrote", async () => {
    const handWritten = [
      "# My DevHub config. Do not reformat.",
      "version = 1",
      "",
      "# Small on this display.",
      "[appearance]",
      "terminal_font_size = 13",
      'terminal_font_family = "SF Mono"',
      "",
      "[runtimes]",
      'shell = "/bin/zsh"   # not fish, on purpose',
      "",
    ].join("\n");
    await writeFile(path, handWritten, { mode: 0o600 });

    const store = new ConfigStore(path);
    const loaded = await store.load();
    await store.save(loaded.revision, {
      ...loaded.config,
      appearance: { ...loaded.config.appearance, terminalFontSize: 15 },
    });

    const saved = await readFile(path, "utf8");
    expect(saved).toContain("# My DevHub config. Do not reformat.");
    expect(saved).toContain("# Small on this display.");
    expect(saved).toContain("# not fish, on purpose");
    expect(saved).toContain("terminal_font_size = 15");
    expect(saved).toContain('terminal_font_family = "SF Mono"');

    // Every line the person wrote is still there, in the order they wrote it,
    // byte for byte apart from the one value that changed.
    const lines = saved.split("\n");
    const written = handWritten
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) =>
        line.replace("terminal_font_size = 13", "terminal_font_size = 15"),
      );
    const positions = written.map((line) => lines.indexOf(line));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // A section the file left implicit is written out, because a save states
    // the whole config — the same as the Rust's document merge. What it never
    // does is rewrite what was already there.
    expect(saved).toContain("[appearance.terminal_theme.light]");
    expect(parseConfig(saved).appearance.terminalFontSize).toBe(15);
  });

  it("saves every font family spelling and keeps the comments around it", async () => {
    const handWritten = [
      "# My DevHub config. Do not reformat.",
      "version = 1",
      "",
      "[appearance]",
      'terminal_font_family = "ui-monospace"',
      "",
    ].join("\n");

    for (const family of [
      "SF Mono",
      "Menlo",
      "JetBrains Mono, Menlo, monospace",
      '"Fira Code"',
    ]) {
      await writeFile(path, handWritten, { mode: 0o600 });
      const store = new ConfigStore(path);
      const loaded = await store.load();
      const saved = await store.save(loaded.revision, {
        ...loaded.config,
        appearance: {
          ...loaded.config.appearance,
          terminalFontFamily: family,
        },
      });

      expect(saved.config.appearance.terminalFontFamily).toBe(family);
      const text = await readFile(path, "utf8");
      expect(text).toContain("# My DevHub config. Do not reformat.");
      // Read back through the parser rather than matched as text: a quoted
      // name only survives if the escaping and the parsing agree.
      expect(parseConfig(text).appearance.terminalFontFamily).toBe(family);
    }
  });
});
