import { chmod, readFile, writeFile } from "node:fs/promises";
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

  /**
   * The file adds to the actions DevHub ships rather than replacing them.
   *
   * This is the whole point of the shape. It used to be an array, and an array
   * is what a scope replaces whole — so every configuration that had ever saved
   * one action had thereby deleted every action added to DevHub afterwards, and
   * nobody had the commit, push or pull-request buttons.
   */
  it("adds the file's actions to the ones DevHub ships", () => {
    const source = [
      "version = 1",
      "",
      "[agent_actions.issue.implement]",
      'display_name = "Work on it"',
      'template = "read {{ISSUE_URL}}"',
      "",
      "[agent_actions.issue.review]",
      'display_name = "Review it"',
      'template = "review {{ISSUE_URL}}"',
      "",
    ].join("\n");
    expect(
      parseConfig(source).agentActions.map((action) => action.display_name),
    ).toEqual([
      "Work on the Issue",
      "Work on it",
      "Review it",
      "Commit the changes",
      "Push the commits",
      "Open a pull request",
    ]);
    expect(parseConfig(configToToml(parseConfig(source)))).toEqual(
      parseConfig(source),
    );
  });

  it("takes the file's word about an action DevHub ships", () => {
    const source = [
      "version = 1",
      "",
      "[agent_actions.commit.commit_changes]",
      'template = "commit it"',
      "confirm_before_send = false",
      "",
    ].join("\n");
    const action = parseConfig(source).agentActions.find(
      (one) => one.id === "commit_changes",
    );
    expect(action?.template).toBe("commit it");
    expect(action?.confirm_before_send).toBe(false);
    // The name it did not restate is still the one DevHub ships, rather than
    // an empty string that would validate as a nameless action.
    expect(action?.display_name).toBe("Commit the changes");
  });

  it("takes an action away only when the file says so", () => {
    const source = [
      "version = 1",
      "",
      "[agent_actions.push.push_commits]",
      "enabled = false",
      "",
    ].join("\n");
    const actions = parseConfig(source).agentActions;
    expect(actions.map((one) => one.id)).toContain("push_commits");
    expect(actions.find((one) => one.id === "push_commits")?.enabled).toBe(
      false,
    );
  });

  it("puts a second action under a trigger after the one DevHub ships", () => {
    const source = [
      "version = 1",
      "",
      "[agent_actions.commit.commit_in_pieces]",
      'display_name = "Commit in pieces"',
      'template = "commit each change on its own"',
      "",
    ].join("\n");
    expect(
      parseConfig(source)
        .agentActions.filter((one) => one.trigger === "commit")
        .map((one) => one.id),
    ).toEqual(["commit_changes", "commit_in_pieces"]);
  });

  it("orders a trigger's actions the way the file asks", () => {
    const source = [
      "version = 1",
      "",
      "[agent_actions.commit.commit_in_pieces]",
      'display_name = "Commit in pieces"',
      'template = "one at a time"',
      "order = -1",
      "",
    ].join("\n");
    expect(
      parseConfig(source)
        .agentActions.filter((one) => one.trigger === "commit")
        .map((one) => one.id),
    ).toEqual(["commit_in_pieces", "commit_changes"]);
  });

  /**
   * The damage, and the repair. A file in the old shape is read as what it
   * meant — these actions, with these words — rather than as "and nothing
   * else", so the built-ins it had unwittingly deleted come back.
   */
  it("reads a file written in the old array shape, and restores what it dropped", () => {
    const source = [
      "version = 1",
      "",
      "[[agent_actions]]",
      'id = "issue_assignment"',
      'display_name = "Work on the Issue"',
      'template = "mine, edited"',
      "",
    ].join("\n");
    const actions = parseConfig(source).agentActions;
    expect(actions.map((one) => one.id)).toEqual([
      "issue_assignment",
      "commit_changes",
      "push_commits",
      "open_pull_request",
    ]);
    // The person's own wording survives the move; the trigger comes back from
    // the id, which is all the old shape ever said about it.
    const issue = actions.find((one) => one.id === "issue_assignment");
    expect(issue?.template).toBe("mine, edited");
    expect(issue?.trigger).toBe("issue");
    expect(actions.find((one) => one.id === "push_commits")?.trigger).toBe(
      "push",
    );
    // And it is written back out in the new shape, so the next save is a file
    // that cannot lose an action again.
    expect(configToToml(parseConfig(source))).toContain(
      "[agent_actions.commit.commit_changes]",
    );
  });

  it("refuses two actions with one identifier", () => {
    // The flow's answer names an action by its id; two of them would make the
    // answer ambiguous.
    const source = [
      "version = 1",
      "",
      "[agent_actions.issue.same]",
      'display_name = "One"',
      'template = "a"',
      "",
      "[agent_actions.commit.same]",
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
    path = join(directory, "settings.toml");
    paths = { file: path };
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

  /**
   * A broken file on the *first* read used to leave the diagnostic empty, so
   * the Settings window had nothing to show and the person was told only that
   * DevHub was unconfigured.
   */
  it("records the diagnostic when the file is already broken at load", async () => {
    await writeFile(path, "version = 1\nnonsense = true\n");
    const store = new ConfigStore(paths);
    await expect(store.load()).rejects.toBeInstanceOf(ConfigError);
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
    // The revision names the file's bytes, so reading it fresh agrees.
    expect(saved.revision).toBe((await new ConfigStore(paths).load()).revision);
  });

  /**
   * The first save over a file written before `agent_actions` became a table.
   *
   * It failed outright: the old `[[agent_actions]]` blocks stayed where they
   * were and the new `[agent_actions.<trigger>.<id>]` was written beside them,
   * which defines one key twice and does not parse. Nothing in the Settings
   * window could be changed at all until the file was edited by hand.
   */
  it("saves over a file written in the old array shape", async () => {
    await writeFile(
      path,
      [
        "version = 1",
        "",
        "[[agent_actions]]",
        'id = "issue_assignment"',
        'display_name = "Work on the Issue"',
        'template = "mine, edited"',
        "",
      ].join("\n"),
    );
    const store = new ConfigStore(paths);
    const loaded = await store.load();
    const saved = await store.save(loaded.revision, loaded.config);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("[[agent_actions]]");
    expect(text).toContain("[agent_actions.issue.issue_assignment]");
    expect(parseConfig(text).agentActions).toEqual(saved.config.agentActions);
    // The position within its trigger, counted from the first one.
    expect(text).toContain("order = 0");
    expect(text).not.toContain("order = -1");
  });

  it("resets a section back to the defaults", async () => {
    await writeFile(
      path,
      ["version = 1", "", "[appearance]", "terminal_font_size = 19", ""].join(
        "\n",
      ),
    );
    const store = new ConfigStore(paths);
    const loaded = await store.load();
    const reset = await store.resetScope(loaded.revision, ["appearance"]);
    expect(reset.config.appearance).toEqual(defaultConfig().appearance);
    // The default is spelled out in the file, not left as an absence: the file
    // states the whole configuration, and what has gone is the 19.
    expect(await readFile(path, "utf8")).not.toContain("= 19");
  });

  it("leaves the sections a reset does not name alone", async () => {
    await writeFile(
      path,
      [
        "version = 1",
        "",
        "[appearance]",
        "terminal_font_size = 19",
        "",
        "[runtimes]",
        'shell = "/bin/bash"',
        "",
      ].join("\n"),
    );
    const store = new ConfigStore(paths);
    const loaded = await store.load();
    const reset = await store.resetScope(loaded.revision, ["appearance"]);
    expect(reset.config.appearance).toEqual(defaultConfig().appearance);
    expect(reset.config.runtimes.shell).toBe("/bin/bash");
  });
});

describe("saving over a hand-written file", () => {
  let directory: string;
  let path: string;
  let paths: ConfigPaths;

  beforeEach(() => {
    directory = makeScratchDir("config-roundtrip");
    path = join(directory, "settings.toml");
    paths = { file: path };
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

describe("the files a configuration can arrive from", () => {
  let directory: string;
  let paths: ConfigPaths;

  beforeEach(() => {
    directory = makeScratchDir("config-arrival");
    paths = {
      file: join(directory, "settings.toml"),
      local: join(directory, "settings.local.toml"),
      legacy: join(directory, "config.toml"),
    };
  });

  afterEach(() => {
    removeScratchDir(directory);
  });

  const localPath = () => paths.local as string;
  const legacyPath = () => paths.legacy as string;

  it("takes the pre-split file over as the settings file, once", async () => {
    await writeFile(
      legacyPath(),
      "version = 1\n[appearance]\nterminal_font_size = 21\n",
    );

    const loaded = await new ConfigStore(paths).load();
    expect(loaded.config.appearance.terminalFontSize).toBe(21);
    expect(await readFile(paths.file, "utf8")).toContain(
      "terminal_font_size = 21",
    );
    // Gone, rather than left behind for DevHub to keep half-reading.
    await expect(readFile(legacyPath(), "utf8")).rejects.toThrow();
  });

  it("leaves the pre-split file alone once there is a settings file", async () => {
    await writeFile(
      legacyPath(),
      "version = 1\n[appearance]\nterminal_font_size = 21\n",
    );
    await writeFile(
      paths.file,
      "version = 1\n[appearance]\nterminal_font_size = 9\n",
    );

    const loaded = await new ConfigStore(paths).load();
    expect(loaded.config.appearance.terminalFontSize).toBe(9);
    expect(await readFile(legacyPath(), "utf8")).toContain("21");
  });

  it("does nothing when there is no per-machine file to fold in", async () => {
    await writeFile(
      paths.file,
      "version = 1\n[appearance]\nterminal_font_size = 12\n",
    );
    const store = new ConfigStore(paths);
    const loaded = await store.load();
    expect(store.lastMigration().kind).toBe("nothing-to-migrate");
    expect(loaded.config.appearance.terminalFontSize).toBe(12);
  });

  it("folds the per-machine file in and renames it away", async () => {
    await writeFile(
      paths.file,
      '# Mine.\nversion = 1\n[appearance]\nterminal_font_size = 12\nsidebar_density = "comfortable"\n',
    );
    await writeFile(
      localPath(),
      "version = 1\n[appearance]\nterminal_font_size = 20\n",
    );

    const store = new ConfigStore(paths);
    const loaded = await store.load();
    expect(store.lastMigration().kind).toBe("migrated");
    // Local's word, over what the file said, with everything else kept.
    expect(loaded.config.appearance.terminalFontSize).toBe(20);
    expect(loaded.config.appearance.sidebarDensity).toBe("comfortable");
    const text = await readFile(paths.file, "utf8");
    expect(text).toContain("terminal_font_size = 20");
    expect(text).toContain("# Mine.");
    await expect(readFile(localPath(), "utf8")).rejects.toThrow();
    expect(await readFile(`${localPath()}.migrated`, "utf8")).toContain(
      "terminal_font_size = 20",
    );
  });

  it("folds a per-machine file in when there is no settings file at all", async () => {
    await writeFile(
      localPath(),
      'version = 1\n[runtimes]\nshell = "/bin/bash"\n',
    );
    const loaded = await new ConfigStore(paths).load();
    expect(loaded.config.runtimes.shell).toBe("/bin/bash");
    expect(await readFile(paths.file, "utf8")).toContain("/bin/bash");
  });

  it("folds in once: a second start finds nothing to do", async () => {
    await writeFile(paths.file, "version = 1\n");
    await writeFile(
      localPath(),
      "version = 1\n[appearance]\nterminal_font_size = 20\n",
    );
    await new ConfigStore(paths).load();

    // The renamed file is not read again, so a later edit to it changes nothing.
    await writeFile(
      `${localPath()}.migrated`,
      "version = 1\n[appearance]\nterminal_font_size = 9\n",
    );
    const second = new ConfigStore(paths);
    const loaded = await second.load();
    expect(second.lastMigration().kind).toBe("nothing-to-migrate");
    expect(loaded.config.appearance.terminalFontSize).toBe(20);
  });

  it("fails the start when the fold cannot be written", async () => {
    await writeFile(paths.file, "version = 1\n");
    await writeFile(localPath(), "version = 1\n");
    // A directory where the temporary file has to go: the write cannot succeed
    // and must not be reported as a start on a configuration nobody has.
    await chmod(directory, 0o500);
    try {
      await expect(new ConfigStore(paths).load()).rejects.toThrow();
    } finally {
      await chmod(directory, 0o700);
    }
    // The old file is still there, so the next start can try again.
    expect(await readFile(localPath(), "utf8")).toContain("version = 1");
  });

  it("fails the start when the per-machine file will not parse", async () => {
    await writeFile(paths.file, "version = 1\n");
    await writeFile(localPath(), "this is not = = toml\n");
    const failure = await new ConfigStore(paths).load().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as ConfigError).code).toBe("parse");
  });
});

describe("the keyboard, as the file spells it", () => {
  it("has no overrides at all by default", () => {
    // Overrides and not the whole table: a file that stated every chord would
    // delete whatever DevHub adds next, which is the bug `agent_actions` had to
    // be reshaped to fix.
    expect(defaultConfig().keybindings).toEqual({
      prefix: "Cmd+q",
      chords: {},
    });
  });

  it("reads a prefix and a table of second strokes", () => {
    const config = parseConfig(`
version = 1

[keybindings]
prefix = "Ctrl+q"

[keybindings.chords]
"Shift+n" = "previous_workspace"
g = ""
`);
    expect(config.keybindings.prefix).toBe("Ctrl+q");
    expect(config.keybindings.chords).toEqual({
      "Shift+n": "previous_workspace",
      g: "",
    });
  });

  it("survives a round trip through the document", () => {
    const config = parseConfig(`
version = 1

[keybindings.chords]
"Cmd+j" = "next_tab"
`);
    expect(parseConfig(configToToml(config)).keybindings).toEqual(
      config.keybindings,
    );
  });

  it("keeps the file the person wrote when only a chord changed", () => {
    const source = `# mine
version = 1

[keybindings.chords]
"Cmd+j" = "next_tab"
`;
    const config = parseConfig(source);
    const written = configOntoDocument(source, {
      ...config,
      keybindings: {
        ...config.keybindings,
        chords: { "Cmd+j": "previous_tab" },
      },
    });
    expect(written).toContain("# mine");
    expect(written).toContain("previous_tab");
  });

  it("refuses a command id DevHub does not have", () => {
    expect(
      codeOf(() =>
        parseConfig(`version = 1\n[keybindings.chords]\ng = "teleport"\n`),
      ),
    ).toBe("unknown_command");
  });

  it("refuses a key that names a character instead of a key", () => {
    expect(
      codeOf(() =>
        parseConfig(
          `version = 1\n[keybindings.chords]\n"Shift+{" = "next_tab"\n`,
        ),
      ),
    ).toBe("invalid_keybinding");
    expect(
      codeOf(() =>
        parseConfig(`version = 1\n[keybindings]\nprefix = "Hyper+q"\n`),
      ),
    ).toBe("invalid_keybinding");
  });

  it("refuses two spellings of one key, because a key does one thing", () => {
    expect(
      codeOf(() =>
        parseConfig(
          `version = 1\n[keybindings.chords]\n"Shift+n" = "next_tab"\n"shift+N" = "previous_tab"\n`,
        ),
      ),
    ).toBe("duplicate_identity");
  });

  it("refuses a value that is not a command id at all", () => {
    expect(
      codeOf(() => parseConfig(`version = 1\n[keybindings.chords]\ng = 3\n`)),
    ).toBe("invalid_type");
  });

  it("refuses an unknown key under [keybindings], like everywhere else", () => {
    expect(
      codeOf(() => parseConfig(`version = 1\n[keybindings]\nsuffix = "x"\n`)),
    ).toBe("unknown_key");
  });
});

/**
 * The section a person is meant to write lines into.
 *
 * `[keybindings.chords]` is the one table in `settings.toml` whose whole
 * purpose is to be added to by hand, and DevHub used to write it as
 * `chords = {}` — so the first thing anybody did to it, adding a
 * `[keybindings.chords]` heading underneath, defined the key twice and the
 * whole file stopped parsing. The store kept the last configuration that
 * worked and said `config: parse`, which is the right behaviour for a broken
 * file and no help at all when DevHub wrote the trap itself.
 */
describe("the chords table, written so it can be added to", () => {
  let directory: string;
  let paths: ConfigPaths;

  beforeEach(() => {
    directory = makeScratchDir("config-chords");
    paths = { file: join(directory, "settings.toml") };
  });

  afterEach(() => {
    removeScratchDir(directory);
  });

  it("writes a heading for an empty table, not a one-line marker", async () => {
    const store = new ConfigStore(paths);
    const loaded = await store.load();
    await store.save(loaded.revision, defaultConfig());
    const written = await readFile(paths.file, "utf8");
    expect(written).toContain("[keybindings.chords]");
    expect(written).not.toContain("chords = {}");
  });

  it("takes a section appended by hand, and applies it", async () => {
    const store = new ConfigStore(paths);
    const first = await store.load();
    await store.save(first.revision, defaultConfig());

    // Exactly what a person would do to the file DevHub just wrote: find the
    // heading and put a line under it.
    const written = await readFile(paths.file, "utf8");
    await writeFile(
      paths.file,
      written.replace(
        "[keybindings.chords]",
        '[keybindings.chords]\n"Shift+n" = "previous_workspace"\ng = ""',
      ),
    );

    const reloaded = await new ConfigStore(paths).load();
    expect(reloaded.config.keybindings.chords).toEqual({
      "Shift+n": "previous_workspace",
      g: "",
    });
  });

  it("rewrites a file the old version wrote, on the next save", async () => {
    // `chords = {}` is what DevHub wrote before this; a file carrying it still
    // loads, and the next save spells it the way a person can extend.
    await writeFile(
      paths.file,
      'version = 1\n\n[keybindings]\nprefix = "Cmd+q"\nchords = {}\n',
    );
    const store = new ConfigStore(paths);
    const loaded = await store.load();
    expect(loaded.config.keybindings).toEqual({ prefix: "Cmd+q", chords: {} });

    await store.save(loaded.revision, loaded.config);
    const written = await readFile(paths.file, "utf8");
    expect(written).not.toContain("chords = {}");
    expect(written).toContain("[keybindings.chords]");
    // And it is still the same configuration, spelled differently.
    expect(parseConfig(written).keybindings).toEqual(loaded.config.keybindings);
  });
});
