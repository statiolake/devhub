/**
 * The Settings window and the config loader agree about what is acceptable.
 *
 * `rules.ts` restates, in the page, rules whose authority is `model/config.ts`.
 * It has to: the loader runs in the main process and imports `node:fs`, so the
 * page cannot call it, and a refusal that arrives after a round trip as a
 * diagnostic code is not something a person can act on mid-word.
 *
 * Two statements of one rule is the arrangement that rots — one of them keeps
 * working and the other quietly stops. So the correspondence is a test rather
 * than a promise: every value in the corpus is put through the field's rule and
 * through the real validator, and the two have to reach the same verdict. When
 * they disagree the window is either refusing what DevHub would have taken, or
 * (worse) accepting what it will not.
 *
 * Adding a rule to `rules.ts` means adding it here.
 */

import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  validateConfig,
  type Config,
  type ConfiguredAgentProfile,
  type DateSource,
  type FilesystemSource,
  type WorkspaceKind,
} from "../model/config.js";
import {
  argumentProblem,
  choiceOf,
  dateTemplateProblem,
  displayNameProblem,
  environmentNameProblem,
  excludeNameProblem,
  idProblem,
  kindsOf,
  MATCH_CHOICES,
  runtimeProblem,
  socketProblem,
  workspacePathProblem,
} from "./rules";

/** Everything a free-text field in this window plausibly receives. */
const CORPUS = [
  "",
  " ",
  "a",
  "abc",
  "ABC",
  "Abc",
  "a-b_c",
  "a.b",
  "1abc",
  "-lead",
  "_lead",
  "with space",
  "~",
  "~/dev",
  "~user",
  "/usr/local/bin/git",
  "x/y",
  "node_modules",
  "*.log",
  "a[1]",
  "~/YYYY/[DD]",
  "~/YYYY/[DD",
  "~/YYYY/DD]",
  "a{b}",
  "a?b",
  "a\\b",
  "VAR_1",
  "1VAR",
  "-u",
  "-2",
  "-x",
  "a".repeat(64),
  "a".repeat(65),
  "a\u0000b",
];

const SOURCE: FilesystemSource = {
  type: "filesystem",
  id: "source",
  path: "~/dev",
  min_depth: 1,
  max_depth: 2,
  kinds: ["git_repository"],
  include_hidden: false,
  exclude_names: [],
};

const DATED: DateSource = {
  type: "date",
  id: "daily",
  path: "~/workspace/daily/YYYY/MMDD",
  create_if_missing: true,
};

const PROFILE: ConfiguredAgentProfile = {
  id: "agent",
  display_name: "Agent",
  kind: "codex",
  command: "codex",
  args: [],
  env: {},
};

function base(): Config {
  return {
    ...defaultConfig(),
    workspaceSources: [SOURCE],
    agentProfiles: [PROFILE],
  };
}

/** Whether the loader would take this config at all. */
function accepted(config: Config): boolean {
  try {
    validateConfig(config);
    return true;
  } catch {
    // The verdict is the whole answer here; which code it refused with is
    // `config.test.ts`'s subject, not this one's.
    return false;
  }
}

/**
 * One field's rule against the loader, over the whole corpus.
 *
 * The failure message names the value and both verdicts, because "expected
 * true to be false" about the 19th string in a list is a failure nobody can
 * read.
 */
function agree(
  what: string,
  rule: (value: string) => string | undefined,
  place: (value: string) => Config,
) {
  for (const value of CORPUS) {
    const byLoader = accepted(place(value));
    expect(
      {
        field: what,
        value: JSON.stringify(value),
        accepted: rule(value) === undefined,
      },
      rule(value) ?? "accepted by the field",
    ).toEqual({
      field: what,
      value: JSON.stringify(value),
      accepted: byLoader,
    });
  }
}

describe("what the Settings fields refuse", () => {
  it("matches the loader on identifiers", () => {
    agree("workspace source id", idProblem, (id) => ({
      ...base(),
      workspaceSources: [{ ...SOURCE, id }],
    }));
    agree("agent profile id", idProblem, (id) => ({
      ...base(),
      agentProfiles: [{ ...PROFILE, id }],
    }));
  });

  it("matches the loader on the programs DevHub runs", () => {
    agree("runtimes.shell", runtimeProblem, (shell) => {
      const config = base();
      return { ...config, runtimes: { ...config.runtimes, shell } };
    });
  });

  it("matches the loader on the tmux socket name", () => {
    agree("runtimes.tmux_socket_name", socketProblem, (tmux_socket_name) => {
      const config = base();
      return { ...config, runtimes: { ...config.runtimes, tmux_socket_name } };
    });
  });

  it("matches the loader on a workspace source's folder", () => {
    agree("workspace source path", workspacePathProblem, (path) => ({
      ...base(),
      workspaceSources: [{ ...SOURCE, path }],
    }));
  });

  it("matches the loader on a dated source's folder", () => {
    agree("date source path", dateTemplateProblem, (path) => ({
      ...base(),
      workspaceSources: [{ ...DATED, path }],
    }));
  });

  it("matches the loader on the names a source skips", () => {
    agree("exclude name", excludeNameProblem, (name) => ({
      ...base(),
      workspaceSources: [{ ...SOURCE, exclude_names: [name] }],
    }));
  });

  it("matches the loader on an agent profile's name", () => {
    agree("display name", displayNameProblem, (display_name) => ({
      ...base(),
      agentProfiles: [{ ...PROFILE, display_name }],
    }));
  });

  it("matches the loader on environment variable names", () => {
    agree("environment key", environmentNameProblem, (key) => ({
      ...base(),
      agentProfiles: [{ ...PROFILE, env: { [key]: "value" } }],
    }));
  });

  it("matches the loader on arguments", () => {
    agree("agent argument", argumentProblem, (argument) => ({
      ...base(),
      agentProfiles: [{ ...PROFILE, args: [argument] }],
    }));
  });
});

describe("what a filesystem source can look for", () => {
  it("offers every set of kinds the loader accepts, and no other", () => {
    for (const [choice] of MATCH_CHOICES) {
      const kinds = kindsOf(choice);
      expect(
        accepted({ ...base(), workspaceSources: [{ ...SOURCE, kinds }] }),
        choice,
      ).toBe(true);
      // Round trip: what the popup shows for a config is the choice that
      // produced it, so opening and closing the window changes nothing.
      expect(choiceOf(kinds)).toBe(choice);
    }
  });

  it("cannot express the combination the loader refuses", () => {
    // Three independent checkboxes could: "Any folder" plus "Git repositories"
    // is a config that saves and then comes back refused, naming `kinds`.
    const mixed: WorkspaceKind[] = ["directory", "git_repository"];
    expect(
      accepted({ ...base(), workspaceSources: [{ ...SOURCE, kinds: mixed }] }),
    ).toBe(false);
    expect(MATCH_CHOICES.map(([choice]) => kindsOf(choice))).not.toContainEqual(
      mixed,
    );
  });
});
