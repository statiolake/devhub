import assert from "node:assert/strict";
import test from "node:test";
import { statusOf } from "../src/status";

const ready = { enabled: true, signingIn: false, ready: true };

test("a running, signed-in server is ready", () => {
  assert.equal(statusOf(ready).kind, "ready");
});

test("turned off wins over everything the server says", () => {
  assert.equal(
    statusOf({
      ...ready,
      enabled: false,
      server: { busy: true, kind: "Error", message: "x" },
    }).kind,
    "off",
  );
});

test("an error about signing in is told apart from any other", () => {
  const signedOut = statusOf({
    ...ready,
    server: {
      busy: false,
      kind: "Error",
      message: "You are not signed into GitHub.",
    },
  });
  assert.equal(signedOut.kind, "signedOut");
  assert.match(signedOut.summary, /Not signed in/u);
  assert.equal(
    statusOf({
      ...ready,
      server: { busy: false, kind: "Warning", message: "Network unreachable" },
    }).kind,
    "error",
  );
});

test("a server that is not running is an error even if it last said Normal", () => {
  assert.equal(
    statusOf({
      ...ready,
      ready: false,
      server: { busy: false, kind: "Normal", message: "" },
    }).kind,
    "error",
  );
});
