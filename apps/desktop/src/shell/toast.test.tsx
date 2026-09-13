// @vitest-environment jsdom

/**
 * Where the application says what is wrong with the application.
 *
 * One place: the toast stack, at the foot of the content area. What is tested
 * here is that it is one place — that a failure the application publishes is
 * drawn there, that the keyboard reaches it without the pointer, and that the
 * shared lifetime rule is the rule it goes by.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentProfiles,
  AppAppearance,
  AppError,
  AppSnapshot,
} from "../ipc/appShell";
import type { AppShellClient, RepositoryStatusWire } from "./client";
import { AppShellProvider } from "./AppShellContext";
import { Sidebar } from "./components/sidebar/Sidebar";
import { Toasts } from "./components/shell/Toasts";

const SNAPSHOT = {
  schemaVersion: 1,
  revision: 1,
  readiness: "ready",
  editorHost: { status: "ready" },
  layout: { kind: "unavailable" },
  selection: { context: { kind: "global" }, presentation: "full" },
  sidebar: { width: 248 },
  splitRatio: 0.55,
  workspaces: [
    {
      id: "w-1",
      label: "widget",
      location: { kind: "local" },
      root: "/projects/widget",
      key: "/projects/widget",
      selectedPath: "/projects/widget",
      state: { kind: "available" },
      close: { kind: "idle" },
      canCreateAgent: true,
      agents: [],
    },
  ],
} as unknown as AppSnapshot;

const APPEARANCE = { sequence: 1 } as unknown as AppAppearance;
const PROFILES = {
  sequence: 1,
  availability: "available",
  profiles: [],
} as unknown as AgentProfiles;

function status(sequence: number): RepositoryStatusWire {
  return { sequence, workspaces: [] };
}

let menuCommand: (command: string) => void = () => undefined;

function mount() {
  let publishError: (error: AppError) => void = () => undefined;
  window.devhub = {
    openModal: () => Promise.resolve(""),
    onMenuCommand: (listener: (command: string) => void) => {
      menuCommand = listener;
      return () => undefined;
    },
  } as unknown as typeof window.devhub;

  const client = {
    getSnapshot: async () => SNAPSHOT,
    getAppearance: async () => APPEARANCE,
    getAgentProfiles: async () => PROFILES,
    replay: async () => ({ cursor: 0, events: [], snapshot: SNAPSHOT }),
    dispatch: vi.fn(async () => ({ kind: "updated", snapshot: SNAPSHOT })),
    subscribe: () => () => undefined,
    subscribeAppearance: () => () => undefined,
    subscribeAgentProfiles: () => () => undefined,
    subscribeNativeError: (listener: (error: AppError) => void) => {
      publishError = listener;
      return () => undefined;
    },
    subscribeWorkspacePicker: () => () => undefined,
    getRepositoryStatus: async () => status(0),
    subscribeRepositoryStatus: () => () => undefined,
    startWorkspacePicker: async () => "",
    cancelWorkspacePicker: async () => undefined,
    selectWorkspacePicker: async () => ({}) as never,
    chooseWorkspaceFolder: async () => undefined,
    openSettings: async () => undefined,
    openExternalUrl: async () => undefined,
    setContentRect: async () => undefined,
    setContentSurface: async () => undefined,
    openModal: async () => "",
    closeModal: async () => undefined,
  } as unknown as AppShellClient;

  render(
    <AppShellProvider client={client}>
      <Sidebar snapshot={SNAPSHOT} onDispatch={vi.fn()} />
      <Toasts />
    </AppShellProvider>,
  );

  return {
    fail: (error: AppError) =>
      act(() => {
        publishError(error);
      }),
  };
}

const toasts = () => Array.from(document.querySelectorAll(".toast"));

describe("a failure the application published", () => {
  afterEach(cleanup);

  const failure: AppError = {
    code: "persistence_degraded",
    summary: "DevHub could not save its state file.",
    module: "state",
    timestampMs: 1,
    runtimeVersion: "test",
    actions: ["retry"],
    detail: "state.json: permission was denied (EACCES)",
  };

  it("is a toast, with what happened under what to do about it", () => {
    const { fail } = mount();
    fail(failure);
    const toast = screen.getByRole("alert");
    expect(toast).toHaveTextContent("could not save its state file");
    expect(toast).toHaveTextContent("permission was denied (EACCES)");
    expect(toast.closest(".sidebar")).toBeNull();
  });

  it("closes on Escape when the keyboard is on it", () => {
    const { fail } = mount();
    fail(failure);
    const toast = screen.getByRole("alert");
    act(() => {
      toast.focus();
      toast.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(toasts()).toHaveLength(0);
  });

  it("is what `Cmd+Q D` puts away", () => {
    const { fail } = mount();
    fail(failure);

    act(() => {
      menuCommand("dismiss_alert");
    });
    expect(toasts()).toHaveLength(0);
  });
});
