/**
 * What a value in `config.toml` has to be, said in the window's own words.
 *
 * The authority is `model/config.ts`: it validates the whole file before any of
 * it is adopted, and a value that gets past this module still has to get past
 * that one. This module exists because the loader lives in the main process and
 * imports `node:fs`, so the Settings page cannot call it — and because a
 * refusal that arrives after a round trip, phrased as a diagnostic code, is not
 * something a person can act on while they are still typing.
 *
 * Two statements of one rule is exactly the arrangement that rots. So it is not
 * left to trust: `rules.test.ts` runs every sentence here against the real
 * validator over a corpus of values and fails if the two ever disagree about
 * what is acceptable. Add a rule here, add it to the corpus.
 *
 * The sentences are also what a refused save says (`ruleMessage`), so the field
 * and the notice cannot describe the same rule two different ways.
 */

import { dateTemplateBracketsBalance } from "../model/dateTemplate";

export const ID_RULE =
  "An identifier starts with a lowercase letter, then uses lowercase letters, digits, dashes and underscores — at most 64 characters.";

export const DUPLICATE_RULE =
  "Two entries have the same identifier. Each one has to be unique.";

export const RUNTIME_RULE =
  "A runtime is either a bare command name looked up on your PATH, or an absolute path (or one starting with ~/). It cannot be empty.";

export const SOCKET_RULE =
  "A tmux socket name uses letters, digits, dots, dashes and underscores, is at most 64 characters, and cannot be empty.";

export const TMUX_ARGUMENT_RULE =
  "Only the tmux options -u and -2 are allowed; the rest could point DevHub at another server.";

export const WORKSPACE_PATH_RULE =
  "A folder is an absolute path, or one starting with ~/ (or ~ on its own).";

export const DATE_TEMPLATE_RULE =
  "A date path has a closing bracket for every opening one; text inside brackets is used as written.";

export const EXCLUDE_NAME_RULE =
  "A name to skip is a plain folder name: no slashes and no wildcards.";

export const DISPLAY_NAME_RULE = "A name cannot be empty.";

export const ENVIRONMENT_NAME_RULE =
  "A variable name starts with a letter or underscore, then uses letters, digits and underscores.";

export const TEXT_RULE = "That value cannot contain a null character.";

const hasNull = (value: string): boolean => value.includes("\0");

export function idProblem(value: string): string | undefined {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? undefined : ID_RULE;
}

export function runtimeProblem(value: string): string | undefined {
  if (hasNull(value)) return TEXT_RULE;
  const valid =
    value.startsWith("/") ||
    value === "~" ||
    value.startsWith("~/") ||
    (value.length > 0 && !value.includes("/"));
  return valid ? undefined : RUNTIME_RULE;
}

export function socketProblem(value: string): string | undefined {
  const valid =
    value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(value);
  return valid ? undefined : SOCKET_RULE;
}

export function workspacePathProblem(value: string): string | undefined {
  if (hasNull(value)) return TEXT_RULE;
  const valid =
    value.length > 0 &&
    value !== "~user" &&
    (value.startsWith("/") || value === "~" || value.startsWith("~/"));
  return valid ? undefined : WORKSPACE_PATH_RULE;
}

/**
 * A dated path: a workspace path, plus balanced brackets.
 *
 * Two rules rather than one because they are two different mistakes, and the
 * sentence that helps is different for each: "that is not a full path" and
 * "you opened a bracket and did not close it". The bracket rule is the same
 * one the loader applies, read from the same function, so the field cannot
 * accept a value the file would refuse.
 */
export function dateTemplateProblem(value: string): string | undefined {
  const path = workspacePathProblem(value);
  if (path !== undefined) return path;
  return dateTemplateBracketsBalance(value) ? undefined : DATE_TEMPLATE_RULE;
}

export function excludeNameProblem(value: string): string | undefined {
  const valid =
    value.length > 0 &&
    !hasNull(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !/[*?[\]{}]/.test(value);
  return valid ? undefined : EXCLUDE_NAME_RULE;
}

export function displayNameProblem(value: string): string | undefined {
  if (hasNull(value)) return TEXT_RULE;
  return value.trim().length === 0 ? DISPLAY_NAME_RULE : undefined;
}

export function environmentNameProblem(value: string): string | undefined {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    ? undefined
    : ENVIRONMENT_NAME_RULE;
}

/** Command arguments and agent arguments: anything but a null byte. */
export function argumentProblem(value: string): string | undefined {
  return hasNull(value) ? TEXT_RULE : undefined;
}

/**
 * The four things a filesystem source can look for.
 *
 * The config allows any non-empty set of kinds *except* one mixing `directory`
 * with a git kind — the loader refuses that combination outright. Three
 * independent checkboxes could therefore be ticked into a config that could not
 * be saved, with the refusal arriving later and naming `kinds`. A popup over
 * the four sets that are actually legal cannot express the illegal one at all,
 * which is the difference between validating a mistake and not offering it.
 */
export type MatchChoice =
  | "directory"
  | "git_repository"
  | "git_worktree"
  | "git_both";

export const MATCH_CHOICES: readonly (readonly [MatchChoice, string])[] = [
  ["directory", "Any folder"],
  ["git_repository", "Git repositories"],
  ["git_worktree", "Git worktrees"],
  ["git_both", "Git repositories and worktrees"],
];

export type WorkspaceKind = "directory" | "git_repository" | "git_worktree";

export function kindsOf(choice: MatchChoice): WorkspaceKind[] {
  return choice === "git_both" ? ["git_repository", "git_worktree"] : [choice];
}

export function choiceOf(kinds: readonly WorkspaceKind[]): MatchChoice {
  const git = kinds.filter((kind) => kind !== "directory");
  if (git.length === 2) return "git_both";
  if (git.length === 1) return git[0] as MatchChoice;
  return "directory";
}
