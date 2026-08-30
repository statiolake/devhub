import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNavigationUri } from "../src/navigation";

const scheme = "vscode";

test("navigation accepts the product URI scheme and strictly decodes roots", () => {
  assert.deepEqual(
    parseNavigationUri(
      {
        scheme,
        path: "/open-workspace",
        query: "path=%2FUsers%2Ftestuser%2Fproject",
      },
      scheme,
    ),
    { kind: "open_workspace", path: "/Users/testuser/project" },
  );
  assert.deepEqual(
    parseNavigationUri({ scheme, path: "/new-window", query: "" }, scheme),
    { kind: "new_window", path: null },
  );
});

test("navigation rejects scheme mismatch, malformed paths, and unknown query fields", () => {
  assert.equal(
    parseNavigationUri(
      { scheme: "devhub", path: "/open-workspace", query: "path=%2Fwork" },
      scheme,
    ),
    null,
  );
  assert.equal(
    parseNavigationUri(
      {
        scheme,
        path: "/open-workspace",
        query: "path=%2Fwork%2F..%2Fother",
      },
      scheme,
    ),
    null,
  );
  assert.equal(
    parseNavigationUri(
      {
        scheme,
        path: "/new-window",
        query: "path=%2Fwork&unexpected=1",
      },
      scheme,
    ),
    null,
  );
  assert.equal(
    parseNavigationUri(
      { scheme, path: "/open-workspace", query: "path=%E0%A4%A" },
      scheme,
    ),
    null,
  );
  assert.equal(
    parseNavigationUri(
      { scheme: "vscode-insiders", path: "/new-window", query: "" },
      scheme,
    ),
    null,
  );
});
