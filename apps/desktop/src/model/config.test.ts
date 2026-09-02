import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  type ConfigPaths,
  ConfigStore,
  configOntoDocument,
  configToToml,
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

  it("offers the three agents DevHub knows how to start", () => {
    expect(
      defaultConfig().agentProfiles.map((profile) => [
        profile.id,
        profile.kind,
        profile.command,
      ]),
    ).toEqual([
      ["codex", "codex", "codex"],
      ["claude", "claude", "claude"],
      // A screen manifest now, so a kind of its own — and a command that is
      // deliberately not the kind's name, because `cursor` is the editor.
      ["cursor", "cursor", "cursor-agent"],
    ]);
  });

  it("reads a dated source, and defaults it to offering today before it exists", () => {
    const source = [
      "version = 1",
      "",
      "[[workspace_sources]]",
      'type = "date"',
      'id = "daily"',
      'path = "~/workspace/daily/YYYY/MMDD"',
      "",
    ].join("\n");
    expect(parseConfig(source).workspaceSources).toEqual([
      {
        type: "date",
        id: "daily",
        path: "~/workspace/daily/YYYY/MMDD",
        create_if_missing: true,
      },
    ]);
    // And it survives being written back out.
    expect(parseConfig(configToToml(parseConfig(source)))).toEqual(
      parseConfig(source),
    );
  });

  it("refuses a dated source whose brackets do not close", () => {
    const source = [
      "version = 1",
      "",
      "[[workspace_sources]]",
      'type = "date"',
      'id = "daily"',
      'path = "~/[YYYY"',
      "",
    ].join("\n");
    expect(codeOf(() => parseConfig(source))).toBe("invalid_date_template");
  });

  it("ships one action per thing that can fire one", () => {
    // Defaults rather than a fixed set: the wording is the person's, and a file
    // that lists actions replaces this list entirely. What DevHub decides is
    // that these four things can happen — assigning an Issue, and the three
    // shortcuts a workspace offers while work is under way.
    const actions = parseConfig(MINIMAL).agentActions;
    expect(actions.map((action) => action.id)).toEqual([
      "issue_assignment",
      "commit_changes",
      "push_commits",
      "open_pull_request",
    ]);
    for (const action of actions) {
      expect(action.display_name.length).toBeGreaterThan(0);
      expect(action.template.length).toBeGreaterThan(0);
    }
  });

  it("takes the actions the file lists, in the file's own order", () => {
    const source = [
      "version = 1",
      "",
      "[[agent_actions]]",
      'id = "implement"',
      'display_name = "Work on it"',
      'template = "read {{ISSUE_URL}}"',
      "",
      "[[agent_actions]]",
      'id = "review"',
      'display_name = "Review it"',
      'template = "review {{ISSUE_URL}}"',
      "",
    ].join("\n");
    expect(
      parseConfig(source).agentActions.map((action) => action.display_name),
    ).toEqual(["Work on it", "Review it"]);
    expect(parseConfig(configToToml(parseConfig(source)))).toEqual(
      parseConfig(source),
    );
  });

  it("refuses two actions with one identifier", () => {
    // The flow's answer names an action by its id; two of them would make the
    // answer ambiguous.
    const source = [
      "version = 1",
      "",
      "[[agent_actions]]",
      'id = "same"',
      'display_name = "One"',
      'template = "a"',
      "",
      "[[agent_actions]]",
      'id = "same"',
      'display_name = "Two"',
      'template = "b"',
      "",
    ].join("\n");
    expect(codeOf(() => parseConfig(source))).toBe("duplicate_identity");
  });

  it("refuses an action with no name to show", () => {
    const source = [
      "version = 1",
      "",
      "[[agent_actions]]",
      'id = "nameless"',
      'display_name = "  "',
      'template = "a"',
      "",
    ].join("\n");
    expect(codeOf(() => parseConfig(source))).toBe("invalid_profile");
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
    expect(
      codeOf(() =>
        parseConfig('version = 1\n[appearance]\nmode = "midnight"\n'),
      ),
    ).toBe("invalid_appearance");
  });

  it("carries the three appearances, and defaults to following the OS", () => {
    expect(defaultConfig().appearance.mode).toBe("auto");
    for (const mode of ["auto", "light", "dark"]) {
      const parsed = parseConfig(
        `version = 1\n[appearance]\nmode = "${mode}"\n`,
      );
      expect(parsed.appearance.mode).toBe(mode);
      // A save has to state it, or choosing Light would last until the next one.
      expect(configOntoDocument("version = 1\n", parsed)).toContain(
        `mode = "${mode}"`,
      );
    }
  });

  it("keeps the retired colour scheme retired, now that a mode exists", () => {
    // The two are not the same setting: `color_scheme` asked what colour DevHub
    // should paint itself, which the workbench theme answers, and `mode` asks
    // which appearance the process runs in. An old file must not have its dead
    // key quietly revived as the new one.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const parsed = parseConfig(
        'version = 1\n[appearance]\ncolor_scheme = "dark"\n',
      );
      expect(parsed.appearance.mode).toBe("auto");
      expect(info.mock.calls[0][0]).toContain("appearance.mode");
    } finally {
      info.mockRestore();
    }
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
    // Sources of its own rather than the defaults': the subject is the round
    // trip through an emptied collection, and the default list is empty on
    // purpose, so borrowing it would leave nothing to empty.
    const full = configToToml({
      ...defaultConfig(),
      workspaceSources: [
        {
          type: "filesystem",
          id: "dev",
          path: "~/dev",
          min_depth: 1,
          max_depth: 2,
          kinds: ["git_repository"],
          include_hidden: false,
          exclude_names: [],
        },
        {
          type: "date",
          id: "daily",
          path: "~/daily/YYYY/MMDD",
          create_if_missing: true,
        },
      ],
    });
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

  /**
   * The one place `kind` and `command` are not interchangeable.
   *
   * Codex and Claude are run by a program with the kind's own name, so the
   * defaulting rule reads as "the command is the kind" and nothing notices.
   * Cursor breaks that: `cursor-agent` is the Agent, and `cursor` is the
   * editor's launcher, which exists and starts successfully. Getting this
   * wrong would not raise "command not found" — it would open an editor in a
   * pane DevHub was watching for an Agent's screen.
   */
  it("defaults a cursor profile to cursor-agent, not cursor", () => {
    const source = [
      "version = 1",
      "",
      "[[agent_profiles]]",
      'id = "cursor"',
      'display_name = "Cursor"',
      'kind = "cursor"',
      "args = []",
      "",
      "[agent_profiles.env]",
      "",
    ].join("\n");
    const parsed = parseConfig(source);
    expect(parsed.agentProfiles[0]?.kind).toBe("cursor");
    expect(parsed.agentProfiles[0]?.command).toBe("cursor-agent");
  });

  /** A command written down wins over the kind's default, as for any kind. */
  it("lets a cursor profile name its own command", () => {
    const source = [
      "version = 1",
      "",
      "[[agent_profiles]]",
      'id = "cursor"',
      'display_name = "Cursor"',
      'kind = "cursor"',
      'command = "/opt/example/cursor-agent"',
      "args = []",
      "",
      "[agent_profiles.env]",
      "",
    ].join("\n");
    expect(parseConfig(source).agentProfiles[0]?.command).toBe(
      "/opt/example/cursor-agent",
    );
  });

  /**
   * The user's existing config says `kind = "custom"` for Cursor. Adding the
   * `cursor` kind must not make that file stop parsing: `custom` stays a real
   * member, and a profile that names a command keeps working untouched.
   */
  it("still accepts a cursor profile left on the custom kind", () => {
    const source = [
      "version = 1",
      "",
      "[[agent_profiles]]",
      'id = "cursor"',
      'display_name = "Cursor"',
      'kind = "custom"',
      'command = "cursor-agent"',
      "args = []",
      "",
      "[agent_profiles.env]",
      "",
    ].join("\n");
    const parsed = parseConfig(source);
    expect(parsed.agentProfiles[0]?.kind).toBe("custom");
    expect(parsed.agentProfiles[0]?.command).toBe("cursor-agent");
  });

  it("switches a profile to a custom runtime and still re-parses", () => {
    // A profile block written with its `env` as a sub-table heading, which is
    // how the shipped defaults are saved.
    const source = [
      "version = 1",
      "",
      "[[agent_profiles]]",
      'id = "codex"',
      'display_name = "Codex"',
      'kind = "codex"',
      "args = []",
      "",
      "[agent_profiles.env]",
      "",
      "[[agent_profiles]]",
      'id = "claude"',
      'display_name = "Claude"',
      'kind = "claude"',
      "args = []",
      "",
      "[agent_profiles.env]",
      "",
    ].join("\n");
    const config = parseConfig(source);
    const saved = configOntoDocument(source, {
      ...config,
      agentProfiles: config.agentProfiles.map((profile) =>
        profile.id === "claude"
          ? { ...profile, kind: "custom" as const, command: "my-agent" }
          : profile,
      ),
    });
    const reparsed = parseConfig(saved);
    expect(reparsed.agentProfiles.map((profile) => profile.kind)).toEqual([
      "codex",
      "custom",
    ]);
    expect(reparsed.agentProfiles[1].command).toBe("my-agent");
  });

  it("saves a document it did not change back byte for byte", () => {
    const full = configToToml(defaultConfig());
    expect(configOntoDocument(full, parseConfig(full))).toBe(full);
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
  let paths: ConfigPaths;

  beforeEach(() => {
    directory = makeScratchDir("config");
    path = join(directory, "settings.local.toml");
    paths = { global: join(directory, "settings.toml"), local: path };
  });

  afterEach(() => {
    removeScratchDir(directory);
  });

  it("writes the defaults when there is no file yet", async () => {
    const store = new ConfigStore(paths);
    const loaded = await store.load();
    expect(loaded.config).toEqual(defaultConfig());
    expect(parseConfig(await readFile(path, "utf8"))).toEqual(defaultConfig());
  });

  it("reports an unchanged file without re-adopting it", async () => {
    const store = new ConfigStore(paths);
    await store.load();
    const outcome = await store.reload();
    expect(outcome.kind).toBe("unchanged");
  });

  it("adopts an external edit and reports it applied", async () => {
    const store = new ConfigStore(paths);
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
    const store = new ConfigStore(paths);
    const good = await store.load();
    await writeFile(path, "version = 1\nnonsense = true\n");
    await expect(store.reload()).rejects.toBeInstanceOf(ConfigError);
    expect(store.current()).toEqual(good);
    expect(store.lastDiagnostic()?.code).toBe("unknown_key");
  });

  it("refuses a save over a file that changed underneath it", async () => {
    const store = new ConfigStore(paths);
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
    const store = new ConfigStore(paths);
    const loaded = await store.load();
    const next = {
      ...loaded.config,
      appearance: { ...loaded.config.appearance, terminalFontSize: 16 },
    };
    const saved = await store.save(loaded.revision, next);
    expect(saved.config.appearance.terminalFontSize).toBe(16);
    // The revision names the pair of files, so reading them fresh agrees.
    expect(saved.revision).toBe((await new ConfigStore(paths).load()).revision);
  });
});

describe("saving over a hand-written file", () => {
  let directory: string;
  let path: string;
  let paths: ConfigPaths;

  beforeEach(() => {
    directory = makeScratchDir("config-roundtrip");
    path = join(directory, "settings.local.toml");
    paths = { global: join(directory, "settings.toml"), local: path };
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

    const store = new ConfigStore(paths);
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
      const store = new ConfigStore(paths);
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

describe("two scopes", () => {
  let directory: string;
  let paths: ConfigPaths;

  beforeEach(() => {
    directory = makeScratchDir("config-scopes");
    paths = {
      global: join(directory, "settings.toml"),
      local: join(directory, "settings.local.toml"),
      legacy: join(directory, "config.toml"),
    };
  });

  afterEach(() => {
    removeScratchDir(directory);
  });

  it("runs on both files, with the local one having the last word", async () => {
    await writeFile(
      paths.global,
      'version = 1\n[appearance]\nterminal_font_size = 12\nsidebar_density = "comfortable"\n',
    );
    await writeFile(
      paths.local,
      "version = 1\n[appearance]\nterminal_font_size = 20\n",
    );

    const loaded = await new ConfigStore(paths).load();
    expect(loaded.config.appearance.terminalFontSize).toBe(20);
    expect(loaded.config.appearance.sidebarDensity).toBe("comfortable");
  });

  it("does not let a default in one file beat a value in the other", async () => {
    // The local file says nothing about the font, so the shared file's answer
    // has to survive — which it only does if the two are merged before the
    // defaults are filled in.
    await writeFile(
      paths.global,
      'version = 1\n[appearance]\nterminal_font_family = "SF Mono"\n',
    );
    await writeFile(
      paths.local,
      'version = 1\n[runtimes]\nshell = "/bin/bash"\n',
    );

    const loaded = await new ConfigStore(paths).load();
    expect(loaded.config.appearance.terminalFontFamily).toBe("SF Mono");
    expect(loaded.config.runtimes.shell).toBe("/bin/bash");
  });

  it("writes a save to the local file and never to the shared one", async () => {
    const shared = "version = 1\n[appearance]\nterminal_font_size = 12\n";
    await writeFile(paths.global, shared);
    await writeFile(paths.local, "");

    const store = new ConfigStore(paths);
    const loaded = await store.load();
    await store.save(loaded.revision, {
      ...loaded.config,
      runtimes: { ...loaded.config.runtimes, shell: "/bin/bash" },
    });

    expect(await readFile(paths.global, "utf8")).toBe(shared);
    expect(await readFile(paths.local, "utf8")).toContain("/bin/bash");
  });

  it("leaves out of the local file what the shared file already says", async () => {
    await writeFile(
      paths.global,
      "version = 1\n[appearance]\nterminal_font_size = 12\nterminal_line_height = 1.2\n",
    );
    await writeFile(paths.local, "");

    const store = new ConfigStore(paths);
    const loaded = await store.load();
    await store.save(loaded.revision, loaded.config);

    const local = await readFile(paths.local, "utf8");
    expect(local).not.toContain("terminal_font_size");
    expect(local).not.toContain("terminal_line_height");
  });

  it("drops a local value once the shared file starts saying the same thing", async () => {
    // The operation this whole arrangement is for: a person copies a block
    // into the shared file, and the next save takes the local copy out rather
    // than leaving two spellings to drift apart.
    await writeFile(paths.global, "version = 1\n");
    await writeFile(paths.local, "[appearance]\nterminal_font_size = 17\n");
    const first = new ConfigStore(paths);
    const loaded = await first.load();
    expect(loaded.config.appearance.terminalFontSize).toBe(17);

    await writeFile(
      paths.global,
      "version = 1\n[appearance]\nterminal_font_size = 17\n",
    );
    const second = new ConfigStore(paths);
    const again = await second.load();
    await second.save(again.revision, again.config);

    expect(await readFile(paths.local, "utf8")).not.toContain(
      "terminal_font_size",
    );
    expect(
      (await new ConfigStore(paths).load()).config.appearance.terminalFontSize,
    ).toBe(17);
  });

  it("refuses a save made against a shared file that has since moved", async () => {
    await writeFile(
      paths.global,
      "version = 1\n[appearance]\nterminal_font_size = 12\n",
    );
    await writeFile(paths.local, "");
    const store = new ConfigStore(paths);
    const loaded = await store.load();

    await writeFile(
      paths.global,
      "version = 1\n[appearance]\nterminal_font_size = 13\n",
    );

    const failure = await store.save(loaded.revision, loaded.config).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as ConfigError).code).toBe("conflict");
  });

  it("notices an edit to the shared file the same as one to the local file", async () => {
    await writeFile(
      paths.global,
      "version = 1\n[appearance]\nterminal_font_size = 12\n",
    );
    await writeFile(paths.local, "");
    const store = new ConfigStore(paths);
    await store.load();

    await writeFile(
      paths.global,
      "version = 1\n[appearance]\nterminal_font_size = 19\n",
    );
    const outcome = await store.reload();
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.loaded.config.appearance.terminalFontSize).toBe(19);
  });

  it("says which file a bad key is in", async () => {
    await writeFile(paths.global, "version = 1\nnonsense = true\n");
    await writeFile(paths.local, "");
    const store = new ConfigStore(paths);
    await expect(store.load()).rejects.toBeInstanceOf(ConfigError);
    expect(store.lastDiagnostic()).toBeUndefined();

    const failure = await new ConfigStore(paths).load().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as ConfigError).diagnostic.code).toBe("unknown_key");
    expect((failure as ConfigError).diagnostic.scope).toBe("global");
  });

  it("blames the local file for a value the local file wrote", async () => {
    await writeFile(
      paths.global,
      "version = 1\n[appearance]\nterminal_font_size = 12\n",
    );
    await writeFile(
      paths.local,
      'version = 1\n[appearance]\nmode = "sideways"\n',
    );
    const failure = await new ConfigStore(paths).load().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as ConfigError).diagnostic.scope).toBe("local");
  });

  it("takes the pre-split file over as the local one, once", async () => {
    await writeFile(
      paths.legacy as string,
      "version = 1\n[appearance]\nterminal_font_size = 21\n",
    );

    const loaded = await new ConfigStore(paths).load();
    expect(loaded.config.appearance.terminalFontSize).toBe(21);
    expect(await readFile(paths.local, "utf8")).toContain(
      "terminal_font_size = 21",
    );
    // Gone, rather than left behind for DevHub to keep half-reading.
    await expect(readFile(paths.legacy as string, "utf8")).rejects.toThrow();
  });

  it("leaves the pre-split file alone once there is a local file", async () => {
    await writeFile(
      paths.legacy as string,
      "version = 1\n[appearance]\nterminal_font_size = 21\n",
    );
    await writeFile(
      paths.local,
      "version = 1\n[appearance]\nterminal_font_size = 9\n",
    );

    const loaded = await new ConfigStore(paths).load();
    expect(loaded.config.appearance.terminalFontSize).toBe(9);
    expect(await readFile(paths.legacy as string, "utf8")).toContain("21");
  });

  it("writes only the defaults the shared file does not already give", async () => {
    await writeFile(paths.global, configToToml(defaultConfig()));
    const loaded = await new ConfigStore(paths).load();
    expect(loaded.config).toEqual(defaultConfig());
    expect((await readFile(paths.local, "utf8")).trim()).toBe("");
  });
});
