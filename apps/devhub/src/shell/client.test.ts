import { describe, expect, it, vi } from "vitest";
import appShellCapability from "../../src-tauri/capabilities/app-shell.json";
import shellSnapshotFixture from "../../../../contracts/shell-snapshot.v1.json";
import {
  GET_SHELL_SNAPSHOT_COMMAND,
  MARK_SHELL_READY_COMMAND,
  SHELL_SNAPSHOT_CHANGED_EVENT,
  createTauriShellClient,
  parseShellSnapshot,
} from "./client";

const payload = {
  schemaVersion: 1,
  revision: 0,
  productName: "DevHub",
  platform: "macos",
  windowLabel: "app-shell",
  readiness: "starting",
} as const;

const fixture = shellSnapshotFixture as {
  starting: typeof payload;
  ready: typeof payload;
};

describe("Tauri shell client", () => {
  it("uses the narrow query and lifecycle commands", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce({ ...payload, revision: 1, readiness: "ready" });
    const client = createTauriShellClient({ invoke, listen: vi.fn() });

    expect(await client.getSnapshot()).toEqual(payload);
    expect(await client.markReady()).toEqual({
      ...payload,
      revision: 1,
      readiness: "ready",
    });
    expect(invoke).toHaveBeenNthCalledWith(1, GET_SHELL_SNAPSHOT_COMMAND);
    expect(invoke).toHaveBeenNthCalledWith(2, MARK_SHELL_READY_COMMAND);
  });

  it("validates and freezes the Rust payload", () => {
    const snapshot = parseShellSnapshot(payload);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.schemaVersion).toBe(1);
    expect(() => parseShellSnapshot({ ...payload, schemaVersion: 2 })).toThrow(
      "invalid snapshot",
    );
    expect(() =>
      parseShellSnapshot({ ...payload, readiness: "unknown" }),
    ).toThrow("invalid snapshot");
  });

  it("consumes the canonical fixture shared with the Rust owner", () => {
    expect(parseShellSnapshot(fixture.starting)).toEqual(fixture.starting);
    expect(parseShellSnapshot(fixture.ready)).toEqual(fixture.ready);
  });

  it("keeps native IPC on the App Shell webview only", () => {
    expect(
      Object.prototype.hasOwnProperty.call(appShellCapability, "windows"),
    ).toBe(false);
    expect(appShellCapability.webviews).toEqual(["app-shell"]);
    expect(appShellCapability.permissions).toEqual([
      "core:default",
      "allow-get-shell-snapshot",
      "allow-mark-shell-ready",
    ]);
  });

  it("subscribes to the Rust snapshot event through the injected transport", async () => {
    const listener = vi.fn();
    const unlisten = vi.fn();
    const listen = vi
      .fn()
      .mockImplementation(
        async (
          _event: string,
          callback: (event: { payload: unknown }) => void,
        ) => {
          callback({
            payload: { ...payload, readiness: "ready", revision: 1 },
          });
          return unlisten;
        },
      );
    const client = createTauriShellClient({ invoke: vi.fn(), listen });

    const cleanup = await client.subscribe(listener);

    expect(listen).toHaveBeenCalledWith(
      SHELL_SNAPSHOT_CHANGED_EVENT,
      expect.any(Function),
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ readiness: "ready" }),
    );
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
