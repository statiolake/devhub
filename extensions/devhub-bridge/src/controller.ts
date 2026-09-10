import type { AbsolutePath, Context } from "./generated/bridge/index";
import type { OpenWorkspaceSource } from "./generated/bridge/index";
import { faultIdentity, type BridgeFault } from "./fault";
import { BridgeSession } from "./session";

const MAX_RECONNECT_DELAY_MS = 5_000;

export interface ControllerSocketHandlers {
  onOpen: () => void;
  onMessage: (raw: string) => void;
  onError: (fault: BridgeFault) => void;
  onClose: () => void;
}

export interface ControllerSocket {
  open(): void;
  send(raw: string): boolean;
  close(): void;
}

export interface ControllerDependencies {
  createSocket: (
    endpoint: string,
    token: string,
    handlers: ControllerSocketHandlers,
  ) => ControllerSocket;
  context: () => Context | null;
  dirty: () => boolean;
  log?: (kind: string, fields?: Record<string, unknown>) => void;
  /**
   * Where a fault goes.
   *
   * Not optional in spirit: a controller with nowhere to report is the state
   * this whole union exists to end. It is optional only so the pure tests can
   * leave it out, and it defaults to doing nothing rather than to a console,
   * because a console is what was wrong before.
   */
  report?: (fault: BridgeFault) => void;
  schedule?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface ControllerConfig {
  endpoint: string;
  token: string;
  surfaceId: string;
  extensionVersion: string;
  workbenchInstanceId: string;
  createMessageId: () => string;
}

/**
 * VS Code-independent lifecycle/controller seam. It owns reconnect and
 * session state, while the extension supplies only observation and socket
 * adapters. This makes reconnect and host-request behavior executable without
 * loading the VS Code module.
 */
export class BridgeControllerCore {
  private readonly config: ControllerConfig;
  private readonly dependencies: Required<
    Pick<ControllerDependencies, "createSocket" | "context" | "dirty">
  > &
    Omit<ControllerDependencies, "createSocket" | "context" | "dirty">;
  private readonly session: BridgeSession;
  private socket: ControllerSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  /**
   * The fault this connection ended on, kept until the next one succeeds.
   *
   * A reconnect loop that cannot say what it is retrying is the thing that
   * made a broken Bridge undiagnosable, so the reason is state rather than a
   * moment. `lastFault` is what a status item reads.
   */
  private fault: BridgeFault | null = null;

  public constructor(
    config: ControllerConfig,
    dependencies: ControllerDependencies,
  ) {
    const context = dependencies.context();
    if (!context) throw new Error("surface context unavailable");
    this.config = config;
    this.dependencies = {
      ...dependencies,
      log: dependencies.log ?? (() => undefined),
      report: dependencies.report ?? (() => undefined),
      schedule:
        dependencies.schedule ??
        ((callback, delay) => setTimeout(callback, delay)),
      cancel: dependencies.cancel ?? ((timer) => clearTimeout(timer)),
    };
    this.session = new BridgeSession({
      surfaceId: config.surfaceId,
      extensionVersion: config.extensionVersion,
      workbenchInstanceId: config.workbenchInstanceId,
      createMessageId: config.createMessageId,
    });
    this.session.setState({
      readiness: "starting",
      context,
      dirty: dependencies.dirty(),
    });
  }

  /** What went wrong last, or `null` if this connection is healthy. */
  public lastFault(): BridgeFault | null {
    return this.fault;
  }

  public start(): void {
    this.stopped = false;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) this.dependencies.cancel?.(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.session.onSocketClosed();
  }

  public observeWorkspace(): void {
    const context = this.dependencies.context();
    if (!context) {
      const unavailable = this.session.sendReadiness("unavailable");
      if (unavailable) this.send(unavailable);
      this.socket?.close();
      return;
    }
    if (!this.socket) {
      this.connect();
      return;
    }
    const frame = this.session.sendIdentity(context);
    if (frame) this.send(frame);
    const ready = this.session.sendReadiness("ready");
    if (ready) this.send(ready);
  }

  public observeDirty(): void {
    const dirty = this.dependencies.dirty();
    const frame = this.session.sendDirty(dirty);
    if (frame) {
      this.send(frame);
      this.dependencies.log?.("dirty_changed", { dirty });
    }
  }

  public openFolder(path: string): void {
    this.openWorkspace(path, "open_folder");
  }

  public openWorkspace(path: string, source: OpenWorkspaceSource): void {
    const frame = this.session.sendOpenWorkspace(path as AbsolutePath, source);
    if (frame) this.send(frame);
  }

  public newWindow(path: string | null): void {
    const frame = this.session.sendNewWindow(
      path === null ? null : (path as AbsolutePath),
      "command",
    );
    if (frame) this.send(frame);
  }

  public handleHostMessage(raw: string): void {
    const actions = this.session.onHostFrame(raw);
    actions.frames.forEach((frame) => this.send(frame));
    if (actions.fault) this.raise(actions.fault);
    if (actions.close) this.socket?.close();
  }

  public get sessionForTests(): BridgeSession {
    return this.session;
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const context = this.dependencies.context();
    if (!context) {
      this.session.onSocketClosed();
      return;
    }
    this.session.sendIdentity(context);
    this.session.sendDirty(this.dependencies.dirty());
    try {
      this.socket = this.dependencies.createSocket(
        this.config.endpoint,
        this.config.token,
        {
          onOpen: () => {
            this.reconnectAttempt = 0;
            // A connection that came up is the answer to whatever the last one
            // failed with; nothing else retires a fault, so nothing else can
            // retire it while it is still true.
            this.clearFault();
            const actions = this.session.onSocketOpen();
            actions.frames.forEach((frame) => this.send(frame));
          },
          onMessage: (raw) => this.handleHostMessage(raw),
          onError: (fault) => {
            this.raise(fault);
            this.socket?.close();
          },
          onClose: () => this.handleClose(),
        },
      );
      this.socket.open();
    } catch (error) {
      // The socket constructor refuses an endpoint or token it will not use.
      // That is a configuration DevHub injected, not a network condition, and
      // reconnecting will refuse it again — so it is said, every time, until
      // somebody changes it.
      this.socket = null;
      this.raise({
        kind: "config",
        variable: "DEVHUB_BRIDGE_ENDPOINT",
        refusal:
          error instanceof Error && error.message.includes("token")
            ? "token_unsafe"
            : "endpoint_not_loopback",
      });
      this.scheduleReconnect();
    }
  }

  /**
   * Record a fault and report it, once per distinct fault.
   *
   * The identity check is here rather than at the reporter because it is the
   * controller that knows a reconnect loop is raising the same one every few
   * seconds. Somewhere to report it and a rule for how often are the two
   * halves of "visible"; a report that repeats a hundred times is the silent
   * case with extra steps.
   */
  private raise(fault: BridgeFault): void {
    const repeated =
      this.fault !== null && faultIdentity(this.fault) === faultIdentity(fault);
    this.fault = fault;
    if (repeated) return;
    this.dependencies.report?.(fault);
  }

  private clearFault(): void {
    this.fault = null;
  }

  private handleClose(): void {
    this.socket = null;
    this.session.onSocketClosed();
    if (!this.dependencies.context()) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      100 * 2 ** Math.min(this.reconnectAttempt, 6),
    );
    this.reconnectTimer =
      this.dependencies.schedule?.(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay) ?? null;
    this.dependencies.log?.("reconnect_scheduled", {
      attempt: this.reconnectAttempt,
    });
  }

  private send(frame: string): void {
    if (!this.socket?.send(frame)) this.socket?.close();
  }
}
