import assert from "node:assert/strict";
import test from "node:test";
import {
  isCurrentDocument,
  isCurrentDocumentVersion,
  isValidLspPosition,
  normalizeNewlines,
  utf16Length,
} from "../src/protocol";

test("normalizes all newline forms to the document EOL", () => {
  assert.equal(normalizeNewlines("a\r\nb\rc\nd", "\n"), "a\nb\nc\nd");
  assert.equal(normalizeNewlines("a\r\nb\rc\nd", "\r\n"), "a\r\nb\r\nc\r\nd");
});

test("validates document identity and version", () => {
  assert.equal(isCurrentDocumentVersion(4, 4), true);
  assert.equal(isCurrentDocumentVersion(4, 5), false);
  assert.equal(isCurrentDocument("file:///a.ts", 4, "file:///a.ts", 4), true);
  assert.equal(isCurrentDocument("file:///a.ts", 4, "file:///b.ts", 4), false);
  assert.equal(isCurrentDocument("file:///a.ts", 4, "file:///a.ts", 5), false);
});

test("counts UTF-16 code units as LSP characters", () => {
  assert.equal(utf16Length("abc"), 3);
  assert.equal(utf16Length("a😀b"), 4);
});

test("rejects negative and non-integer LSP positions", () => {
  assert.equal(isValidLspPosition({ line: 0, character: 0 }), true);
  assert.equal(isValidLspPosition({ line: -1, character: 0 }), false);
  assert.equal(isValidLspPosition({ line: 0, character: 1.5 }), false);
});
