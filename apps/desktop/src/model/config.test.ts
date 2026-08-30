import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  ConfigStore,
  configToToml,
  contentRevision,
  defaultConfig,
  isSafeTmuxArgument,
  isValidSocketName,
  parseConfig,
  type ValidationCode,
} from "./config.js";
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
        parseConfig("version = 1\n[appearance.terminal_theme.light]\nnope = 1\n"),
      ),
    ).toBe("unknown_key");
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
        parseConfig("version = 1\n[appearance]\nsidebar_density = \"roomy\"\n"),
      ),
    ).toBe("invalid_appearance");
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
    await writeFile(path, "version = 1\n[appearance]\nterminal_font_size = 15\n");
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
    await writeFile(path, "version = 1\n[appearance]\nterminal_font_size = 15\n");
    const failure = await store
      .save(loaded.revision, loaded.config)
      .then(() => undefined, (error: unknown) => error);
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
