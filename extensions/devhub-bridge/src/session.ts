import {
  BRIDGE_PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  MAX_SAFE_INTEGER,
  encodeEnvelope,
  parseEnvelope,
  type Context,
  type Envelope,
  type Readiness,
} from "../../../apps/devhub/src/generated/bridge/index";

export interface SessionConfig {
  surfaceId: string;
  extensionVersion: string;
  workbenchInstanceId: string;
  createMessageId?: () => string;
}

export interface SessionState {
  readiness: Readiness;
  context: Context;
  dirty: boolean;
}

export interface SessionActions {
  frames: string[];
  close: boolean;
  connected: boolean;
}

type Message = Envelope & { payload: Record<string, unknown> };

function newMessageId(): string {
  throw new Error("secure identifier source unavailable");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Pure Bridge state machine. Transport and VS Code objects stay outside this
 * module; all wire validation is delegated to the Rust-generated contract.
 */
export class BridgeSession {
  private readonly config: SessionConfig;
  private readonly createMessageId: () => string;
  private clientSequence = 0;
  private hostSequence = 0;
  private lastHostMessageId: string | null = null;
  private lastHostFingerprint: string | null = null;
  private connectionId: string | null = null;
  private connected = false;
  private connectionGeneration = 0;
  private lastGeneration = 0;
  private state: SessionState = {
    readiness: "starting",
    context: { kind: "global" },
    dirty: false,
  };
  private readonly requestLedger = new Map<
    string,
    {
      kind: Message["kind"];
      payload: Record<string, unknown>;
      result: Record<string, unknown>;
      response: string;
      generation: number;
    }
  >();
  private readonly requestOrder: string[] = [];

  public constructor(config: SessionConfig) {
    this.config = config;
    this.createMessageId = config.createMessageId ?? newMessageId;
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  public get generation(): number {
    return this.connectionGeneration;
  }

  public get nextClientSequence(): number {
    return this.clientSequence + 1;
  }

  public setState(next: SessionState): void {
    this.state = next;
  }

  public onSocketOpen(): SessionActions {
    this.connected = false;
    this.connectionId = null;
    this.clientSequence = 0;
    this.hostSequence = 0;
    this.lastHostMessageId = null;
    this.lastHostFingerprint = null;
    this.state = { ...this.state, readiness: "starting" };
    return {
      frames: [
        this.encode("hello", {
          extension_version: this.config.extensionVersion,
          surface_id: this.config.surfaceId,
          workbench_instance_id: this.config.workbenchInstanceId,
        }),
      ],
      close: false,
      connected: false,
    };
  }

  public onSocketClosed(): void {
    this.connected = false;
    this.connectionId = null;
    this.clientSequence = 0;
    this.hostSequence = 0;
    this.lastHostMessageId = null;
    this.lastHostFingerprint = null;
    this.state = { ...this.state, readiness: "unavailable" };
  }

  public sendSnapshot(): string | null {
    return this.connected
      ? this.encode("state_snapshot", {
          surface_id: this.config.surfaceId,
          readiness: this.state.readiness,
          context: this.state.context,
          dirty: this.state.dirty,
        })
      : null;
  }

  public sendDirty(dirty: boolean): string | null {
    if (this.state.dirty === dirty) return null;
    const connected = this.connected;
    this.state = { ...this.state, dirty };
    return connected ? this.encode("dirty_changed", { dirty }) : null;
  }

  public sendIdentity(context: Context): string | null {
    if (sameJson(this.state.context, context)) return null;
    const connected = this.connected;
    this.state = { ...this.state, context };
    return connected ? this.encode("identity_changed", { context }) : null;
  }

  public sendReadiness(readiness: Readiness): string | null {
    if (this.state.readiness === readiness) return null;
    const connected = this.connected;
    this.state = { ...this.state, readiness };
    return connected ? this.encode("ready_changed", { readiness }) : null;
  }

  public sendOpenWorkspace(
    path: string,
    source: "open_folder" | "open_workspace" | "external_uri",
  ): string | null {
    return this.connected
      ? this.encode("open_workspace_requested", {
          absolute_path: path,
          source,
        })
      : null;
  }

  public sendNewWindow(
    path: string | null,
    source: "command" | "external_uri" | "unknown",
  ): string | null {
    return this.connected
      ? this.encode("new_window_requested", {
          absolute_path: path,
          source,
        })
      : null;
  }

  public onHostFrame(raw: string): SessionActions {
    if (new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) {
      return this.closeActions();
    }
    let message: Message;
    try {
      message = parseEnvelope(raw) as Message;
    } catch {
      return this.closeActions();
    }

    if (!this.connected) {
      if (
        message.kind !== "hello_accepted" ||
        message.sequence !== 1 ||
        !message.connection_id
      ) {
        return this.closeActions();
      }
      const generation = message.payload.connection_generation;
      if (
        message.payload.surface_id !== this.config.surfaceId ||
        typeof generation !== "number" ||
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        generation <= this.lastGeneration
      ) {
        return this.closeActions();
      }
      this.connectionId = message.connection_id;
      this.connectionGeneration = generation;
      this.lastGeneration = generation;
      this.connected = true;
      this.state = { ...this.state, readiness: "ready" };
      this.hostSequence = 1;
      this.lastHostMessageId = message.message_id;
      this.lastHostFingerprint = fingerprint(message);
      const snapshot = this.sendSnapshot();
      return {
        frames: snapshot ? [snapshot] : [],
        close: false,
        connected: true,
      };
    }

    if (message.connection_id !== this.connectionId) return this.closeActions();
    if (message.sequence === this.hostSequence) {
      if (
        message.message_id !== this.lastHostMessageId ||
        fingerprint(message) !== this.lastHostFingerprint
      )
        return this.closeActions();
      const cached = this.requestLedger.get(message.message_id);
      return cached
        ? { frames: [cached.response], close: false, connected: true }
        : { frames: [], close: false, connected: true };
    }
    if (message.sequence !== this.hostSequence + 1) return this.closeActions();
    this.hostSequence = message.sequence;
    this.lastHostMessageId = message.message_id;
    this.lastHostFingerprint = fingerprint(message);

    if (message.kind === "error") {
      return { frames: [], close: false, connected: true };
    }
    if (message.kind !== "request_state_snapshot" && message.kind !== "focus") {
      return this.closeActions();
    }

    const previous = this.requestLedger.get(message.message_id);
    if (previous) {
      if (
        previous.kind !== message.kind ||
        !sameJson(previous.payload, message.payload)
      )
        return this.closeActions();
      if (previous.generation === this.connectionGeneration) {
        return { frames: [previous.response], close: false, connected: true };
      }
      const response = this.encode("response", {
        request_message_id: message.message_id,
        result: previous.result,
      });
      previous.response = response;
      previous.generation = this.connectionGeneration;
      const frames = [response];
      if (message.kind === "request_state_snapshot") {
        const snapshot = this.sendSnapshot();
        if (snapshot) frames.push(snapshot);
      }
      return { frames, close: false, connected: true };
    }

    const result =
      message.kind === "focus"
        ? { kind: "focused" }
        : { kind: "snapshot_will_follow" };
    const response = this.encode("response", {
      request_message_id: message.message_id,
      result,
    });
    this.requestLedger.set(message.message_id, {
      kind: message.kind,
      payload: message.payload,
      result,
      response,
      generation: this.connectionGeneration,
    });
    this.requestOrder.push(message.message_id);
    while (this.requestOrder.length > 1_024) {
      const oldest = this.requestOrder.shift();
      if (oldest) this.requestLedger.delete(oldest);
    }
    const frames = [response];
    if (message.kind === "request_state_snapshot") {
      const snapshot = this.sendSnapshot();
      if (snapshot) frames.push(snapshot);
    }
    return { frames, close: false, connected: true };
  }

  private encode(
    kind: Message["kind"],
    payload: Record<string, unknown>,
  ): string {
    if (this.clientSequence >= MAX_SAFE_INTEGER) {
      throw new Error("bridge sequence exhausted");
    }
    this.clientSequence += 1;
    return encodeEnvelope({
      version: BRIDGE_PROTOCOL_VERSION,
      connection_id: this.connectionId,
      sequence: this.clientSequence,
      message_id: this.createMessageId(),
      kind,
      payload,
    } as never);
  }

  private closeActions(): SessionActions {
    this.onSocketClosed();
    return { frames: [], close: true, connected: false };
  }
}

function fingerprint(message: Message): string {
  return JSON.stringify({ kind: message.kind, payload: message.payload });
}
