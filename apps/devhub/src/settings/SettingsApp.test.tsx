import validFixtures from "../../../../contracts/settings/valid.json";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  parseSettingsSnapshot,
  type SettingsSnapshot,
} from "../generated/settings";
import { SettingsApp } from "./SettingsApp";
import type { SettingsClient } from "./client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function makeClient(initialSnapshot?: SettingsSnapshot) {
  const snapshot =
    initialSnapshot ??
    (parseSettingsSnapshot(validFixtures[0]) as SettingsSnapshot);
  let listener: ((next: SettingsSnapshot) => void) | undefined;
  const client: SettingsClient = {
    getSnapshot: vi.fn(async () => snapshot),
    save: vi.fn(async () => snapshot),
    reload: vi.fn(async () => snapshot),
    recheck: vi.fn(async () => snapshot),
    openLogFolder: vi.fn(async () => undefined),
    applySocketChange: vi.fn(async () => snapshot),
    subscribe: vi.fn(async (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    }),
  };
  return {
    client,
    snapshot,
    emit: (next: SettingsSnapshot) => listener?.(next),
  };
}

describe("SettingsApp", () => {
  it("renders the five native Settings sections and keeps a local dirty draft", async () => {
    const { client } = makeClient();
    render(<SettingsApp client={client} />);

    expect(
      await screen.findByRole("heading", { name: "General" }),
    ).toBeVisible();
    for (const section of [
      "General",
      "Workspaces",
      "Agents",
      "Runtimes",
      "Appearance",
    ]) {
      expect(screen.getByRole("button", { name: section })).toBeVisible();
    }

    fireEvent.click(screen.getByLabelText("Import login environment"));
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("preserves a dirty draft when a watcher reports an external edit", async () => {
    const { client, snapshot, emit } = makeClient();
    render(<SettingsApp client={client} />);
    await screen.findByRole("heading", { name: "General" });
    fireEvent.click(screen.getByLabelText("Import login environment"));

    act(() => {
      emit({
        ...snapshot,
        revision: "f".repeat(64),
        config: {
          ...snapshot.config,
          general: { importLoginEnvironment: true },
        },
      });
    });
    await waitFor(() =>
      expect(
        screen.getByText(/configuration changed outside Settings/),
      ).toBeVisible(),
    );
    expect(screen.getByText("Unsaved changes")).toBeVisible();
  });

  it("shows honest unavailable runtime inspection and keeps socket Apply disabled", async () => {
    const { client } = makeClient();
    render(<SettingsApp client={client} />);
    await screen.findByRole("heading", { name: "General" });
    fireEvent.click(screen.getByRole("button", { name: "Runtimes" }));
    expect(await screen.findByText(/inspection is unavailable/)).toBeVisible();
    expect(screen.getByText("Scratch sessions")).toBeVisible();
    expect(screen.getByText("Workspace sessions")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Apply socket change" }),
    ).toBeDisabled();
  });

  it("enables the initial Apply when configured and effective sockets differ", async () => {
    const base = parseSettingsSnapshot(validFixtures[0]) as SettingsSnapshot;
    const snapshot: SettingsSnapshot = {
      ...base,
      runtime: {
        ...base.runtime,
        health: {
          ...base.runtime.health,
          inspectionAvailable: true,
          tmux: "healthy",
        },
        socketChange: {
          ...base.runtime.socketChange,
          state: "stable",
          configuredSocketName: "devhub-next",
          effectiveSocketName: "devhub-current",
          requestedSocketName: null,
          targetPreflight: "not_checked",
          confirmationRequired: false,
          adapterAvailable: true,
        },
      },
    };
    const { client } = makeClient(snapshot);
    render(<SettingsApp client={client} />);
    await screen.findByRole("heading", { name: "General" });
    fireEvent.click(screen.getByRole("button", { name: "Runtimes" }));

    const apply = screen.getByRole("button", { name: "Apply socket change" });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    await waitFor(() =>
      expect(client.applySocketChange).toHaveBeenCalledOnce(),
    );
    expect(client.applySocketChange).toHaveBeenCalledWith({
      schemaVersion: 1,
      revision: snapshot.revision,
      sequence: snapshot.sequence,
      confirmed: false,
    });
  });

  it("uses a fresh sequence cursor for the confirmation round trip", async () => {
    const base = parseSettingsSnapshot(validFixtures[0]) as SettingsSnapshot;
    const pending: SettingsSnapshot = {
      ...base,
      sequence: 5,
      runtime: {
        ...base.runtime,
        socketChange: {
          ...base.runtime.socketChange,
          state: "pending",
          configuredSocketName: "new-socket",
          effectiveSocketName: "old-socket",
          requestedSocketName: "new-socket",
          targetPreflight: "target_absent",
          scratchSessionCount: 2,
          workspaceSessionCount: 1,
          confirmationRequired: true,
          adapterAvailable: true,
        },
      },
    };
    const prepared = { ...pending, sequence: 6 };
    const completed: SettingsSnapshot = {
      ...prepared,
      sequence: 7,
      runtime: {
        ...prepared.runtime,
        socketChange: {
          ...prepared.runtime.socketChange,
          state: "stable",
          effectiveSocketName: "new-socket",
          requestedSocketName: null,
          targetPreflight: "not_checked",
          scratchSessionCount: 0,
          workspaceSessionCount: 0,
          confirmationRequired: false,
        },
      },
    };
    const { client } = makeClient(pending);
    client.applySocketChange = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(completed);
    render(<SettingsApp client={client} />);
    await screen.findByRole("heading", { name: "General" });
    fireEvent.click(screen.getByRole("button", { name: "Runtimes" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Apply socket change" }),
    );
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(client.applySocketChange).toHaveBeenCalledTimes(2),
    );
    expect(client.applySocketChange).toHaveBeenNthCalledWith(1, {
      schemaVersion: 1,
      revision: pending.revision,
      sequence: pending.sequence,
      confirmed: false,
    });
    expect(client.applySocketChange).toHaveBeenNthCalledWith(2, {
      schemaVersion: 1,
      revision: prepared.revision,
      sequence: prepared.sequence,
      confirmed: true,
    });
  });

  it("preserves argv values exactly and exposes CRUD/accessibility controls", async () => {
    const { client } = makeClient();
    render(<SettingsApp client={client} />);
    await screen.findByRole("heading", { name: "General" });

    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    const addArgumentButtons = screen.getAllByRole("button", {
      name: "Add argument",
    });
    expect(addArgumentButtons[0]).toBeVisible();
    fireEvent.click(addArgumentButtons[0]);
    const argument = screen.getByLabelText("Arguments argument 1");
    fireEvent.change(argument, { target: { value: "--message hello,world" } });
    expect(argument).toHaveValue("--message hello,world");
    expect(
      screen.getAllByRole("button", { name: "Remove profile" }).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
    expect(screen.getAllByLabelText("Workspace root path")[0]).toBeVisible();
    const excludedName = screen.getAllByLabelText(
      "Excluded names argument 1",
    )[0];
    fireEvent.change(excludedName, { target: { value: "name,with,commas" } });
    expect(excludedName).toHaveValue("name,with,commas");
    expect(
      screen.getAllByRole("button", { name: "Add excluded names argument" }),
    ).not.toHaveLength(0);
    expect(
      screen.getAllByRole("button", { name: "Remove source" }).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(
      screen.queryByRole("option", { name: /Dark/ }),
    ).not.toBeInTheDocument();
  });

  it("ignores an out-of-order lower sequence event after a newer projection", async () => {
    const { client, snapshot, emit } = makeClient();
    render(<SettingsApp client={client} />);
    await screen.findByRole("heading", { name: "General" });

    act(() => {
      emit({
        ...snapshot,
        sequence: snapshot.sequence + 1,
        config: {
          ...snapshot.config,
          general: { importLoginEnvironment: false },
        },
      });
      emit(snapshot);
    });
    expect(screen.getByLabelText("Import login environment")).not.toBeChecked();
  });

  it("keeps errors and diagnostics inside one explicit notice band", async () => {
    const base = parseSettingsSnapshot(validFixtures[0]) as SettingsSnapshot;
    const { client } = makeClient({
      ...base,
      diagnostic: {
        code: "invalid_appearance",
        path: "appearance.terminalFontSize",
        line: 12,
        column: 7,
      },
    });
    client.save = vi.fn(async () => {
      throw { code: "external_edit_conflict", currentRevision: "f".repeat(64) };
    });
    render(<SettingsApp client={client} />);
    await screen.findByRole("heading", { name: "General" });

    fireEvent.click(screen.getByLabelText("Import login environment"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/configuration changed outside Settings/);

    const window = document.querySelector(".settings-window");
    expect(window).not.toBeNull();
    expect(
      Array.from(window!.children).map((child) => child.className),
    ).toEqual(["settings-header", "settings-notices", "settings-body"]);
    const notices = window!.querySelector(".settings-notices");
    expect(notices?.querySelector(".settings-error")).toBeInTheDocument();
    expect(notices?.querySelector(".settings-diagnostic")).toBeInTheDocument();
  });

  it("keeps the production default client stable across draft rerenders", async () => {
    const snapshot = parseSettingsSnapshot(
      validFixtures[0],
    ) as SettingsSnapshot;
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(invoke).mockImplementation(async () => snapshot);

    render(<SettingsApp />);
    await screen.findByRole("heading", { name: "General" });
    fireEvent.click(screen.getByLabelText("Import login environment"));

    await waitFor(() => {
      expect(vi.mocked(listen)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    });
  });
});
