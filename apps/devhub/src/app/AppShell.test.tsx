import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { appearanceFixture } from "../test/appearance";
import type {
  AppAppearance,
  AppEventCursor,
  AppIntent,
  AppOutcome,
  AppSnapshot,
  AgentProfiles,
  DisabledReasonWire,
} from "../generated/app-shell";
import type { AppShellClient, WorkspacePickerEvent } from "./client";
import {
  agentSnapshot,
  closingFailedSnapshot,
  globalSnapshot,
  unavailableSnapshot,
  workspaceSnapshot,
} from "../visual-fixtures/app-shell";
import { disabledReasonCopy } from "../components/shell/activityPresentation";

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
  it("opens the enabled profile picker and dispatches the selected profile", async () => {
    const appClient = client(workspaceSnapshot);
    const profiles: AgentProfiles = {
      sequence: 2,
      availability: "available",
      profiles: [
        { id: "codex", displayName: "Codex Default", kind: "codex" },
        { id: "claude", displayName: "Claude Review", kind: "claude" },
      ],
    };
    appClient.getAgentProfiles = vi.fn().mockResolvedValue(profiles);
    appClient.subscribeAgentProfiles = vi
      .fn()
      .mockResolvedValue(() => undefined);
    render(<AppShell client={appClient} />);

    const create = await screen.findByRole("button", {
      name: "Create agent in devhub",
    });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(
      await screen.findByRole("dialog", { name: "New Agent" }),
    ).toBeInTheDocument();
    expect(document.activeElement).toHaveTextContent("Codex Default");
    fireEvent.click(screen.getByRole("button", { name: /Claude Review/ }));

    await waitFor(() =>
      expect(appClient.dispatch).toHaveBeenCalledWith({
        type: "request_create_agent",
        workspaceId: "workspace-1",
        profileId: "claude",
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "New Agent" }),
    ).not.toBeInTheDocument();
  });

  it("does not let a profile subscription failure hide a successful query", async () => {
    const appClient = client(workspaceSnapshot);
    const profiles: AgentProfiles = {
      sequence: 1,
      availability: "available",
      profiles: [{ id: "codex", displayName: "Codex", kind: "codex" }],
    };
    appClient.subscribeAgentProfiles = vi
      .fn()
      .mockRejectedValue(new Error("profile event unavailable"));
    appClient.getAgentProfiles = vi.fn().mockResolvedValue(profiles);
    render(<AppShell client={appClient} />);

    expect(
      await screen.findByRole("button", { name: "Create agent in devhub" }),
    ).toBeEnabled();
  });

  it.each([
    [globalSnapshot, "Scratch", "Terminal", "global-terminal"],
    [workspaceSnapshot, "devhub", "Editor", "workspace-editor:workspace-1"],
    [agentSnapshot, "Codex 1", "Agent", "agent:agent-1"],
  ] as const)(
    "resolves %s context without adding a second navigation surface",
    async (snapshot, heading, activity, surfaceKey) => {
      render(<AppShell client={client(snapshot)} />);
      // The Sidebar is the only place that names the context; neither the
      // titlebar nor the Surface repeats it.
      const navigation = await screen.findByRole("complementary", {
        name: "Workspace navigation",
      });
      expect(
        within(navigation).getByRole("button", { current: "page" }),
      ).toHaveAccessibleName(new RegExp(heading));
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
    await screen.findByRole("button", { name: /devhub workspace/ });

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
      screen.getByRole("button", { name: "Open workspace picker" }),
    ).toBeEnabled();
  });

  it("keeps disclosure separate from Workspace selection", async () => {
    const appClient = client(agentSnapshot);
    render(<AppShell client={appClient} />);
    await screen.findByRole("button", { name: /devhub workspace/ });

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

    fireEvent.click(screen.getByRole("button", { name: /devhub workspace/ }));
    await waitFor(() =>
      expect(appClient.dispatch).toHaveBeenCalledWith({
        type: "select_context",
        context: { kind: "workspace", workspaceId: "workspace-1" },
      }),
    );
  });

  it("provides roving tree navigation without hijacking row actions", async () => {
    render(<AppShell client={client(agentSnapshot)} />);
    const workspace = await screen.findByRole("button", {
      name: /devhub workspace/,
    });
    const agents = screen.getAllByRole("button", { name: /agent,/i });
    expect(agents).toHaveLength(2);

    workspace.focus();
    fireEvent.keyDown(workspace, { key: "ArrowRight" });
    expect(document.activeElement).toBe(agents[0]);
    fireEvent.keyDown(agents[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(agents[1]);
    fireEvent.keyDown(agents[1], { key: "Home" });
    expect(document.activeElement).toBe(workspace);
    fireEvent.keyDown(workspace, { key: "End" });
    expect(document.activeElement).toBe(agents[1]);
    fireEvent.keyDown(agents[1], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(workspace);
  });

  it("prevents rename submission while Japanese IME is composing", async () => {
    render(<AppShell client={client(agentSnapshot)} />);
    const renameButtons = await screen.findAllByRole("button", {
      name: "Rename agent",
    });
    fireEvent.click(renameButtons[0]);
    const input = await screen.findByRole("textbox", { name: "Display name" });
    fireEvent.compositionStart(input);
    const enter = createEvent.keyDown(input, {
      key: "Enter",
      isComposing: true,
    });
    fireEvent(input, enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(
      screen.getByRole("dialog", { name: "Rename Agent" }),
    ).toBeInTheDocument();
    fireEvent.compositionEnd(input);
  });

  it("keeps Workspace and Agent order stable while status remains semantic", async () => {
    render(<AppShell client={client(agentSnapshot)} />);
    expect(
      await screen.findByRole("button", { name: /Codex 1/ }),
    ).toBeInTheDocument();
    // A healthy row shows only its name; runtime state stays in the
    // accessible name and in the status mark, and surfaces as visible text
    // only when it needs attention.
    expect(
      screen.getByRole("button", {
        name: "Codex 1, Working agent, Connected",
      }),
    ).toHaveTextContent("Codex 1");
    expect(
      screen.getByRole("button", {
        name: "Claude 1, Waiting agent, Connected",
      }),
    ).toHaveTextContent("Claude 1");
    expect(screen.getAllByLabelText("Working")).not.toHaveLength(0);
    expect(screen.getAllByLabelText("Waiting")).not.toHaveLength(0);
  });

  it("requires one typed confirmation before stopping an Agent and keeps focus in the dialog", async () => {
    const appClient = client(agentSnapshot);
    vi.mocked(appClient.dispatch).mockImplementation(
      async (intent: AppIntent): Promise<AppOutcome> => {
        if (intent.type === "stop_agent") {
          return {
            kind: "confirmation_required",
            confirmationId: "confirmation-agent-1",
            snapshot: agentSnapshot,
            purpose: { kind: "agent_stop" },
          };
        }
        return {
          kind: "deferred",
          operationId: "stop-op",
          snapshot: agentSnapshot,
        };
      },
    );
    render(<AppShell client={appClient} />);
    const stop = (
      await screen.findAllByRole("button", { name: "Stop agent" })
    )[0];
    fireEvent.click(stop);

    const dialog = await screen.findByRole("dialog", { name: "Stop Codex 1?" });
    expect(dialog).toHaveTextContent("This stops the Agent runtime");
    await waitFor(() =>
      expect(document.activeElement).toHaveTextContent("Cancel"),
    );
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toHaveTextContent("Stop Agent");
    fireEvent.click(screen.getByRole("button", { name: "Stop Agent" }));
    await waitFor(() =>
      expect(appClient.dispatch).toHaveBeenLastCalledWith({
        type: "confirm_stop_agent",
        confirmationId: "confirmation-agent-1",
      }),
    );
  });

  it("submits a confirmation once, disables actions in flight, and restores retry after completion", async () => {
    const appClient = client(agentSnapshot);
    let resolveConfirm: ((outcome: AppOutcome) => void) | undefined;
    vi.mocked(appClient.dispatch).mockImplementation(
      (intent: AppIntent): Promise<AppOutcome> => {
        if (intent.type === "stop_agent") {
          return Promise.resolve({
            kind: "confirmation_required",
            confirmationId: "confirmation-agent-1",
            snapshot: agentSnapshot,
            purpose: { kind: "agent_stop" },
          });
        }
        if (intent.type === "confirm_stop_agent") {
          return new Promise((resolve) => {
            resolveConfirm = resolve;
          });
        }
        return Promise.resolve({ kind: "noop", snapshot: agentSnapshot });
      },
    );
    render(<AppShell client={appClient} />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Stop agent" }))[0],
    );
    const submit = await screen.findByRole("button", { name: "Stop Agent" });

    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(
        vi
          .mocked(appClient.dispatch)
          .mock.calls.filter(
            ([intent]) => intent.type === "confirm_stop_agent",
          ),
      ).toHaveLength(1),
    );
    expect(submit).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    if (!resolveConfirm) throw new Error("confirmation did not start");
    await act(async () => {
      resolveConfirm?.({
        kind: "deferred",
        operationId: "stop-op",
        snapshot: agentSnapshot,
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Stop Codex 1?" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps confirmation retryable after a submission error", async () => {
    const appClient = client(agentSnapshot);
    let attempts = 0;
    vi.mocked(appClient.dispatch).mockImplementation(
      async (intent: AppIntent): Promise<AppOutcome> => {
        if (intent.type === "stop_agent") {
          return {
            kind: "confirmation_required",
            confirmationId: "confirmation-agent-1",
            snapshot: agentSnapshot,
            purpose: { kind: "agent_stop" },
          };
        }
        if (intent.type === "confirm_stop_agent" && attempts++ === 0) {
          throw new Error("temporary native failure");
        }
        return {
          kind: "deferred",
          operationId: "stop-op",
          snapshot: agentSnapshot,
        };
      },
    );
    render(<AppShell client={appClient} />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Stop agent" }))[0],
    );
    const submit = await screen.findByRole("button", { name: "Stop Agent" });
    fireEvent.click(submit);
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() =>
      expect(
        vi
          .mocked(appClient.dispatch)
          .mock.calls.filter(
            ([intent]) => intent.type === "confirm_stop_agent",
          ),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Stop Codex 1?" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps a native replacement confirmation visible with its original Agent", async () => {
    const appClient = client(agentSnapshot);
    vi.mocked(appClient.dispatch).mockImplementation(
      async (intent: AppIntent): Promise<AppOutcome> => {
        if (intent.type === "stop_agent") {
          return {
            kind: "confirmation_required",
            confirmationId: "confirmation-agent-1",
            snapshot: agentSnapshot,
            purpose: { kind: "agent_stop" },
          };
        }
        return {
          kind: "confirmation_required",
          confirmationId: "confirmation-agent-replacement",
          snapshot: agentSnapshot,
          purpose: { kind: "agent_stop" },
        };
      },
    );
    render(<AppShell client={appClient} />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Stop agent" }))[0],
    );
    fireEvent.click(await screen.findByRole("button", { name: "Stop Agent" }));
    expect(
      await screen.findByRole("dialog", { name: "Stop Codex 1?" }),
    ).toBeInTheDocument();
    expect(
      vi
        .mocked(appClient.dispatch)
        .mock.calls.filter(([intent]) => intent.type === "confirm_stop_agent"),
    ).toHaveLength(1);
  });

  it("disables exactly the Activity choices Rust resolves as disabled", async () => {
    render(<AppShell client={client(globalSnapshot)} />);
    await screen.findByRole("button", { name: "Scratch terminal" });
    expect(screen.getByRole("button", { name: "Editor" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: `Agent (${disabledReasonCopy["global-agent-not-applicable"]}), unavailable`,
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
      await screen.findByText(/workspace is unavailable/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Locate…" })).toBeInTheDocument();
    unavailable.unmount();

    render(<AppShell client={client(closingFailedSnapshot)} />);
    expect(await screen.findByText(/could not be closed/i)).toBeInTheDocument();
  });

  it("shows why the editor could not start, from the attempt that failed", async () => {
    // The failure is the server refusing to come up, which is known only to
    // the call that asked it to — not to a projection assembled beforehand.
    const appClient = client(workspaceSnapshot);
    // A rejected invoke arrives as the native error wire, never as an `Error`.
    appClient.ensureEditorRemote = vi.fn().mockRejectedValue({
      code: "editor_port_unavailable",
      summary: "The editor could not start.",
      detail: "127.0.0.1:55971 is already in use",
      module: "editor",
      timestampMs: 0,
      runtimeVersion: "test",
      actions: ["retry"],
    });
    render(<AppShell client={appClient} />);
    expect(await screen.findByText(/already in use/i)).toBeInTheDocument();
    // The placeholder that always claimed the editor was on its way is gone.
    expect(screen.queryByText(/appears here once/i)).not.toBeInTheDocument();
  });

  it("shows a starting state while the editor is coming up", async () => {
    // Nothing resolves until the server is running, and the Workbench cannot
    // be drawn before it does.
    const appClient = client(workspaceSnapshot);
    appClient.ensureEditorRemote = vi
      .fn()
      .mockReturnValue(new Promise(() => {}));
    render(<AppShell client={appClient} />);
    expect(
      await screen.findByText("Starting the editor server…"),
    ).toBeInTheDocument();
  });

  it.each(Object.keys(disabledReasonCopy) as DisabledReasonWire[])(
    "renders friendly copy for disabled Surface reason %s",
    async (reason) => {
      const snapshot: AppSnapshot = {
        ...workspaceSnapshot,
        selection: { ...workspaceSnapshot.selection, activity: "agent" },
        activities: workspaceSnapshot.activities.map((activity) =>
          activity.activity === "agent"
            ? { activity: "agent", resolution: { kind: "disabled", reason } }
            : activity,
        ),
      };
      const view = render(<AppShell client={client(snapshot)} />);
      await screen.findByText(disabledReasonCopy[reason]);
      const surface = screen.getByRole("region", { name: "Surface" });
      expect(surface).toHaveTextContent(disabledReasonCopy[reason]);
      expect(surface).not.toHaveTextContent(reason);
      view.unmount();
    },
  );

  it("restores confirmation focus to a surviving Workspace row after natural Agent removal", async () => {
    const appClient = client(agentSnapshot);
    let onSnapshot: ((snapshot: AppSnapshot) => void) | undefined;
    vi.mocked(appClient.subscribe).mockImplementation(async (listener) => {
      onSnapshot = listener;
      return () => undefined;
    });
    vi.mocked(appClient.dispatch).mockImplementation(
      async (intent: AppIntent): Promise<AppOutcome> =>
        intent.type === "stop_agent"
          ? {
              kind: "confirmation_required",
              confirmationId: "confirmation-agent-1",
              snapshot: agentSnapshot,
              purpose: { kind: "agent_stop" },
            }
          : { kind: "noop", snapshot: agentSnapshot },
    );
    render(<AppShell client={appClient} />);
    const stop = (
      await screen.findAllByRole("button", { name: "Stop agent" })
    )[0];
    stop.focus();
    fireEvent.click(stop);
    await screen.findByRole("dialog", { name: "Stop Codex 1?" });

    act(() => onSnapshot?.({ ...workspaceSnapshot, revision: 2 }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Stop Codex 1?" }),
      ).not.toBeInTheDocument(),
    );
    expect(stop.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /devhub workspace/ }),
    );
  });

  it("keeps loading state explicit until the native snapshot arrives", async () => {
    let resolveSnapshot: (snapshot: AppSnapshot) => void = () => undefined;
    const appClient = client(globalSnapshot);
    vi.mocked(appClient.getSnapshot).mockImplementation(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );
    render(<AppShell client={appClient} />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
    await waitFor(() => expect(appClient.getSnapshot).toHaveBeenCalled());
    resolveSnapshot(globalSnapshot);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Scratch" }),
      ).toBeInTheDocument(),
    );
  });

  it("renders unknown close resources with friendly verification wording", async () => {
    const appClient = client(workspaceSnapshot);
    vi.mocked(appClient.dispatch).mockResolvedValue({
      kind: "confirmation_required",
      confirmationId: "confirmation-1",
      snapshot: workspaceSnapshot,
      purpose: {
        kind: "workspace_close",
        inspection: {
          workspaceId: "workspace-1",
          workspaceLabel: "devhub",
          agents: { kind: "unknown", diagnostic: "close_agents_unknown" },
          terminalProcesses: { kind: "clean" },
          terminalPanes: {
            kind: "unknown",
            diagnostic: "close_terminal_unknown",
          },
          terminalWindows: { kind: "clean" },
          unsavedEditors: { kind: "clean" },
        },
      },
    });
    render(<AppShell client={appClient} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Close devhub" }),
    );

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Could not verify agents",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Could not verify terminal state",
    );
    expect(screen.getByRole("dialog")).not.toHaveTextContent(
      "close_terminal_unknown",
    );
  });

  it("cancels discovery before picker selection and restores trigger focus", async () => {
    const appClient = client(globalSnapshot);
    let pickerListener: ((event: WorkspacePickerEvent) => void) | undefined;
    appClient.startWorkspacePicker = vi.fn().mockResolvedValue("picker-1");
    appClient.cancelWorkspacePicker = vi.fn().mockResolvedValue(undefined);
    appClient.selectWorkspacePicker = vi.fn().mockResolvedValue({
      kind: "noop",
      snapshot: globalSnapshot,
    });
    appClient.subscribeWorkspacePicker = vi
      .fn()
      .mockImplementation(async (listener) => {
        pickerListener = listener;
        return () => undefined;
      });
    render(<AppShell client={appClient} />);

    const trigger = await screen.findByRole("button", {
      name: "Open workspace picker",
    });
    const nativeFocus = HTMLElement.prototype.focus;
    const focusInertStates: boolean[] = [];
    const focusSpy = vi
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(function (this: HTMLElement) {
        if (this.matches('[aria-label="Open workspace picker"]')) {
          focusInertStates.push(
            this.closest<HTMLElement>(".app-shell-content")?.inert ?? false,
          );
        }
        nativeFocus.call(this);
      });
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(appClient.startWorkspacePicker).toHaveBeenCalledWith(""),
    );
    act(() =>
      pickerListener?.({
        kind: "started",
        operationId: "picker-1",
        sequence: 0,
      }),
    );
    act(() =>
      pickerListener?.({
        kind: "candidate",
        operationId: "picker-1",
        sequence: 1,
        label: "DevHub",
        searchText: "DevHub /tmp/devhub",
        path: "/tmp/devhub",
        score: 100,
      }),
    );
    const candidate = await screen.findByRole("button", { name: /DevHub/ });
    fireEvent.click(candidate);

    await waitFor(() =>
      expect(appClient.selectWorkspacePicker).toHaveBeenCalledWith(
        "/tmp/devhub",
      ),
    );
    expect(appClient.cancelWorkspacePicker).toHaveBeenCalled();
    expect(
      vi.mocked(appClient.cancelWorkspacePicker).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(appClient.selectWorkspacePicker).mock.invocationCallOrder[0],
    );
    expect(document.activeElement).toBe(trigger);
    expect(focusInertStates).toContain(false);
    focusSpy.mockRestore();
  });

  it("cancels discovery before native folder selection", async () => {
    const appClient = client(globalSnapshot);
    let resolveFolder: (path: string | undefined) => void = () => undefined;
    appClient.startWorkspacePicker = vi.fn().mockResolvedValue("picker-1");
    appClient.cancelWorkspacePicker = vi.fn().mockResolvedValue(undefined);
    appClient.chooseWorkspaceFolder = vi.fn(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveFolder = resolve;
        }),
    );
    appClient.selectWorkspacePicker = vi.fn().mockResolvedValue({
      kind: "noop",
      snapshot: globalSnapshot,
    });
    appClient.subscribeWorkspacePicker = vi
      .fn()
      .mockResolvedValue(() => undefined);
    render(<AppShell client={appClient} />);

    const trigger = await screen.findByRole("button", {
      name: "Open workspace picker",
    });
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(appClient.startWorkspacePicker).toHaveBeenCalledWith(""),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Folder…" }));
    await waitFor(() =>
      expect(appClient.chooseWorkspaceFolder).toHaveBeenCalled(),
    );
    expect(appClient.cancelWorkspacePicker).toHaveBeenCalled();
    expect(appClient.selectWorkspacePicker).not.toHaveBeenCalled();

    resolveFolder("/tmp/chosen");
    await waitFor(() =>
      expect(appClient.selectWorkspacePicker).toHaveBeenCalledWith(
        "/tmp/chosen",
      ),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("does not commit a workspace picker selection during Japanese IME composition", async () => {
    const appClient = client(globalSnapshot);
    let pickerListener: ((event: WorkspacePickerEvent) => void) | undefined;
    appClient.startWorkspacePicker = vi.fn().mockResolvedValue("picker-ime");
    appClient.cancelWorkspacePicker = vi.fn().mockResolvedValue(undefined);
    appClient.selectWorkspacePicker = vi.fn().mockResolvedValue({
      kind: "noop",
      snapshot: globalSnapshot,
    });
    appClient.subscribeWorkspacePicker = vi
      .fn()
      .mockImplementation(async (listener) => {
        pickerListener = listener;
        return () => undefined;
      });
    render(<AppShell client={appClient} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open workspace picker" }),
    );
    await waitFor(() =>
      expect(appClient.startWorkspacePicker).toHaveBeenCalledWith(""),
    );
    act(() =>
      pickerListener?.({
        kind: "started",
        operationId: "picker-ime",
        sequence: 0,
      }),
    );
    act(() =>
      pickerListener?.({
        kind: "candidate",
        operationId: "picker-ime",
        sequence: 1,
        label: "日本語 DevHub",
        searchText: "日本語 DevHub /tmp/devhub",
        path: "/tmp/devhub",
        score: 100,
      }),
    );
    const input = await screen.findByRole("textbox", {
      name: "Filter workspaces",
    });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(appClient.selectWorkspacePicker).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(appClient.selectWorkspacePicker).toHaveBeenCalledWith(
        "/tmp/devhub",
      ),
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
      summary: "The requested action is not available.",
      module: "app",
      timestampMs: 1,
      runtimeVersion: "0.1.0",
      actions: ["retry"],
    });
    render(<AppShell client={appClient} />);
    await within(
      await screen.findByRole("complementary", {
        name: "Workspace navigation",
      }),
    ).findByRole("button", { current: "page", name: /devhub/ });
    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize sidebar" }),
      {
        key: "ArrowRight",
      },
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The requested action is not available.",
    );
    expect(screen.getByRole("region", { name: "Surface" })).toBeInTheDocument();
    // The rejected intent did not change context.
    expect(
      within(
        screen.getByRole("complementary", { name: "Workspace navigation" }),
      ).getByRole("button", { current: "page" }),
    ).toHaveAccessibleName(/devhub/);
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
    await within(
      await screen.findByRole("complementary", {
        name: "Workspace navigation",
      }),
    ).findByRole("button", { current: "page", name: /devhub/ });

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

    // A same-revision projection cannot retire the alert, so without a control
    // of its own it would cover the top of the Surface for the rest of the run.
    fireEvent.click(
      within(screen.getByRole("alert")).getByRole("button", {
        name: "Dismiss",
      }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

  it("queries appearance after subscribing and ignores an older live appearance event", async () => {
    const appClient = client(globalSnapshot);
    let appearanceListener: ((appearance: AppAppearance) => void) | undefined;
    const initialAppearance = appearanceFixture({ sequence: 2 });
    appClient.subscribeAppearance = vi.fn(async (listener) => {
      appearanceListener = listener;
      return () => undefined;
    });
    appClient.getAppearance = vi.fn().mockResolvedValue(initialAppearance);

    render(<AppShell client={appClient} />);
    await screen.findByRole("button", { name: "Scratch terminal" });
    await waitFor(() =>
      expect(document.querySelector(".app-shell")).toHaveAttribute(
        "data-sidebar-density",
        "comfortable",
      ),
    );

    await act(async () => {
      appearanceListener?.({
        ...initialAppearance,
        sequence: 1,
        sidebarDensity: "compact",
      });
      await Promise.resolve();
    });
    expect(document.querySelector(".app-shell")).toHaveAttribute(
      "data-sidebar-density",
      "comfortable",
    );
    expect(appClient.subscribeAppearance).toHaveBeenCalled();
    expect(appClient.getAppearance).toHaveBeenCalled();
  });
});
