import validFixtureText from "../../../../../contracts/bridge/valid.ndjson?raw";
import invalidFixtureText from "../../../../../contracts/bridge/invalid.ndjson?raw";
import { describe, expect, it } from "vitest";
import { parseEnvelope } from "./index";

describe("generated Bridge v1 contract", () => {
  it("decodes every Rust-owned valid fixture", () => {
    for (const line of validFixtureText.trim().split("\n")) {
      expect(() => parseEnvelope(line)).not.toThrow();
    }
  });

  it("rejects every Rust-owned invalid fixture", () => {
    for (const [index, line] of invalidFixtureText
      .trim()
      .split("\n")
      .entries()) {
      expect(
        () => parseEnvelope(line),
        `invalid fixture ${index + 1}`,
      ).toThrow();
    }
  });
});
