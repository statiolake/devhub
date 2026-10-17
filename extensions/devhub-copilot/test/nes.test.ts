import assert from "node:assert/strict";
import test from "node:test";
import { isRangeWithinDocument, rangeContainsPosition } from "../src/nesModel";
import { parseNextEditResponse } from "../src/nesProtocol";

test("parses NES candidates and preserves their acceptance command", () => {
  const parsed = parseNextEditResponse({
    edits: [
      {
        text: "replacement",
        textDocument: { uri: "file:///work/a.ts", version: 7 },
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 4 },
        },
        command: {
          title: "Accept inline edit",
          command: "github.copilot.didAcceptCompletionItem",
          arguments: ["candidate-1"],
        },
      },
    ],
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.suggestion.id, "candidate-1");
  assert.equal(parsed[0]!.suggestion.documentUri, "file:///work/a.ts");
  assert.equal(parsed[0]!.suggestion.documentVersion, 7);
  assert.deepEqual(parsed[0]!.suggestion.range, {
    start: { line: 2, character: 0 },
    end: { line: 2, character: 4 },
  });
  assert.equal(
    parsed[0]!.suggestion.acceptCommand?.command,
    "github.copilot.didAcceptCompletionItem",
  );
  assert.equal(parsed[0]!.raw.text, "replacement");
});

test("keeps multiple valid NES candidates and ignores malformed entries", () => {
  const parsed = parseNextEditResponse({
    edits: [
      {
        id: "insert",
        text: "text",
        textDocument: { uri: "file:///work/a.ts", version: 1 },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      },
      { text: "missing range" },
      {
        id: "delete",
        text: "",
        textDocument: { uri: "file:///work/a.ts", version: 1 },
        range: {
          start: { line: 3, character: 1 },
          end: { line: 4, character: 2 },
        },
      },
    ],
  });

  assert.deepEqual(
    parsed.map((entry) => entry.suggestion.id),
    ["insert", "delete"],
  );
  assert.equal(parsed[1]!.suggestion.newText, "");
});

test("validates ranges against UTF-16 line lengths", () => {
  const lineLengths = [4, 2];
  assert.equal(
    isRangeWithinDocument(
      {
        start: { line: 0, character: 1 },
        end: { line: 1, character: 2 },
      },
      lineLengths,
    ),
    true,
  );
  assert.equal(
    isRangeWithinDocument(
      {
        start: { line: 0, character: 5 },
        end: { line: 0, character: 5 },
      },
      lineLengths,
    ),
    false,
  );
  assert.equal(
    isRangeWithinDocument(
      {
        start: { line: 1, character: 2 },
        end: { line: 0, character: 2 },
      },
      lineLengths,
    ),
    false,
  );
});

test("detects whether the cursor is within a NES replacement range", () => {
  const range = {
    start: { line: 2, character: 3 },
    end: { line: 4, character: 1 },
  };
  assert.equal(rangeContainsPosition(range, { line: 2, character: 2 }), false);
  assert.equal(rangeContainsPosition(range, { line: 2, character: 3 }), true);
  assert.equal(rangeContainsPosition(range, { line: 3, character: 0 }), true);
  assert.equal(rangeContainsPosition(range, { line: 4, character: 1 }), true);
  assert.equal(rangeContainsPosition(range, { line: 4, character: 2 }), false);
});
