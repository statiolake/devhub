/**
 * The terminal wire contract: attach, detach and their refusals.
 *
 * Ported from the Rust `terminal/contract.rs` tests. The fixture beside this
 * file is the one the Tauri app and its Rust counterpart were both checked
 * against, kept for the requests that are still DevHub's.
 */

import { describe, expect, it } from "vitest";
import fixture from "./terminal-v1.fixture.json" with { type: "json" };
import {
  MAX_SURFACE_KEY_BYTES,
  MAX_TARGET_GENERATION,
  TERMINAL_PROTOCOL_VERSION,
  validateAttachRequest,
  validateDetachRequest,
  validateSize,
  validateSurfaceKey,
} from "../../src/ipc/terminal";

const ATTACHMENT_ID = fixture.receipt.attachmentId;

describe("terminal request validation", () => {
  it("accepts exactly the surfaces DevHub has", () => {
    expect(
      validateSurfaceKey(
        "workspace-terminal:00000000-0000-4000-8000-00000000005c",
      ),
    ).toBe("workspace-terminal:00000000-0000-4000-8000-00000000005c");
    expect(
      validateSurfaceKey(
        "workspace-terminal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
    ).toBeTruthy();
    // An Agent is a tmux session like the other two, so its key is one this
    // channel answers about rather than a channel of its own.
    expect(
      validateSurfaceKey("agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ).toBeTruthy();
    for (const invalid of [
      "",
      "/var/folders/session",
      "workspace terminal",
      "workspace-terminal:not-a-uuid",
      "agent:not-a-uuid",
      "agent:",
      "workspace-terminal:00000000-0000-4000-8000-00000000005c\0",
      "x".repeat(MAX_SURFACE_KEY_BYTES + 1),
      42,
    ]) {
      expect(() => validateSurfaceKey(invalid)).toThrowError(
        expect.objectContaining({
          code: "invalid_surface",
        }) as unknown as Error,
      );
    }
  });

  it("bounds the grid", () => {
    expect(
      validateSize({ cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 }),
    ).toEqual({ cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 });
    for (const size of [
      { cols: 0, rows: 24, pixelWidth: 0, pixelHeight: 0 },
      { cols: 80, rows: 0, pixelWidth: 0, pixelHeight: 0 },
      { cols: 501, rows: 24, pixelWidth: 0, pixelHeight: 0 },
      { cols: 80, rows: 24, pixelWidth: 10_001, pixelHeight: 0 },
      { cols: 80.5, rows: 24, pixelWidth: 0, pixelHeight: 0 },
    ]) {
      expect(() => validateSize(size)).toThrowError(
        expect.objectContaining({ code: "invalid_resize" }) as unknown as Error,
      );
    }
  });

  it("takes the fixture's requests and refuses anything extra", () => {
    expect(validateAttachRequest(fixture.requests.attach).surfaceKey).toBe(
      "workspace-terminal:00000000-0000-4000-8000-00000000005c",
    );
    expect(validateDetachRequest(fixture.requests.detach).attachmentId).toBe(
      ATTACHMENT_ID,
    );
    expect(() =>
      validateAttachRequest({ ...fixture.requests.attach, extra: 1 }),
    ).toThrow();
    // Attach never names a generation: the capability is main's to allocate.
    expect(() =>
      validateAttachRequest({
        ...fixture.requests.attach,
        targetGeneration: 1,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_request" }) as unknown as Error,
    );
  });

  it("refuses a detach that does not name exactly one attachment", () => {
    const base = fixture.requests.detach;
    expect(fixture.protocolVersion).toBe(TERMINAL_PROTOCOL_VERSION);
    expect(() =>
      validateDetachRequest({ ...base, attachmentId: "short" }),
    ).toThrowError(
      expect.objectContaining({
        code: "wrong_attachment",
      }) as unknown as Error,
    );
    for (const targetGeneration of [0, MAX_TARGET_GENERATION + 1]) {
      expect(() =>
        validateDetachRequest({ ...base, targetGeneration }),
      ).toThrowError(
        expect.objectContaining({
          code: "wrong_attachment",
        }) as unknown as Error,
      );
    }
    expect(() => validateDetachRequest({ ...base, extra: 1 })).toThrow();
  });
});
