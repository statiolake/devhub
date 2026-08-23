import type {
  AbsolutePath,
  Context,
} from "../../../apps/devhub/src/generated/bridge/index";
import type { OpenWorkspaceSource } from "../../../apps/devhub/src/generated/bridge/index";
import { BridgeSession } from "./session";

const MAX_RECONNECT_DELAY_MS = 5_000;

export interface ControllerSocketHandlers {
  onOpen: () => void;
  onMessage: (raw: string) => void;
  onError: () => void;
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
            const actions = this.session.onSocketOpen();
            actions.frames.forEach((frame) => this.send(frame));
          },
          onMessage: (raw) => this.handleHostMessage(raw),
          onError: () => {
            this.dependencies.log?.("endpoint_error");
            this.socket?.close();
          },
          onClose: () => this.handleClose(),
        },
      );
      this.socket.open();
    } catch {
      this.socket = null;
      this.scheduleReconnect();
    }
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
