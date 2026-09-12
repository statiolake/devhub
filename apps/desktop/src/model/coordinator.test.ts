import { describe, expect, it } from "vitest";
import { AppCoordinator, type Effect } from "./coordinator.js";
import {
  AgentProfile,
  agentId,
  agentProfileId,
  busy,
  CLEAN_INSPECTION,
  displayPath,
  DomainErrorCode,
  workspaceId,
  workspaceLocation,
  type CloseInspectionInputs,
  NO_INJECTION,
} from "./domain.js";
import {
  AppError,
  AppErrorCode,
  confirmationId,
  intentId,
  operationId,
  requestedLocation,
  type IntentOutcome,
  type OperationToken,
  type ProviderEvent,
  type UserIntent,
  type WorktreeDisposition,
} from "./intents.js";

const WS_A = workspaceId("550e8400-e29b-41d4-a716-446655440000");
const AG_A = agentId("550e8400-e29b-41d4-a716-4466554400a0");
const CONFIRM = confirmationId("550e8400-e29b-41d4-a716-4466554400c0");
const codex = AgentProfile.create(
  agentProfileId("codex"),
  "Codex",
  "codex",
  "codex",
);

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

  /** Every error emitted since the last drain, in order. */
  drainErrors(): AppError[] {
    const subscription = this.coordinator.subscribeFrom(this.cursor);
    this.cursor = subscription.cursor;
    return subscription.events.flatMap((event) =>
      event.event.kind === "error" ? [event.event.error] : [],
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
          location: workspaceLocation(
            effect.location.kind === "local"
              ? { kind: "local", path: effect.location.path }
              : {
                  kind: "ssh",
                  host: effect.location.host,
                  path: effect.location.path,
                },
          ),
          selectedPath: displayPath(effect.location.path),
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
      case "close_workspace":
        return this.accept({
          type: "workspace_close_completed",
          token: effect.token,
          workspaceId: effect.workspaceId,
          result: { kind: "closed" },
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
    this.dispatch({
      type: "open_folder",
      location: requestedLocation({ kind: "local", path }),
    });
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
    const first = coordinator.dispatchUser({
      intentId: id,
      operationId: op,
      intent,
    });
    const second = coordinator.dispatchUser({
      intentId: id,
      operationId: op,
      intent,
    });
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
      location: requestedLocation({ kind: "local", path: "/dev/project" }),
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
    driver.dispatch({
      type: "select_context",
      context: { kind: "global" },
      presentation: "full",
    });
    driver.settle();
    driver.openFolder("/dev/project");
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(1);
    expect(driver.coordinator.snapshot().selection.context).toEqual({
      kind: "workspace",
      workspaceId: WS_A,
    });
  });
});

describe("opening a folder on another machine", () => {
  // An ssh open used to skip resolution and become a Workspace with the path
  // as typed. On a host whose `$HOME` is a symlink — `/home/x` canonically
  // `/volume1/home/x` — that root is not the folder's own name there, and
  // every tmux session DevHub tried to create on the host was refused as a
  // conflict: no Agent could start, and no workspace terminal either.
  it("resolves the path on the machine it is on, host and all", () => {
    const driver = new Driver();
    driver.dispatch({
      type: "open_folder",
      location: requestedLocation({
        kind: "ssh",
        host: "build.example.com",
        path: "/srv/api",
      }),
    });
    const effects = driver.drainEffects();
    expect(effects.map((effect) => effect.kind)).toEqual([
      "resolve_workspace_path",
    ]);
    const [effect] = effects;
    if (effect?.kind !== "resolve_workspace_path") {
      throw new Error("unexpected");
    }
    // The machine travels with the path, so the adapter asks that host rather
    // than this Mac about a folder this Mac has never had.
    expect(effect.location).toEqual({
      kind: "ssh",
      host: "build.example.com",
      path: "/srv/api",
    });
  });

  it("adds it as a Workspace like any other, and keeps the machine", () => {
    const driver = new Driver();
    driver.dispatch({
      type: "open_folder",
      location: requestedLocation({
        kind: "ssh",
        host: "build.example.com",
        path: "/srv/api",
      }),
    });
    driver.settle();
    const [workspace] = driver.coordinator.snapshot().workspaces;
    expect(workspace?.location).toEqual({
      kind: "ssh",
      host: "build.example.com",
      path: "/srv/api",
    });
    expect(workspace?.key).toBe("ssh://build.example.com/srv/api");
    // An Agent is a process and a process runs where the folder is — which is
    // now a machine DevHub has a runtime for either way, so the row offers one.
    expect(workspace?.canCreateAgent).toBe(true);
  });

  it("keeps a second machine's identical path as a second Workspace", () => {
    // The identity of a place is the machine and the path together. Keyed on
    // the path, the second open would have selected the first row instead of
    // asking for an identity at all.
    const driver = new Driver();
    const ids = [WS_A, workspaceId("550e8400-e29b-41d4-a716-4466554400b1")];
    ids.forEach((id, index) => {
      driver.dispatch({
        type: "open_folder",
        location: requestedLocation({
          kind: "ssh",
          host: index === 0 ? "build.example.com" : "staging.example.com",
          path: "/srv/api",
        }),
      });
      // The place is resolved on its own machine first, so the identity step
      // is one round further along than it used to be.
      for (let round = 0; round < 4; round += 1) {
        const effects = driver.drainEffects();
        if (effects.length === 0) break;
        for (const effect of effects) {
          if (effect.kind === "generate_workspace_id") {
            driver.accept({
              type: "workspace_id_generated",
              token: effect.token,
              workspaceId: id,
            });
            continue;
          }
          driver.answer(effect);
        }
      }
      driver.settle();
    });
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(2);
  });
});

describe("tokens", () => {
  it("rejects a completion for a superseded generation", () => {
    const driver = new Driver();
    driver.dispatch({
      type: "open_folder",
      location: requestedLocation({ kind: "local", path: "/dev/project" }),
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
          location: workspaceLocation({
            kind: "local",
            path: "/dev/project",
          }),
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

/** The close request every test sends; a plain Workspace keeps its folder. */
function closeIntent(worktree: WorktreeDisposition = "keep"): UserIntent {
  return { type: "request_close_workspace", workspaceId: WS_A, worktree };
}

/**
 * A driver that has opened a workspace and asked to close it, stopped at the
 * `close_workspace` effect — that is, with every question answered and no step
 * yet run.
 */
function atTheFirstStep(): {
  driver: Driver;
  effect: Extract<Effect, { kind: "close_workspace" }>;
} {
  const driver = new Driver();
  driver.openFolder("/dev/project");
  driver.dispatch(closeIntent());
  const inspect = driver.drainEffects()[0];
  if (inspect.kind !== "inspect_workspace") throw new Error("unexpected");
  driver.answer(inspect);
  const effect = driver.drainEffects()[0];
  if (effect?.kind !== "close_workspace") throw new Error("unexpected");
  return { driver, effect };
}

describe("closing a workspace", () => {
  it("closes without a confirmation when nothing is busy", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch(closeIntent());
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(0);
  });

  it("asks everything before it does anything", () => {
    // The whole of rule one. Between the request and the answer there is
    // exactly one effect — the question — and no step has run.
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch(closeIntent());
    expect(driver.drainEffects().map((effect) => effect.kind)).toEqual([
      "inspect_workspace",
    ]);
  });

  it("runs the steps as one act, not one save at a time", () => {
    // A close used to be four effects with a save between each, and the file
    // it wrote between them was a midpoint somebody could resume from. There
    // is one effect now, and the only save is the one that makes the close
    // final.
    const { driver, effect } = atTheFirstStep();
    expect(driver.drainEffects()).toHaveLength(0);
    driver.answer(effect);
    expect(driver.drainEffects().map((one) => one.kind)).toEqual([
      "persist_state",
    ]);
  });

  it("carries the answer about the folder into the close", () => {
    // The folder question is asked before the close is requested, so what
    // reaches the environment is the decision, not a question to raise.
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch(closeIntent("remove-anyway"));
    driver.answer(driver.drainEffects()[0]);
    const effect = driver.drainEffects()[0];
    if (effect?.kind !== "close_workspace") throw new Error("unexpected");
    expect(effect.worktree).toBe("remove-anyway");
  });

  it("asks for confirmation when a resource is busy, then closes on confirm", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch(closeIntent());

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
    // The question is on screen and nothing has been closed.
    expect(driver.drainEffects()).toHaveLength(0);

    driver.dispatch({
      type: "confirm_close_workspace",
      confirmationId: CONFIRM,
    });
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(0);
  });

  it("changes nothing when the question is left unanswered", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch(closeIntent());
    const inspect = driver.drainEffects()[0];
    if (inspect.kind !== "inspect_workspace") throw new Error("unexpected");
    driver.accept({
      type: "workspace_inspection_completed",
      token: inspect.token,
      workspaceId: WS_A,
      inspection: { ...CLEAN_INSPECTION, agents: busy(1) },
    });
    driver.answer(driver.drainEffects()[0]);
    // Cancel is the sheet closing itself: the confirmation is simply never
    // answered. The Workspace is exactly where it was, and no step has run.
    expect(driver.drainEffects()).toHaveLength(0);
    const workspace = driver.coordinator.snapshot().workspaces[0];
    expect(workspace).toBeDefined();
    expect(workspace.close).toEqual({ kind: "idle" });
  });

  it("closes a workspace whose Agents are all idle, and stops them with it", () => {
    // What the inspection reports is `agentsInspection`'s answer, and idle
    // Agents are not a reason to ask anything. Nothing is asked, and the
    // close takes them with it.
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({
      type: "create_agent",
      workspaceId: WS_A,
      profileId: agentProfileId("codex"),
      presentation: "full",
    });
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces[0].agents).toHaveLength(1);

    driver.dispatch(closeIntent());
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(0);
  });

  it("closes a workspace whose Agent was killed from outside", () => {
    // The Agents step reports success because its session is already gone —
    // which is the state it was trying to reach. The row, and the Agent on
    // it, go with the close: "already gone" is not a reason to stop.
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({
      type: "create_agent",
      workspaceId: WS_A,
      profileId: agentProfileId("codex"),
      presentation: "full",
    });
    driver.settle();
    driver.dispatch(closeIntent());
    driver.answer(driver.drainEffects()[0]);
    const close = driver.drainEffects()[0];
    if (close?.kind !== "close_workspace") throw new Error("unexpected");
    driver.accept({
      type: "workspace_close_completed",
      token: close.token,
      workspaceId: WS_A,
      result: { kind: "closed" },
    });
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(0);
  });

  it("refuses a second close while one is running", () => {
    const { driver } = atTheFirstStep();
    expect(errorCode(() => driver.dispatch(closeIntent()))).toBe(
      AppErrorCode.Domain,
    );
  });

  it("names the step and the cause when one fails, and keeps the row", () => {
    const { driver, effect } = atTheFirstStep();
    driver.drainErrors();
    driver.accept({
      type: "workspace_close_completed",
      token: effect.token,
      workspaceId: WS_A,
      result: {
        kind: "failed",
        step: "agents",
        diagnostic: "close_agents_unknown",
      },
    });

    const workspace = driver.coordinator.snapshot().workspaces[0];
    expect(workspace).toBeDefined();
    expect(workspace.close).toEqual({
      kind: "failed",
      step: "agents",
      diagnostic: "close_agents_unknown",
    });
    // Open, not a third state: the folder is there and the Workspace is in
    // the list. Only the close has anything to say.
    expect(workspace.state).toEqual({ kind: "available" });
    // Not a port that would not answer. It used to be raised as one, and the
    // page drew "the native app shell is unavailable" over a workspace whose
    // agents simply could not be confirmed stopped.
    const errors = driver.drainErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(AppErrorCode.Domain);
    expect(errors[0].domainCode).toBe(DomainErrorCode.WorkspaceClosingFailed);
  });

  it("succeeds on the next attempt once the cause is gone", () => {
    // Nothing is resumed and nothing is remembered: the same close runs the
    // same steps, and the ones that finished last time find themselves done.
    const { driver, effect } = atTheFirstStep();
    driver.accept({
      type: "workspace_close_completed",
      token: effect.token,
      workspaceId: WS_A,
      result: {
        kind: "failed",
        step: "terminal",
        diagnostic: "close_terminal_unknown",
      },
    });
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(1);

    driver.dispatch(closeIntent());
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(0);
  });

  it("clears a previous failure when the next close starts", () => {
    const { driver, effect } = atTheFirstStep();
    driver.accept({
      type: "workspace_close_completed",
      token: effect.token,
      workspaceId: WS_A,
      result: {
        kind: "failed",
        step: "worktree",
        diagnostic: "cleanup_failed",
      },
    });
    driver.settle();
    driver.dispatch(closeIntent());
    driver.answer(driver.drainEffects()[0]);
    expect(driver.coordinator.snapshot().workspaces[0].close).toEqual({
      kind: "running",
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
      presentation: "full",
    });
    driver.settle();
    const snapshot = driver.coordinator.snapshot();
    expect(snapshot.workspaces[0].agents.map((agent) => agent.id)).toEqual([
      AG_A,
    ]);
    expect(snapshot.selection).toEqual({
      context: { kind: "agent", agentId: AG_A },
      presentation: "full",
    });
  });

  it("surfaces a launch failure instead of adding a phantom agent", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({
      type: "create_agent",
      workspaceId: WS_A,
      profileId: agentProfileId("codex"),
      presentation: "full",
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
          result: { kind: "failed", code: "agent_runtime_unavailable" },
        }),
      ),
    ).toBe(AppErrorCode.PortUnavailable);
    expect(driver.coordinator.snapshot().workspaces[0].agents).toHaveLength(0);
  });
});

describe("stopping an agent", () => {
  /** A driver with one Agent in one workspace, reported as `status`. */
  function withAgent(status: "idle" | "working" | "unknown"): Driver {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({
      type: "create_agent",
      workspaceId: WS_A,
      profileId: agentProfileId("codex"),
      presentation: "full",
    });
    driver.settle();
    if (status !== "unknown") {
      driver.dispatch({ type: "reconcile_agents", machine: "local" });
      const effect = driver
        .drainEffects()
        .find((candidate) => candidate.kind === "reconcile_agents");
      if (effect?.kind !== "reconcile_agents") {
        throw new Error("the coordinator did not ask for a reconcile");
      }
      driver.accept({
        type: "agents_reconciled",
        token: effect.token,
        reconciliation: {
          observations: [
            {
              agentId: AG_A,
              status,
              runtimeHealth: "healthy",
              activity: undefined,
              injection: NO_INJECTION,
            },
          ],
          exited: [],
        },
      });
      driver.drainEffects();
    }
    return driver;
  }

  it("stops an idle Agent where it stands, with no question", () => {
    const driver = withAgent("idle");
    const outcome = driver.dispatch({ type: "stop_agent", agentId: AG_A });
    expect(outcome.kind).not.toBe("confirmation_required");
    const effects = driver.drainEffects();
    expect(effects.map((effect) => effect.kind)).toContain("stop_agent");
    for (const effect of effects) driver.answer(effect);
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces[0].agents).toHaveLength(0);
  });

  it("asks before stopping an Agent that is working", () => {
    const driver = withAgent("working");
    driver.dispatch({ type: "stop_agent", agentId: AG_A });
    const generate = driver.drainEffects()[0];
    if (generate.kind !== "generate_confirmation_id") {
      throw new Error("the coordinator did not ask for a confirmation");
    }
    const required = driver.accept({
      type: "confirmation_id_generated",
      token: generate.token,
      confirmationId: CONFIRM,
    });
    expect(required.kind).toBe("confirmation_required");
    // Cancelling is not answering: the Agent is still there.
    expect(driver.coordinator.snapshot().workspaces[0].agents).toHaveLength(1);
  });

  it("asks about an Agent nobody has read, because not knowing is not idle", () => {
    const driver = withAgent("unknown");
    driver.dispatch({ type: "stop_agent", agentId: AG_A });
    expect(driver.drainEffects()[0].kind).toBe("generate_confirmation_id");
  });

  it("confirms, stops, and removes the agent", () => {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({
      type: "create_agent",
      workspaceId: WS_A,
      profileId: agentProfileId("codex"),
      presentation: "full",
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
      presentation: "full",
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
    const stop = driver
      .drainEffects()
      .find((effect) => effect.kind === "stop_agent");
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

/**
 * A completion for a close this coordinator is not running.
 *
 * There is no separate bookkeeping to go missing any more — the pending
 * operation *is* the record — so this is what a stale or fabricated completion
 * meets. It used to invent "nothing has been closed yet" for a missing cleanup
 * entry, which on the failed path erased the count of Agents already stopped
 * and on the success path restarted the close from the beginning.
 */
describe("a close completion nobody is waiting for", () => {
  it("is a broken invariant, and says so instead of inventing one", () => {
    const { driver, effect } = atTheFirstStep();
    driver.accept({
      type: "workspace_close_completed",
      token: effect.token,
      workspaceId: WS_A,
      result: { kind: "closed" },
    });
    expect(() =>
      driver.accept({
        type: "workspace_close_completed",
        token: effect.token,
        workspaceId: WS_A,
        result: { kind: "closed" },
      }),
    ).toThrow();
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
      reason: "/state.json: permission was denied (EACCES)",
    });
    expect(outcome.kind).toBe("persistence_degraded");
  });

  it("says which file could not be saved and why", () => {
    const driver = new Driver();
    driver.dispatch({ type: "resize_sidebar", width: 300 });
    const persist = driver.drainEffects()[0];
    if (persist.kind !== "persist_state") throw new Error("unexpected");
    driver.accept({
      type: "state_persistence_failed",
      token: persist.token,
      reason: "/state.json: permission was denied (EACCES)",
    });
    const errors = driver.drainErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(AppErrorCode.PersistenceDegraded);
    expect(errors[0].detail).toBe(
      "/state.json: permission was denied (EACCES)",
    );
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
    expect(driver.drainEffects()).toEqual([{ kind: "detach", reason: "quit" }]);
    const outcome = driver.dispatch({ type: "resize_sidebar", width: 300 });
    expect(outcome.kind).toBe("detached");
    expect(driver.drainEffects()).toEqual([]);
  });
});

/**
 * A close that failed is the same close, asked for again.
 *
 * Nothing is resumed: there is no persisted midpoint and no memory of which
 * steps ran, because every step is idempotent and repeating one that finished
 * finds it done. The intent is the one the Sidebar's button sends the first
 * time, word for word.
 */
describe("closing again after a close that failed", () => {
  it("starts from the beginning and finishes", () => {
    const { driver, effect } = atTheFirstStep();
    driver.accept({
      type: "workspace_close_completed",
      token: effect.token,
      workspaceId: WS_A,
      result: {
        kind: "failed",
        step: "editor",
        diagnostic: "close_editor_vetoed",
      },
    });
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces[0].close.kind).toBe(
      "failed",
    );

    driver.dispatch(closeIntent());
    // The same question first, then the same one act: a second attempt is not
    // a different shape of close.
    const again = driver.drainEffects();
    expect(again.map((one) => one.kind)).toEqual(["inspect_workspace"]);
    for (const effect of again) driver.answer(effect);
    driver.settle();
    expect(driver.coordinator.snapshot().workspaces).toHaveLength(0);
  });
});

describe("reconciling agents", () => {
  function withAgent(): Driver {
    const driver = new Driver();
    driver.openFolder("/dev/project");
    driver.dispatch({
      type: "create_agent",
      workspaceId: WS_A,
      profileId: agentProfileId("codex"),
      presentation: "full",
    });
    driver.settle();
    return driver;
  }

  it("asks the provider about every agent at once", () => {
    const driver = withAgent();
    driver.dispatch({ type: "reconcile_agents", machine: "local" });
    expect(driver.drainEffects().map((effect) => effect.kind)).toEqual([
      "reconcile_agents",
    ]);
  });

  function reconcileToken(driver: Driver): OperationToken {
    driver.dispatch({ type: "reconcile_agents", machine: "local" });
    const effect = driver.drainEffects()[0];
    if (effect.kind !== "reconcile_agents") {
      throw new Error("the coordinator did not ask for a reconcile");
    }
    return effect.token;
  }

  it("keeps two machines' rounds apart, so neither is stale on arrival", () => {
    // Two machines reconcile on two cadences over two tmux servers, so their
    // rounds overlap by design. With one slot for "the reconcile in flight",
    // whichever started second invalidated the first, and the first machine's
    // answer came back as a stale completion for ever.
    const driver = withAgent();
    driver.dispatch({ type: "reconcile_agents", machine: "local" });
    const first = driver.drainEffects()[0];
    driver.dispatch({
      type: "reconcile_agents",
      machine: "ssh:build.example.com",
    });
    const second = driver.drainEffects()[0];
    if (
      first.kind !== "reconcile_agents" ||
      second.kind !== "reconcile_agents"
    ) {
      throw new Error("the coordinator did not ask for two reconciles");
    }
    const empty = { observations: [], exited: [] };
    driver.accept({
      type: "agents_reconciled",
      token: second.token,
      reconciliation: empty,
    });
    // The first machine's round is still the live one for *its* machine, and
    // its answer lands rather than being thrown away.
    expect(() =>
      driver.accept({
        type: "agents_reconciled",
        token: first.token,
        reconciliation: empty,
      }),
    ).not.toThrow();
  });

  it("projects what the provider reported onto the rows", () => {
    const driver = withAgent();
    const token = reconcileToken(driver);
    driver.accept({
      type: "agents_reconciled",
      token,
      reconciliation: {
        observations: [
          {
            agentId: AG_A,
            status: "working",
            runtimeHealth: "healthy",
            activity: undefined,
            injection: NO_INJECTION,
          },
        ],
        exited: [],
      },
    });
    const agent = driver.coordinator.snapshot().workspaces[0].agents[0];
    expect(agent.status).toBe("working");
    expect(agent.runtimeHealth).toBe("healthy");
  });

  it("carries what the Agent says it is doing onto its row", () => {
    const driver = withAgent();
    const said = (activity: string | undefined): string | undefined => {
      driver.dispatch({ type: "reconcile_agents", machine: "local" });
      const effect = driver
        .drainEffects()
        .find((candidate) => candidate.kind === "reconcile_agents");
      if (effect?.kind !== "reconcile_agents") {
        throw new Error("the coordinator did not ask for a reconcile");
      }
      const token = effect.token;
      driver.accept({
        type: "agents_reconciled",
        token,
        reconciliation: {
          observations: [
            {
              agentId: AG_A,
              status: "working",
              runtimeHealth: "healthy",
              activity,
              injection: NO_INJECTION,
            },
          ],
          exited: [],
        },
      });
      return driver.coordinator.snapshot().workspaces[0].agents[0].activity;
    };
    expect(said("Reading agentReconciler.ts")).toBe(
      "Reading agentReconciler.ts",
    );
    // And a round that reports nothing takes the word away rather than
    // leaving the row saying something the Agent has stopped saying.
    expect(said(undefined)).toBeUndefined();
  });

  it("takes the row away when the provider says the agent is gone", () => {
    const driver = withAgent();
    const token = reconcileToken(driver);
    driver.accept({
      type: "agents_reconciled",
      token,
      reconciliation: { observations: [], exited: [AG_A] },
    });
    expect(driver.coordinator.snapshot().workspaces[0].agents).toHaveLength(0);
  });

  it("announces a round it superseded, so nothing waits on the answer", () => {
    const driver = withAgent();
    const superseded = reconcileToken(driver);
    driver.dispatch({ type: "reconcile_agents", machine: "local" });
    const events = driver.coordinator
      .subscribeFrom(0)
      .events.map(({ event }) => event);
    expect(
      events.some(
        (event) =>
          event.kind === "operation_completed" &&
          event.token.operationId === superseded.operationId,
      ),
    ).toBe(true);
  });
});

describe("the window coming and going", () => {
  /**
   * Focus is a fact only main can see, so it arrives as an intent like every
   * other one — and it has to reach the model, because "is anybody looking at
   * this Agent" is half of whether a finished Agent is owed a look.
   */
  it("carries the window's focus into the model", () => {
    const driver = new Driver();
    expect(driver.coordinator.model.windowFocused).toBe(true);

    const away = driver.dispatch({
      type: "window_focus_changed",
      focused: false,
    });
    expect(away.kind).toBe("updated");
    expect(driver.coordinator.model.windowFocused).toBe(false);

    // Saying the same thing twice moves nothing, and must not look like a
    // change: it is raised on every window event there is.
    expect(
      driver.dispatch({ type: "window_focus_changed", focused: false }).kind,
    ).toBe("noop");

    driver.dispatch({ type: "window_focus_changed", focused: true });
    expect(driver.coordinator.model.windowFocused).toBe(true);
  });
});
