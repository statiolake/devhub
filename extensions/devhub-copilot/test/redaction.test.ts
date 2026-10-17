import assert from "node:assert/strict";
import test from "node:test";
import { redactLogMessage, redactSecrets } from "../src/redaction";

test("redacts sensitive object keys and bearer/token strings", () => {
  const value = redactSecrets({
    accessToken: "do-not-log",
    nested: { password: "also-secret" },
    message: "Bearer abc.def.ghi ghp_123456",
    visible: "normal text",
  }) as Record<string, unknown>;

  assert.equal(value.accessToken, "[REDACTED]");
  assert.deepEqual(value.nested, { password: "[REDACTED]" });
  assert.equal(value.message, "Bearer [REDACTED] [REDACTED]");
  assert.equal(value.visible, "normal text");
});

test("redacts token-like values in plain log messages", () => {
  assert.equal(
    redactLogMessage("Authorization: Bearer secret-value"),
    "Authorization: Bearer [REDACTED]",
  );
});
