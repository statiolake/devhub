import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import type {
  AppEventCursor,
  AppIntent,
  AppOutcome,
  AppSnapshot,
} from "../generated/app-shell";
import type { AppShellClient } from "./client";
import {
  agentSnapshot,
  closingFailedSnapshot,
  globalSnapshot,
  unavailableSnapshot,
  workspaceSnapshot,
} from "../visual-fixtures/app-shell";

function client(snapshot: AppSnapshot): AppShellClient {
  return {
    getSnapshot: vi.fn().mockResolvedValue(snapshot),
    subscribe: vi.fn().mockResolvedValue(() => undefined),
    dispatch: vi.fn(async (intent: AppIntent): Promise<AppOutcome> => {
      if (intent.type === "resize_sidebar") {
        return {
          kind: "updated",
          snapshot: {
            ...snapshot,
            revision: snapshot.revision + 1,
            sidebar: { ...snapshot.sidebar, width: intent.width },
          },
        };
      }
      return { kind: "noop", snapshot };
    }),
  };
}

describe("App Shell navigation matrix", () => {
  it.each([
    [globalSnapshot, "Scratch", "Terminal", "global-terminal"],
    [workspaceSnapshot, "devhub", "Editor", "workspace-editor:workspace-1"],
    [agentSnapshot, "Codex 1", "Agent", "agent:agent-1"],
  ] as const)(
    "resolves %s context without adding a second navigation surface",
    async (snapshot, heading, activity, surfaceKey) => {
      render(<AppShell client={client(snapshot)} />);
      expect(
        await screen.findByRole("heading", { name: heading }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: activity })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("region", { name: "Surface" })).toHaveAttribute(
        "data-surface-key",
        surfaceKey,
      );
    },
  );

  it("has no disclosure, child, or placeholder affordance for a workspace without agents", async () => {
    render(<AppShell client={client(workspaceSnapshot)} />);
    await screen.findByRole("button", { name: "devhub workspace" });

    expect(
      screen.queryByRole("button", { name: /agents$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /agent, .*agent$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Create agent in devhub, unavailable",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Open workspace picker, unavailable",
      }),
    ).toBeDisabled();
  });

  it("keeps disclosure separate from Workspace selection", async () => {
    const appClient = client(agentSnapshot);
    render(<AppShell client={appClient} />);
    await screen.findByRole("button", { name: "devhub workspace" });

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse devhub agents" }),
    );
    await waitFor(() =>
      expect(appClient.dispatch).toHaveBeenCalledWith({
        type: "toggle_workspace_disclosure",
        workspaceId: "workspace-1",
        expanded: false,
      }),
    );
    expect(appClient.dispatch).not.toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "workspace", workspaceId: "workspace-1" },
    });

    fireEvent.click(screen.getByRole("button", { name: "devhub workspace" }));
    await waitFor(() =>
      expect(appClient.dispatch).toHaveBeenCalledWith({
        type: "select_context",
        context: { kind: "workspace", workspaceId: "workspace-1" },
      }),
    );
  });

  it("keeps Workspace and Agent order stable while status remains semantic", async () => {
    render(<AppShell client={client(agentSnapshot)} />);
    expect(
      await screen.findByRole("button", { name: /Codex 1/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Codex 1, Working agent" }),
    ).toHaveTextContent("Codex 1Connected");
    expect(
      screen.getByRole("button", { name: "Claude 1, Waiting agent" }),
    ).toHaveTextContent("Claude 1Connected");
    expect(screen.getAllByLabelText("Working")).not.toHaveLength(0);
    expect(screen.getAllByLabelText("Waiting")).not.toHaveLength(0);
  });

  it("disables exactly the Activity choices Rust resolves as disabled", async () => {
    render(<AppShell client={client(globalSnapshot)} />);
    await screen.findByRole("button", { name: "Scratch terminal" });
    expect(screen.getByRole("button", { name: "Editor" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "Agent (global agent not applicable), unavailable",
      }),
    ).toBeDisabled();
  });
});

describe("App Shell states and accessibility", () => {
  it("renders unavailable and closing-failed placeholders in the one Surface viewport", async () => {
    const unavailable = render(
      <AppShell client={client(unavailableSnapshot)} />,
    );
    expect(
      await screen.findByRole("heading", { name: "Workspace unavailable" }),
    ).toBeInTheDocument();
    unavailable.unmount();

    render(<AppShell client={client(closingFailedSnapshot)} />);
    expect(
      await screen.findByRole("heading", { name: "closing" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/could not be closed/i)).toBeInTheDocument();
  });

  it("keeps loading state explicit until the native snapshot arrives", async () => {
    let resolveSnapshot: (snapshot: AppSnapshot) => void = () => undefined;
    const appClient = client(globalSnapshot);
    vi.mocked(appClient.getSnapshot).mockImplementation(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );
    render(<AppShell client={appClient} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waking the local workbench",
    );
    await waitFor(() => expect(appClient.getSnapshot).toHaveBeenCalled());
    resolveSnapshot(globalSnapshot);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Scratch" }),
      ).toBeInTheDocument(),
    );
  });

  it("does not regress when an event wins the subscribe-before-query race", async () => {
    let onSnapshot: ((snapshot: AppSnapshot) => void) | undefined;
    let resolveSnapshot: (snapshot: AppSnapshot) => void = () => undefined;
    const appClient = client(globalSnapshot);
    vi.mocked(appClient.subscribe).mockImplementation(async (listener) => {
      onSnapshot = listener;
      return () => undefined;
    });
    vi.mocked(appClient.getSnapshot).mockImplementation(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );
    render(<AppShell client={appClient} />);
    await waitFor(() => expect(appClient.getSnapshot).toHaveBeenCalled());

    const newer = {
      ...globalSnapshot,
      revision: globalSnapshot.revision + 2,
      sidebar: { ...globalSnapshot.sidebar, width: 300 },
    };
    act(() => onSnapshot?.(newer));
    act(() => resolveSnapshot(globalSnapshot));

    await waitFor(() =>
      expect(
        screen.getByRole("separator", { name: "Resize sidebar" }),
      ).toHaveAttribute("aria-valuenow", "300"),
    );
  });

  it("resets from a history-gap replay without treating cursor as revision", async () => {
    const replaySnapshot = {
      ...globalSnapshot,
      revision: globalSnapshot.revision + 4,
      sidebar: { ...globalSnapshot.sidebar, width: 300 },
    };
    const appClient = client(globalSnapshot);
    const replay: AppEventCursor = {
      cursor: 42,
      historyGap: true,
      snapshot: replaySnapshot,
      events: [{ sequence: 41, kind: "noop" }],
    };
    appClient.replay = vi.fn().mockResolvedValue(replay);
    render(<AppShell client={appClient} />);

    await waitFor(() =>
      expect(
        screen.getByRole("separator", { name: "Resize sidebar" }),
      ).toHaveAttribute("aria-valuenow", "300"),
    );
    expect(appClient.replay).toHaveBeenCalledWith(0);
    expect(appClient.getSnapshot).toHaveBeenCalled();
  });

  it("keeps the newest dispatch response when concurrent responses resolve out of order", async () => {
    const appClient = client(globalSnapshot);
    const resolvers: Array<(outcome: AppOutcome) => void> = [];
    vi.mocked(appClient.dispatch).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    render(<AppShell client={appClient} />);
    await screen.findByRole("button", { name: "Scratch terminal" });
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    await waitFor(() => expect(resolvers).toHaveLength(2));

    resolvers[1]({
      kind: "updated",
      snapshot: {
        ...globalSnapshot,
        revision: globalSnapshot.revision + 2,
        sidebar: { ...globalSnapshot.sidebar, width: 256 },
      },
    });
    resolvers[0]({
      kind: "updated",
      snapshot: {
        ...globalSnapshot,
        revision: globalSnapshot.revision + 1,
        sidebar: { ...globalSnapshot.sidebar, width: 252 },
      },
    });

    await waitFor(() =>
      expect(
        screen.getByRole("separator", { name: "Resize sidebar" }),
      ).toHaveAttribute("aria-valuenow", "256"),
    );
  });

  it("keeps the active surface mounted when a native intent is rejected", async () => {
    const appClient = client(workspaceSnapshot);
    vi.mocked(appClient.dispatch).mockRejectedValue({
      code: "invalid_intent",
      summary: "picker unavailable",
    });
    render(<AppShell client={appClient} />);
    await screen.findByRole("heading", { name: "devhub" });
    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize sidebar" }),
      {
        key: "ArrowRight",
      },
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "picker unavailable",
    );
    expect(screen.getByRole("region", { name: "Surface" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "devhub" })).toBeInTheDocument();
  });

  it("renders persistence degradation as an inline intent alert", async () => {
    const appClient = client(workspaceSnapshot);
    let onSnapshot: ((snapshot: AppSnapshot) => void) | undefined;
    vi.mocked(appClient.subscribe).mockImplementation(async (listener) => {
      onSnapshot = listener;
      return () => undefined;
    });
    vi.mocked(appClient.dispatch).mockResolvedValue({
      kind: "persistence_degraded",
      snapshot: workspaceSnapshot,
    });
    render(<AppShell client={appClient} />);
    await screen.findByRole("heading", { name: "devhub" });

    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize sidebar" }),
      {
        key: "ArrowRight",
      },
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not be saved/i,
    );
    act(() => onSnapshot?.(workspaceSnapshot));
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/i);
    expect(screen.getByRole("region", { name: "Surface" })).toBeInTheDocument();
  });

  it("ignores a dispatch response from a previous client generation", async () => {
    const oldClient = client(globalSnapshot);
    const newSnapshot = {
      ...globalSnapshot,
      revision: globalSnapshot.revision + 1,
      sidebar: { ...globalSnapshot.sidebar, width: 300 },
    };
    const newClient = client(newSnapshot);
    let resolveOld: (outcome: AppOutcome) => void = () => undefined;
    vi.mocked(oldClient.dispatch).mockImplementation(
      () => new Promise((resolve) => (resolveOld = resolve)),
    );

    const view = render(<AppShell client={oldClient} />);
    await screen.findByRole("button", { name: "Scratch terminal" });
    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize sidebar" }),
      {
        key: "ArrowRight",
      },
    );
    await waitFor(() => expect(oldClient.dispatch).toHaveBeenCalled());

    view.rerender(<AppShell client={newClient} />);
    await waitFor(() => expect(newClient.getSnapshot).toHaveBeenCalled());

    await act(async () => {
      resolveOld({
        kind: "updated",
        snapshot: {
          ...globalSnapshot,
          revision: globalSnapshot.revision + 10,
          sidebar: { ...globalSnapshot.sidebar, width: 400 },
        },
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("separator", { name: "Resize sidebar" }),
      ).toHaveAttribute("aria-valuenow", "300"),
    );
  });

  it("ignores previous-generation get and event responses", async () => {
    const oldClient = client(globalSnapshot);
    const newSnapshot = {
      ...globalSnapshot,
      revision: globalSnapshot.revision + 1,
      sidebar: { ...globalSnapshot.sidebar, width: 300 },
    };
    const newClient = client(newSnapshot);
    let oldListener: ((snapshot: AppSnapshot) => void) | undefined;
    let resolveOld: (snapshot: AppSnapshot) => void = () => undefined;
    vi.mocked(oldClient.subscribe).mockImplementation(async (listener) => {
      oldListener = listener;
      return () => undefined;
    });
    vi.mocked(oldClient.getSnapshot).mockImplementation(
      () => new Promise((resolve) => (resolveOld = resolve)),
    );

    const view = render(<AppShell client={oldClient} />);
    await waitFor(() => expect(oldClient.getSnapshot).toHaveBeenCalled());

    view.rerender(<AppShell client={newClient} />);
    await waitFor(() => expect(newClient.getSnapshot).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByRole("separator", { name: "Resize sidebar" }),
      ).toHaveAttribute("aria-valuenow", "300"),
    );

    await act(async () => {
      oldListener?.({
        ...globalSnapshot,
        revision: globalSnapshot.revision + 10,
        sidebar: { ...globalSnapshot.sidebar, width: 400 },
      });
      resolveOld({
        ...globalSnapshot,
        revision: globalSnapshot.revision + 11,
        sidebar: { ...globalSnapshot.sidebar, width: 400 },
      });
      await Promise.resolve();
    });

    expect(
      screen.getByRole("separator", { name: "Resize sidebar" }),
    ).toHaveAttribute("aria-valuenow", "300");
  });

  it("exposes keyboard focus and bounded sidebar resizing semantics", async () => {
    const appClient = client(globalSnapshot);
    render(<AppShell client={appClient} />);
    await screen.findByRole("button", { name: "Scratch terminal" });
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(separator).toHaveAttribute("aria-valuemin", "200");
    expect(separator).toHaveAttribute("aria-valuemax", "400");
    expect(separator).toHaveAttribute("aria-valuenow", "248");
    separator.focus();
    expect(separator).toHaveFocus();
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    await waitFor(() =>
      expect(appClient.dispatch).toHaveBeenCalledWith({
        type: "resize_sidebar",
        width: 252,
      }),
    );
  });
});
