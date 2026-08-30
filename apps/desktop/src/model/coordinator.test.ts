import { describe, expect, it } from "vitest";
import { AppCoordinator, type Effect } from "./coordinator.js";
import {
  AgentProfile,
  agentId,
  agentProfileId,
  busy,
  CLEAN_INSPECTION,
  displayPath,
  workspaceId,
  workspaceRoot,
  type CloseInspectionInputs,
} from "./domain.js";
import {
  AppError,
  AppErrorCode,
  confirmationId,
  intentId,
  operationId,
  requestedPath,
  type IntentOutcome,
  type OperationToken,
  type ProviderEvent,
  type UserIntent,
} from "./intents.js";

const WS_A = workspaceId("550e8400-e29b-41d4-a716-446655440000");
const AG_A = agentId("550e8400-e29b-41d4-a716-4466554400a0");
const CONFIRM = confirmationId("550e8400-e29b-41d4-a716-4466554400c0");
const codex = AgentProfile.create(agentProfileId("codex"), "Codex", "codex");

/**
 * A test driver that plays the adapter's part: it collects the effects the
 * coordinator emits and hands back exactly the completion each one asked for.
 */
class Driver {
  readonly coordinator = new AppCoordinator();
  private nextId = 0;
  private cursor = 0;

  private freshId(): string {
    this.nextId += 1;
    return `550e8400-e29b-41d4-a716-${this.nextId.toString(16).padStart(12, "0")}`;
  }

  dispatch(intent: UserIntent): IntentOutcome {
    return this.coordinator.dispatchUser({
      intentId: intentId(this.freshId()),
      operationId: operationId(this.freshId()),
      intent,
    });
  }

  /** Every effect emitted since the last time this was called. */
  drainEffects(): Effect[] {
    const subscription = this.coordinator.subscribeFrom(this.cursor);
    this.cursor = subscription.cursor;
    return subscription.events.flatMap((event) =>
      event.event.kind === "effect" ? [event.event.effect] : [],
    );
  }

  /** Answer one effect with the completion the coordinator is waiting for. */
  answer(effect: Effect, inspection: CloseInspectionInputs = CLEAN_INSPECTION) {
    switch (effect.kind) {
      case "persist_state":
        return this.accept({ type: "state_persisted", token: effect.token });
      case "resolve_workspace_path":
        return this.accept({
          type: "workspace_path_resolved",
          token: effect.token,
          root: workspaceRoot(effect.path),
          selectedPath: displayPath(effect.path),
        });
      case "generate_workspace_id":
        return this.accept({
          type: "workspace_id_generated",
          token: effect.token,
          workspaceId: WS_A,
        });
      case "resolve_agent_profile":
        return this.accept({
          type: "profile_resolved",
          token: effect.token,
          workspaceId: effect.workspaceId,
          profile: codex,
        });
      case "generate_agent_id":
        return this.accept({
          type: "agent_id_generated",
          token: effect.token,
          workspaceId: effect.workspaceId,
          agentId: AG_A,
        });
      case "launch_agent":
        return this.accept({
          type: "agent_launch_completed",
          token: effect.token,
          workspaceId: effect.workspaceId,
          agentId: effect.agentId,
          result: { kind: "started" },
        });
      case "generate_confirmation_id":
        return this.accept({
          type: "confirmation_id_generated",
          token: effect.token,
          confirmationId: CONFIRM,
        });
      case "inspect_workspace":
        return this.accept({
          type: "workspace_inspection_completed",
          token: effect.token,
          workspaceId: effect.workspaceId,
          inspection,
        });
      case "cleanup_workspace":
        return this.accept({
          type: "workspace_cleanup_completed",
          token: effect.token,
          workspaceId: effect.workspaceId,
          result: { kind: "step_completed", step: effect.step },
        });
      case "stop_agent":
        return this.accept({
          type: "agent_stop_completed",
          token: effect.token,
          agentId: effect.agentId,
          result: { kind: "stopped" },
        });
      default:
        return undefined;
    }
  }

  accept(event: ProviderEvent): IntentOutcome {
    return this.coordinator.acceptProviderEvent({
      eventId: this.freshId() as never,
      event,
    });
  }

  /** Run every pending effect to completion, in order. */
  settle(inspection: CloseInspectionInputs = CLEAN_INSPECTION): void {
    for (let round = 0; round < 64; round += 1) {
      const effects = this.drainEffects();
      if (effects.length === 0) return;
      for (const effect of effects) {
        this.answer(effect, inspection);
      }
    }
    throw new Error("effects did not settle");
  }

  openFolder(path: string): void {
    this.dispatch({ type: "open_folder", path: requestedPath(path) });
    this.settle();
  }
}

function errorCode(run: () => unknown): AppErrorCode | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.code : undefined;
  }
  return undefined;
}

describe("dispatch", () => {
  it("answers a pure transition immediately and persists it", () => {
    const driver = new Driver();
    const outcome = driver.dispatch({ type: "resize_sidebar", width: 300 });
    expect(outcome.kind).toBe("updated");
    expect(driver.drainEffects().map((effect) => effect.kind)).toEqual([
      "persist_state",
    ]);
  });

  it("reports a transition that changed nothing as a noop", () => {
    const driver = new Driver();
    driver.dispatch({ type: "resize_sidebar", width: 300 });
    driver.settle();
    const outcome = driver.dispatch({ type: "resize_sidebar", width: 300 });
    expect(outcome.kind).toBe("noop");
  });

  it("replays the same result for a repeated intent id", () => {
    const coordinator = new AppCoordinator();
    const id = intentId("550e8400-e29b-41d4-a716-4466554400f0");
    const op = operationId("550e8400-e29b-41d4-a716-4466554400f1");
    const intent: UserIntent = { type: "resize_sidebar", width: 300 };
    const first = coordinator.dispatchUser({ intentId: id, operationId: op, intent });
    const second = coordinator.dispatchUser({ intentId: id, operationId: op, intent });
    expect(second).toBe(first);
  });

  it("refuses a different intent under a used intent id", () => {
    const coordinator = new AppCoordinator();
    const id = intentId("550e8400-e29b-41d4-a716-4466554400f0");
    const op = operationId("550e8400-e29b-41d4-a716-4466554400f1");
    coordinator.dispatchUser({
      intentId: id,
      operationId: op,
      intent: { type: "resize_sidebar", width: 300 },
    });
    expect(
      errorCode(() =>
        coordinator.dispatchUser({
          intentId: id,
          operationId: op,
          intent: { type: "resize_sidebar", width: 320 },
        }),
      ),
    ).toBe(AppErrorCode.DuplicateIntent);
  });

  it("refuses an intent with no trusted operation identity", () => {
    const coordinator = new AppCoordinator();
    expect(
      errorCode(() =>
        coordinator.dispatchUser({
          intentId: intentId("550e8400-e29b-41d4-a716-4466554400f0"),
          operationId: undefined,
          intent: { type: "resize_sidebar", width: 300 },
        }),
      ),
    ).toBe(AppErrorCode.InvalidIntent);
  });
});

describe("opening a folder", () => {
  it("resolves, generates an identity, and adds the workspace", () => {
    const driver = new Driver();
    const outcome = driver.dispatch({
      type: "open_folder",
      path: requestedPath("/dev/project"),
    });
    expect(outcome.kind).toBe("deferred");
    driver.settle();
    const snapshot = driver.coordinator.snapshot();
    expect(snapshot.workspaces.map((workspace) => workspace.root)).toEqual([
      "/dev/project",
    ]);
  });

  it("selects the existing workspace when the same folder is opened again", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({ type: "select_context", context: { kind: "global" } });
    driver.settle();
    driver.openFolder("/dev/project");
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(1);
    expect(driver.coordinator.snapshot().selection.context).toEqual({
      kind: "workspace",
      workspaceId: WS_A,
    });
  });
});

describe("tokens", () => {
  it("rejects a completion for a superseded generation", () => {
    const driver = new Driver();
    driver.dispatch({
      type: "open_folder",
      path: requestedPath("/dev/project"),
    });
    const [effect] = driver.drainEffects();
    if (effect.kind !== "resolve_workspace_path") throw new Error("unexpected");
    const stale: OperationToken = {
      operationId: effect.token.operationId,
      generation: effect.token.generation + 1,
    };
    expect(
      errorCode(() =>
        driver.accept({
          type: "workspace_path_resolved",
          token: stale,
          root: workspaceRoot("/dev/project"),
          selectedPath: displayPath("/dev/project"),
        }),
      ),
    ).toBe(AppErrorCode.StaleCompletion);
  });

  it("rejects a completion for an operation nobody started", () => {
    const driver = new Driver();
    expect(
      errorCode(() =>
        driver.accept({
          type: "state_persisted",
          token: {
            operationId: operationId("550e8400-e29b-41d4-a716-4466554400ff"),
            generation: 1,
          },
        }),
      ),
    ).toBe(AppErrorCode.UnknownOperation);
  });
});

describe("closing a workspace", () => {
  it("closes without a confirmation when nothing is busy", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({ type: "request_close_workspace", workspaceId: WS_A });
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(0);
  });

  it("asks for confirmation when a resource is busy, then closes on confirm", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({ type: "request_close_workspace", workspaceId: WS_A });

    const inspect = driver.drainEffects()[0];
    if (inspect.kind !== "inspect_workspace") throw new Error("unexpected");
    driver.accept({
      type: "workspace_inspection_completed",
      token: inspect.token,
      workspaceId: WS_A,
      inspection: { ...CLEAN_INSPECTION, unsavedEditors: busy(1) },
    });

    const generate = driver.drainEffects()[0];
    if (generate.kind !== "generate_confirmation_id") {
      throw new Error("unexpected");
    }
    const required = driver.accept({
      type: "confirmation_id_generated",
      token: generate.token,
      confirmationId: CONFIRM,
    });
    expect(required.kind).toBe("confirmation_required");
    if (required.kind !== "confirmation_required") return;
    expect(required.purpose.kind).toBe("workspace_close");

    driver.dispatch({
      type: "confirm_close_workspace",
      confirmationId: CONFIRM,
    });
    // Cleanup has run by the time the final inspection happens, so it is
    // clean; a final inspection that is still busy is the failure case below.
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(0);
  });

  it("marks the close failed when the final inspection is still busy", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({ type: "request_close_workspace", workspaceId: WS_A });
    const inspect = driver.drainEffects()[0];
    if (inspect.kind !== "inspect_workspace") throw new Error("unexpected");
    driver.accept({
      type: "workspace_inspection_completed",
      token: inspect.token,
      workspaceId: WS_A,
      inspection: { ...CLEAN_INSPECTION, unsavedEditors: busy(1) },
    });
    const generate = driver.drainEffects()[0];
    if (generate.kind !== "generate_confirmation_id") {
      throw new Error("unexpected");
    }
    driver.accept({
      type: "confirmation_id_generated",
      token: generate.token,
      confirmationId: CONFIRM,
    });
    driver.dispatch({
      type: "confirm_close_workspace",
      confirmationId: CONFIRM,
    });
    driver.settle({ ...CLEAN_INSPECTION, unsavedEditors: busy(1) });
    const workspace = driver.coordinator.snapshot().workspaces[0];
    expect(workspace.state).toEqual({
      kind: "closing-failed",
      diagnostic: "cleanup_failed",
      progress: {
        agentsClosed: 0,
        agentsStepCompleted: true,
        terminalClosed: true,
        editorClosed: true,
      },
    });
  });

  it("refuses a confirmation that was never issued", () => {
    const driver = new Driver();
    expect(
      errorCode(() =>
        driver.dispatch({
          type: "confirm_close_workspace",
          confirmationId: CONFIRM,
        }),
      ),
    ).toBe(AppErrorCode.ConfirmationExpired);
  });
});

describe("launching an agent", () => {
  it("resolves the profile, generates an identity, launches, and selects it", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({
      type: "create_agent",
      workspaceId: WS_A,
      profileId: agentProfileId("codex"),
    });
    driver.settle();
    const snapshot = driver.coordinator.snapshot();
    expect(snapshot.workspaces[0].agents.map((agent) => agent.id)).toEqual([
      AG_A,
    ]);
    expect(snapshot.selection).toEqual({
      context: { kind: "agent", agentId: AG_A },
      activity: "agent",
    });
  });

  it("surfaces a launch failure instead of adding a phantom agent", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({
      type: "create_agent",
      workspaceId: WS_A,
      profileId: agentProfileId("codex"),
    });
    driver.answer(driver.drainEffects()[0]);
    driver.answer(driver.drainEffects()[0]);
    const launch = driver.drainEffects()[0];
    if (launch.kind !== "launch_agent") throw new Error("unexpected");
    expect(
      errorCode(() =>
        driver.accept({
          type: "agent_launch_completed",
          token: launch.token,
          workspaceId: WS_A,
          agentId: AG_A,
          result: { kind: "failed", diagnostic: "runtime_unavailable" },
        }),
      ),
    ).toBe(AppErrorCode.PortUnavailable);
    expect(driver.coordinator.snapshot().workspaces[0].agents).toHaveLength(0);
  });
});

describe("stopping an agent", () => {
  it("confirms, stops, and removes the agent", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({
      type: "create_agent",
      workspaceId: WS_A,
      profileId: agentProfileId("codex"),
    });
    driver.settle();

    driver.dispatch({ type: "stop_agent", agentId: AG_A });
    const generate = driver.drainEffects()[0];
    if (generate.kind !== "generate_confirmation_id") {
      throw new Error("unexpected");
    }
    const required = driver.accept({
      type: "confirmation_id_generated",
      token: generate.token,
      confirmationId: CONFIRM,
    });
    expect(required.kind).toBe("confirmation_required");

    driver.dispatch({ type: "confirm_stop_agent", confirmationId: CONFIRM });
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces[0].agents).toHaveLength(0);
  });

  it("keeps a failed stop retryable", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({
      type: "create_agent",
      workspaceId: WS_A,
      profileId: agentProfileId("codex"),
    });
    driver.settle();
    driver.dispatch({ type: "stop_agent", agentId: AG_A });
    const generate = driver.drainEffects()[0];
    if (generate.kind !== "generate_confirmation_id") {
      throw new Error("unexpected");
    }
    driver.accept({
      type: "confirmation_id_generated",
      token: generate.token,
      confirmationId: CONFIRM,
    });
    driver.dispatch({ type: "confirm_stop_agent", confirmationId: CONFIRM });
    const stop = driver.drainEffects().find((effect) => effect.kind === "stop_agent");
    if (!stop || stop.kind !== "stop_agent") throw new Error("unexpected");
    driver.accept({
      type: "agent_stop_completed",
      token: stop.token,
      agentId: AG_A,
      result: { kind: "failed", diagnostic: "cleanup_failed" },
    });
    const agent = driver.coordinator.snapshot().workspaces[0].agents[0];
    expect(agent.controlState).toEqual({
      kind: "stop-failed",
      diagnostic: "cleanup_failed",
    });
  });
});

describe("persistence", () => {
  it("reports a failed save as degraded rather than losing it", () => {
    const driver = new Driver();
    driver.dispatch({ type: "resize_sidebar", width: 300 });
    const persist = driver.drainEffects()[0];
    if (persist.kind !== "persist_state") throw new Error("unexpected");
    const outcome = driver.accept({
      type: "state_persistence_failed",
      token: persist.token,
    });
    expect(outcome.kind).toBe("persistence_degraded");
  });
});

describe("replay", () => {
  it("hands a new subscriber the full history and its cursor", () => {
    const driver = new Driver();
    driver.dispatch({ type: "resize_sidebar", width: 300 });
    const replay = driver.coordinator.replayFrom(0);
    expect(replay.historyGap).toBe(false);
    expect(replay.events.length).toBeGreaterThan(0);
    expect(replay.cursor).toBe(replay.events.at(-1)?.sequence);
  });
});

describe("detaching", () => {
  it("emits one detach effect and answers every later intent as detached", () => {
    const driver = new Driver();
    driver.dispatch({ type: "quit" });
    expect(driver.drainEffects()).toEqual([
      { kind: "detach", reason: "quit" },
    ]);
    const outcome = driver.dispatch({ type: "resize_sidebar", width: 300 });
    expect(outcome.kind).toBe("detached");
    expect(driver.drainEffects()).toEqual([]);
  });
});
