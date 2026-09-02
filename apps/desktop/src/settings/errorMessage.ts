/**
 * What a refused save says.
 *
 * A refusal has to answer three questions, and it has to answer all three every
 * time: **which field**, **what the rule was**, and **what DevHub called it**.
 * Dropping any of them has happened twice now. The first time the window said
 * only "that value is not one DevHub can use" — no field, no rule, nothing to
 * act on. The second time it named a TOML path and stopped, which tells a
 * person where the trouble is and still not what would have been right.
 *
 * So the shape is fixed here, once, and the diagnostic code is always in it.
 * The code is not for the person: it is for the report they paste into an
 * issue, and it is the difference between "Settings is broken" and a defect
 * somebody can look up.
 *
 * The rule sentence is a `switch` over the code with **no `default`**. That is
 * deliberate and load-bearing: a diagnostic added to
 * `SettingsDiagnosticCodeWire` without a sentence here fails the typecheck, so
 * the dead-end sentence cannot come back by way of a code nobody thought
 * about. `errorMessage.test.ts` walks every code and asserts as much.
 */

import {
  GLOBAL_SETTINGS_FILE_NAME,
  LOCAL_SETTINGS_FILE_NAME,
  type SettingsDiagnosticCodeWire,
  type SettingsDiagnosticWire,
  type SettingsError,
  type SettingsScopeWire,
} from "../ipc/settings";
import { FONT_FAMILY_RULE } from "../model/fontFamily";
import {
  DUPLICATE_RULE,
  ENVIRONMENT_NAME_RULE,
  EXCLUDE_NAME_RULE,
  ID_RULE,
  RUNTIME_RULE,
  SOCKET_RULE,
  DATE_TEMPLATE_RULE,
  TMUX_ARGUMENT_RULE,
  WORKSPACE_PATH_RULE,
} from "./rules";

/**
 * The file a message is about.
 *
 * DevHub reads two, and only ever writes one, so the default is the local
 * file: everything a save can go wrong about happened there. A scope only
 * arrives on a problem found while *reading*, which is the one case where the
 * shared file can be the answer.
 */
export function settingsFileName(scope: SettingsScopeWire | undefined): string {
  return scope === "global"
    ? GLOBAL_SETTINGS_FILE_NAME
    : LOCAL_SETTINGS_FILE_NAME;
}

/**
 * The rule the value broke, in the words the field itself uses.
 *
 * Where a field states a rule (`rules.ts`), that same sentence is used here, so
 * a rule is never described one way while you are typing and another way once
 * the save comes back.
 */
export function ruleMessage(
  code: SettingsDiagnosticCodeWire,
  scope?: SettingsScopeWire,
): string {
  const file = settingsFileName(scope);
  switch (code) {
    // The rules a field states while you type.
    case "invalid_font_family":
      return FONT_FAMILY_RULE;
    case "invalid_runtime":
      return RUNTIME_RULE;
    case "invalid_socket_name":
      return SOCKET_RULE;
    case "forbidden_tmux_argument":
      return TMUX_ARGUMENT_RULE;
    case "invalid_id":
      return ID_RULE;
    case "duplicate_identity":
      return DUPLICATE_RULE;
    case "invalid_workspace_path":
      return WORKSPACE_PATH_RULE;
    case "invalid_date_template":
      return DATE_TEMPLATE_RULE;
    case "invalid_exclusion":
      return EXCLUDE_NAME_RULE;
    case "invalid_environment_key":
      return ENVIRONMENT_NAME_RULE;

    // Rules no single field owns.
    case "invalid_command":
      return "A command source needs at least one argument: the program to run.";
    case "invalid_timeout":
      return "A timeout is between 100 and 30000 milliseconds.";
    case "invalid_workspace_depth":
      return "A maximum depth is at least the minimum and at most 16.";
    case "invalid_workspace_kind":
      return "A source looks for folders or for Git checkouts, not both, and it has to look for something.";
    case "invalid_profile":
      return "An agent profile needs a name, and its arguments cannot contain a null character.";
    case "unknown_action":
      return "That is not an action DevHub has. Actions are built in; only their wording is configured.";
    case "invalid_profile_kind":
      return "An agent profile runs Codex, Claude, Cursor, or something else DevHub reads no status from.";
    case "invalid_appearance":
      return "A font size is 9 to 24, a line height 1 to 2, an inset 0 to 64, and a sidebar density Compact or Comfortable.";
    case "invalid_string":
      return "That value cannot contain a null character.";

    // Things about the file rather than a value in it.
    case "parse":
      return `${file} is not valid TOML at that point.`;
    case "invalid_utf8":
      return `${file} is not valid UTF-8.`;
    case "unknown_key":
      return "DevHub does not know that key. Check it for a typo — an unknown key is refused rather than ignored, so a misspelling never silently does nothing.";
    case "missing_required_field":
      return "That key has to be there.";
    case "invalid_type":
      return "That key holds a value of the wrong kind.";
    case "unsupported_version":
      return `${file} states a schema version this DevHub does not read.`;
    case "io":
      return `${file} could not be read or written.`;
    case "state_unavailable":
      return "DevHub could not reach the file.";
    case "serialization":
      return "DevHub could not write the file.";
    case "conflict":
      return `${file} changed after this window read it.`;
  }
}

/** `invalid_command (workspace_sources[0].command)`, or with a position. */
function where(diagnostic: SettingsDiagnosticWire): string {
  const at =
    diagnostic.line === undefined
      ? undefined
      : diagnostic.column === undefined
        ? `line ${String(diagnostic.line)}`
        : `line ${String(diagnostic.line)}, column ${String(diagnostic.column)}`;
  return [diagnostic.code, diagnostic.path, at]
    .filter((part) => part !== undefined)
    .join(", ");
}

/**
 * A problem with the file itself, rather than with a change somebody made.
 *
 * Same three answers, different framing: nothing was being saved, so saying
 * "that change was not saved" would name an act nobody performed. What is true
 * is that DevHub is running on the last file that parsed.
 */
export function fileDiagnosticMessage(
  diagnostic: SettingsDiagnosticWire,
): string {
  return `${settingsFileName(diagnostic.scope)} has a problem DevHub could not read, so it is running on the last version that parsed. ${ruleMessage(diagnostic.code, diagnostic.scope)} (${where(diagnostic)})`;
}

export function errorMessage(error: SettingsError): string {
  switch (error.code) {
    case "external_edit_conflict":
      return `${settingsFileName(error.diagnostic?.scope)} changed outside Settings. Reload to see the new file.`;
    case "invalid_config": {
      // Every refusal names its field and its code, whatever came back. A
      // diagnostic with neither a path nor a position is still a diagnostic
      // with a code, and the code is what makes it reportable.
      const diagnostic = error.diagnostic;
      if (!diagnostic) {
        return "That change was not saved, and DevHub did not say which value it refused. Please report this.";
      }
      const field = diagnostic.path
        ? `${diagnostic.path} was not saved.`
        : "That change was not saved.";
      return `${field} ${ruleMessage(diagnostic.code, diagnostic.scope)} (${where(diagnostic)})`;
    }
    case "invalid_file":
      return `${settingsFileName(error.diagnostic?.scope)} could not be read or written.`;
    case "runtime_unavailable":
      return "DevHub could not inspect the runtimes.";
    case "permission_denied":
      return "DevHub does not have permission to do that.";
    case "native_unavailable":
      return "The Settings window lost its connection to DevHub.";
    case "native_busy":
      return "Another action is still finishing. Try again in a moment.";
    case "native_timed_out":
      return "That action timed out. It may still be finishing.";
  }
}
