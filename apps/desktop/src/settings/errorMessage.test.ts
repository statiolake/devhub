/**
 * A refused save always says which field, what the rule was, and what DevHub
 * called it.
 *
 * This has regressed twice. Once to "that value is not one DevHub can use" with
 * no field at all, and once to a bare TOML path with no rule — both times
 * because a diagnostic arrived that the message builder had no case for and
 * fell through to a sentence that says nothing. The point of these tests is
 * that no such fall-through exists any more: every code in the wire's own list
 * is walked here, with a synthetic diagnostic, and every one of them has to
 * produce a sentence carrying the code.
 *
 * The corpus is the wire type's list, written out. That is on purpose — it has
 * to be the thing that fails when a code is added, and a list derived from the
 * implementation could never fail.
 */

import { describe, expect, it } from "vitest";
import type { SettingsDiagnosticCodeWire } from "../ipc/settings";
import { errorMessage, ruleMessage } from "./errorMessage";

const CODES: readonly SettingsDiagnosticCodeWire[] = [
  "io",
  "state_unavailable",
  "invalid_utf8",
  "parse",
  "missing_required_field",
  "unknown_key",
  "invalid_type",
  "unsupported_version",
  "invalid_string",
  "invalid_id",
  "duplicate_identity",
  "invalid_runtime",
  "invalid_socket_name",
  "forbidden_tmux_argument",
  "invalid_appearance",
  "invalid_font_family",
  "invalid_workspace_path",
  "invalid_workspace_depth",
  "invalid_workspace_kind",
  "invalid_exclusion",
  "invalid_command",
  "invalid_timeout",
  "invalid_profile",
  "invalid_profile_kind",
  "invalid_environment_key",
  "conflict",
  "serialization",
];

describe("a refused save", () => {
  it("names the code for every diagnostic there is", () => {
    for (const code of CODES) {
      const message = errorMessage({
        code: "invalid_config",
        diagnostic: { code },
      });
      expect(message, code).toContain(code);
    }
  });

  it("states a rule for every diagnostic there is", () => {
    for (const code of CODES) {
      const rule = ruleMessage(code);
      // A sentence, not a paraphrase of the code: it has to tell somebody what
      // would have been right.
      expect(rule.length, code).toBeGreaterThan(20);
      expect(rule, code).not.toContain(code);
      expect(
        errorMessage({ code: "invalid_config", diagnostic: { code } }),
      ).toContain(rule);
    }
  });

  it("names the field when the diagnostic carries one", () => {
    const message = errorMessage({
      code: "invalid_config",
      diagnostic: {
        code: "invalid_command",
        path: "workspace_sources[0].command",
      },
    });
    expect(message).toContain("workspace_sources[0].command was not saved.");
    expect(message).toContain("needs at least one argument");
    expect(message).toContain(
      "(invalid_command, workspace_sources[0].command)",
    );
  });

  it("names the position when the diagnostic is about the file, not a field", () => {
    const message = errorMessage({
      code: "invalid_config",
      diagnostic: { code: "parse", line: 27, column: 2 },
    });
    expect(message).toContain("not valid TOML");
    expect(message).toContain("(parse, line 27, column 2)");
  });

  it("says so, rather than saying nothing, when there is no diagnostic at all", () => {
    // The shape the first regression took. It must never again read as a
    // sentence about the person's value when DevHub did not say which value.
    const message = errorMessage({ code: "invalid_config" });
    expect(message).toContain("did not say which value");
    expect(message).toContain("report");
  });

  it("keeps the sentences that are not about a value in the file", () => {
    expect(errorMessage({ code: "external_edit_conflict" })).toContain(
      "Reload",
    );
    expect(errorMessage({ code: "native_unavailable" })).toContain(
      "lost its connection",
    );
  });
});
