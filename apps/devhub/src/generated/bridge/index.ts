/** Generated from Rust bridge protocol types; do not edit by hand. */
/* eslint-disable @typescript-eslint/no-explicit-any, no-empty */

export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const MAX_MESSAGE_BYTES = 262144 as const;
export const MAX_SAFE_INTEGER = 9007199254740991 as const;

export type AbsolutePath = string & {
  readonly __devhubAbsolutePath: unique symbol;
};
export type ContentFreeSummary =
  | "invalid bridge message"
  | "invalid bridge identity"
  | "unsupported bridge protocol version"
  | "bridge sequence error"
  | "message exceeds the maximum encoded size"
  | "secure identifier source unavailable"
  | "connection lost"
  | "bridge request timed out"
  | "invalid hello acceptance"
  | "response has no pending request"
  | "response result is invalid"
  | "error has no pending request"
  | "unknown host request"
  | "failed";
export type Context =
  | {
      kind: "global";
    }
  | {
      canonical_root: AbsolutePath;
      kind: "workspace";
      workspace_id: UUID;
    };
export interface DirtyChangedPayload {
  dirty: boolean;
}
export type ErrorCode =
  | "unsupported_version"
  | "invalid_identity"
  | "invalid_message"
  | "sequence_error"
  | "payload_too_large"
  | "surface_unavailable"
  | "request_failed"
  | "request_cancelled"
  | "bridge_timeout"
  | "connection_lost";
export interface ErrorPayload {
  code: ErrorCode;
  request_message_id: UUID | null;
  summary: ContentFreeSummary;
}
export interface FocusPayload {
  reason: FocusReason;
}
export type FocusReason = "navigation" | "window_restore";
export interface HelloAcceptedPayload {
  accepted_version: 1;
  connection_generation: number;
  surface_id: UUID;
}
export interface HelloPayload {
  extension_version: SemVer;
  surface_id: UUID;
  workbench_instance_id: UUID;
}
export interface IdentityChangedPayload {
  context: Context;
}
export interface NewWindowRequestedPayload {
  absolute_path: AbsolutePath | null;
  source: NewWindowSource;
}
export type NewWindowSource = "command" | "external_uri" | "unknown";
export interface OpenWorkspaceRequestedPayload {
  absolute_path: AbsolutePath;
  source: OpenWorkspaceSource;
}
export type OpenWorkspaceSource =
  "open_folder" | "open_workspace" | "external_uri";
export type Payload =
  | HelloPayload
  | HelloAcceptedPayload
  | StateSnapshotPayload
  | ReadyChangedPayload
  | IdentityChangedPayload
  | DirtyChangedPayload
  | OpenWorkspaceRequestedPayload
  | NewWindowRequestedPayload
  | RequestStateSnapshotPayload
  | FocusPayload
  | ResponsePayload
  | ErrorPayload;
export type Readiness = "starting" | "ready" | "unavailable";
export interface ReadyChangedPayload {
  readiness: Readiness;
}
export interface RequestStateSnapshotPayload {
  reason: SnapshotRequestReason;
}
export interface ResponsePayload {
  request_message_id: UUID;
  result: ResponseResult;
}
export type ResponseResult =
  | {
      context: {
        canonical_root: AbsolutePath;
        kind: "workspace";
        workspace_id: UUID;
      };
      kind: "workspace_routed";
    }
  | {
      context: {
        kind: "global";
      };
      kind: "global_routed";
    }
  | {
      kind: "snapshot_will_follow";
    }
  | {
      kind: "focused";
    };
export type SemVer = string & { readonly __devhubSemVer: unique symbol };
export type SnapshotRequestReason = "host_reconcile" | "manual_test";
export interface StateSnapshotPayload {
  context: Context;
  dirty: boolean;
  readiness: Readiness;
  surface_id: UUID;
}
export type UUID = string & { readonly __devhubUuid: unique symbol };
export type MessageKind =
  | "hello"
  | "hello_accepted"
  | "state_snapshot"
  | "ready_changed"
  | "identity_changed"
  | "dirty_changed"
  | "open_workspace_requested"
  | "new_window_requested"
  | "request_state_snapshot"
  | "focus"
  | "response"
  | "error";
export type PayloadForKind<K extends MessageKind> = K extends "hello"
  ? HelloPayload
  : K extends "hello_accepted"
    ? HelloAcceptedPayload
    : K extends "state_snapshot"
      ? StateSnapshotPayload
      : K extends "ready_changed"
        ? ReadyChangedPayload
        : K extends "identity_changed"
          ? IdentityChangedPayload
          : K extends "dirty_changed"
            ? DirtyChangedPayload
            : K extends "open_workspace_requested"
              ? OpenWorkspaceRequestedPayload
              : K extends "new_window_requested"
                ? NewWindowRequestedPayload
                : K extends "request_state_snapshot"
                  ? RequestStateSnapshotPayload
                  : K extends "focus"
                    ? FocusPayload
                    : K extends "response"
                      ? ResponsePayload
                      : K extends "error"
                        ? ErrorPayload
                        : never;

export interface Envelope<K extends MessageKind = MessageKind> {
  connection_id: null | UUID;
  kind: K;
  message_id: UUID;
  payload: PayloadForKind<K>;
  sequence: number;
  version: 1;
}

const BRIDGE_SCHEMA = {
  $defs: {
    AbsolutePath: {
      pattern:
        "^/(?!$)(?!.*//)(?!\\.(?:/|$))(?!\\.\\.(?:/|$))(?!.*\\/\\.(?:\\/|$))(?!.*\\/\\.\\.(?:\\/|$))(?!.*\\/$)[^\\u0000]*$|^/$",
      type: "string",
    },
    ContentFreeSummary: {
      enum: [
        "invalid bridge message",
        "invalid bridge identity",
        "unsupported bridge protocol version",
        "bridge sequence error",
        "message exceeds the maximum encoded size",
        "secure identifier source unavailable",
        "connection lost",
        "bridge request timed out",
        "invalid hello acceptance",
        "response has no pending request",
        "response result is invalid",
        "error has no pending request",
        "unknown host request",
        "failed",
      ],
      type: "string",
    },
    Context: {
      oneOf: [
        {
          additionalProperties: false,
          properties: { kind: { const: "global" } },
          required: ["kind"],
          type: "object",
        },
        {
          additionalProperties: false,
          properties: {
            canonical_root: { $ref: "#/$defs/AbsolutePath" },
            kind: { const: "workspace" },
            workspace_id: { $ref: "#/$defs/Uuid" },
          },
          required: ["kind", "workspace_id", "canonical_root"],
          type: "object",
        },
      ],
    },
    DirtyChangedPayload: {
      additionalProperties: false,
      properties: { dirty: { type: "boolean" } },
      required: ["dirty"],
      type: "object",
    },
    ErrorCode: {
      enum: [
        "unsupported_version",
        "invalid_identity",
        "invalid_message",
        "sequence_error",
        "payload_too_large",
        "surface_unavailable",
        "request_failed",
        "request_cancelled",
        "bridge_timeout",
        "connection_lost",
      ],
      type: "string",
    },
    ErrorPayload: {
      additionalProperties: false,
      properties: {
        code: { $ref: "#/$defs/ErrorCode" },
        request_message_id: {
          anyOf: [{ $ref: "#/$defs/Uuid" }, { type: "null" }],
        },
        summary: { $ref: "#/$defs/ContentFreeSummary" },
      },
      required: ["request_message_id", "code", "summary"],
      type: "object",
    },
    FocusPayload: {
      additionalProperties: false,
      properties: { reason: { $ref: "#/$defs/FocusReason" } },
      required: ["reason"],
      type: "object",
    },
    FocusReason: { enum: ["navigation", "window_restore"], type: "string" },
    HelloAcceptedPayload: {
      additionalProperties: false,
      properties: {
        accepted_version: { const: 1 },
        connection_generation: {
          maximum: 9007199254740991,
          minimum: 1,
          type: "integer",
        },
        surface_id: { $ref: "#/$defs/Uuid" },
      },
      required: ["accepted_version", "surface_id", "connection_generation"],
      type: "object",
    },
    HelloPayload: {
      additionalProperties: false,
      properties: {
        extension_version: { $ref: "#/$defs/SemVer" },
        surface_id: { $ref: "#/$defs/Uuid" },
        workbench_instance_id: { $ref: "#/$defs/Uuid" },
      },
      required: ["extension_version", "surface_id", "workbench_instance_id"],
      type: "object",
    },
    IdentityChangedPayload: {
      additionalProperties: false,
      properties: { context: { $ref: "#/$defs/Context" } },
      required: ["context"],
      type: "object",
    },
    MessageKind: {
      enum: [
        "hello",
        "hello_accepted",
        "state_snapshot",
        "ready_changed",
        "identity_changed",
        "dirty_changed",
        "open_workspace_requested",
        "new_window_requested",
        "request_state_snapshot",
        "focus",
        "response",
        "error",
      ],
      type: "string",
    },
    NewWindowRequestedPayload: {
      additionalProperties: false,
      properties: {
        absolute_path: {
          anyOf: [{ $ref: "#/$defs/AbsolutePath" }, { type: "null" }],
        },
        source: { $ref: "#/$defs/NewWindowSource" },
      },
      required: ["absolute_path", "source"],
      type: "object",
    },
    NewWindowSource: {
      enum: ["command", "external_uri", "unknown"],
      type: "string",
    },
    OpenWorkspaceRequestedPayload: {
      additionalProperties: false,
      properties: {
        absolute_path: { $ref: "#/$defs/AbsolutePath" },
        source: { $ref: "#/$defs/OpenWorkspaceSource" },
      },
      required: ["absolute_path", "source"],
      type: "object",
    },
    OpenWorkspaceSource: {
      enum: ["open_folder", "open_workspace", "external_uri"],
      type: "string",
    },
    Payload: {
      oneOf: [
        { $ref: "#/$defs/HelloPayload" },
        { $ref: "#/$defs/HelloAcceptedPayload" },
        { $ref: "#/$defs/StateSnapshotPayload" },
        { $ref: "#/$defs/ReadyChangedPayload" },
        { $ref: "#/$defs/IdentityChangedPayload" },
        { $ref: "#/$defs/DirtyChangedPayload" },
        { $ref: "#/$defs/OpenWorkspaceRequestedPayload" },
        { $ref: "#/$defs/NewWindowRequestedPayload" },
        { $ref: "#/$defs/RequestStateSnapshotPayload" },
        { $ref: "#/$defs/FocusPayload" },
        { $ref: "#/$defs/ResponsePayload" },
        { $ref: "#/$defs/ErrorPayload" },
      ],
    },
    Readiness: {
      description: "Bridge readiness reported by the Workbench.",
      enum: ["starting", "ready", "unavailable"],
      type: "string",
    },
    ReadyChangedPayload: {
      additionalProperties: false,
      properties: { readiness: { $ref: "#/$defs/Readiness" } },
      required: ["readiness"],
      type: "object",
    },
    RequestStateSnapshotPayload: {
      additionalProperties: false,
      properties: { reason: { $ref: "#/$defs/SnapshotRequestReason" } },
      required: ["reason"],
      type: "object",
    },
    ResponsePayload: {
      additionalProperties: false,
      properties: {
        request_message_id: { $ref: "#/$defs/Uuid" },
        result: { $ref: "#/$defs/ResponseResult" },
      },
      required: ["request_message_id", "result"],
      type: "object",
    },
    ResponseResult: {
      oneOf: [
        {
          additionalProperties: false,
          properties: {
            context: {
              additionalProperties: false,
              properties: {
                canonical_root: { $ref: "#/$defs/AbsolutePath" },
                kind: { const: "workspace" },
                workspace_id: { $ref: "#/$defs/Uuid" },
              },
              required: ["kind", "workspace_id", "canonical_root"],
              type: "object",
            },
            kind: { const: "workspace_routed" },
          },
          required: ["kind", "context"],
          type: "object",
        },
        {
          additionalProperties: false,
          properties: {
            context: {
              additionalProperties: false,
              properties: { kind: { const: "global" } },
              required: ["kind"],
              type: "object",
            },
            kind: { const: "global_routed" },
          },
          required: ["kind", "context"],
          type: "object",
        },
        {
          additionalProperties: false,
          properties: { kind: { const: "snapshot_will_follow" } },
          required: ["kind"],
          type: "object",
        },
        {
          additionalProperties: false,
          properties: { kind: { const: "focused" } },
          required: ["kind"],
          type: "object",
        },
      ],
    },
    SemVer: {
      pattern:
        "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
      type: "string",
    },
    SnapshotRequestReason: {
      enum: ["host_reconcile", "manual_test"],
      type: "string",
    },
    StateSnapshotPayload: {
      additionalProperties: false,
      properties: {
        context: { $ref: "#/$defs/Context" },
        dirty: { type: "boolean" },
        readiness: { $ref: "#/$defs/Readiness" },
        surface_id: { $ref: "#/$defs/Uuid" },
      },
      required: ["surface_id", "readiness", "context", "dirty"],
      type: "object",
    },
    Uuid: {
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      type: "string",
    },
  },
  $id: "https://devhub.local/contracts/bridge/bridge-v1.schema.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { kind: { const: "hello" } } },
      then: {
        properties: {
          connection_id: { const: null },
          payload: { $ref: "#/$defs/HelloPayload" },
          sequence: { const: 1 },
        },
      },
    },
    {
      if: { properties: { kind: { const: "hello_accepted" } } },
      then: {
        properties: {
          connection_id: { $ref: "#/$defs/Uuid" },
          payload: { $ref: "#/$defs/HelloAcceptedPayload" },
          sequence: { const: 1 },
        },
      },
    },
    {
      if: { properties: { kind: { const: "state_snapshot" } } },
      then: {
        properties: {
          connection_id: { $ref: "#/$defs/Uuid" },
          payload: { $ref: "#/$defs/StateSnapshotPayload" },
        },
      },
    },
    {
      if: { properties: { kind: { const: "ready_changed" } } },
      then: {
        properties: {
          connection_id: { $ref: "#/$defs/Uuid" },
          payload: { $ref: "#/$defs/ReadyChangedPayload" },
        },
      },
    },
    {
      if: { properties: { kind: { const: "identity_changed" } } },
      then: {
        properties: {
          connection_id: { $ref: "#/$defs/Uuid" },
          payload: { $ref: "#/$defs/IdentityChangedPayload" },
        },
      },
    },
    {
      if: { properties: { kind: { const: "dirty_changed" } } },
      then: {
        properties: {
          connection_id: { $ref: "#/$defs/Uuid" },
          payload: { $ref: "#/$defs/DirtyChangedPayload" },
        },
      },
    },
    {
      if: { properties: { kind: { const: "open_workspace_requested" } } },
      then: {
        properties: {
          connection_id: { $ref: "#/$defs/Uuid" },
          payload: { $ref: "#/$defs/OpenWorkspaceRequestedPayload" },
        },
      },
    },
    {
      if: { properties: { kind: { const: "new_window_requested" } } },
      then: {
        properties: {
          connection_id: { $ref: "#/$defs/Uuid" },
          payload: { $ref: "#/$defs/NewWindowRequestedPayload" },
        },
      },
    },
    {
      if: { properties: { kind: { const: "request_state_snapshot" } } },
      then: {
        properties: {
          connection_id: { $ref: "#/$defs/Uuid" },
          payload: { $ref: "#/$defs/RequestStateSnapshotPayload" },
        },
      },
    },
    {
      if: { properties: { kind: { const: "focus" } } },
      then: {
        properties: {
          connection_id: { $ref: "#/$defs/Uuid" },
          payload: { $ref: "#/$defs/FocusPayload" },
        },
      },
    },
    {
      if: { properties: { kind: { const: "response" } } },
      then: {
        properties: {
          connection_id: { $ref: "#/$defs/Uuid" },
          payload: { $ref: "#/$defs/ResponsePayload" },
        },
      },
    },
    {
      if: { properties: { kind: { const: "error" } } },
      then: {
        properties: {
          connection_id: { $ref: "#/$defs/Uuid" },
          payload: { $ref: "#/$defs/ErrorPayload" },
        },
      },
    },
  ],
  properties: {
    connection_id: { anyOf: [{ type: "null" }, { $ref: "#/$defs/Uuid" }] },
    kind: { $ref: "#/$defs/MessageKind" },
    message_id: { $ref: "#/$defs/Uuid" },
    payload: { $ref: "#/$defs/Payload" },
    sequence: { maximum: 9007199254740991, minimum: 1, type: "integer" },
    version: { const: 1 },
  },
  required: [
    "version",
    "connection_id",
    "sequence",
    "message_id",
    "kind",
    "payload",
  ],
  title: "DevHub Bridge v1 envelope",
  type: "object",
} as const;

type Schema = Record<string, any>;

function resolve(ref: string): Schema {
  const parts = ref.replace(/^#\//, "").split("/");
  let value: any = BRIDGE_SCHEMA;
  for (const part of parts) value = value[part];
  return value;
}

function check(schema: Schema, value: unknown): void {
  if (schema.$ref) return check(resolve(schema.$ref), value);
  if ("const" in schema && value !== schema.const)
    throw new Error("constant mismatch");
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry: unknown) => Object.is(entry, value))
  )
    throw new Error("enum mismatch");
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) {
      let passed = 0;
      for (const candidate of schema[key]) {
        try {
          check(candidate, value);
          passed++;
        } catch {}
      }
      if (key === "anyOf" ? passed < 1 : passed !== 1)
        throw new Error(`${key} mismatch`);
    }
  }
  if (Array.isArray(schema.allOf))
    for (const candidate of schema.allOf) {
      if (candidate.if) {
        try {
          check(candidate.if, value);
        } catch {
          continue;
        }
        check(candidate.then, value);
      } else check(candidate, value);
    }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("object expected");
    const item = value as Record<string, unknown>;
    for (const required of schema.required ?? [])
      if (!(required in item)) throw new Error("missing field");
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false)
      for (const key of Object.keys(item))
        if (!(key in properties)) throw new Error("unknown field");
    for (const [key, property] of Object.entries(properties))
      if (key in item) check(property as Schema, item[key]);
  } else if (schema.properties && typeof value === "object" && value !== null) {
    for (const [key, property] of Object.entries(schema.properties))
      if (key in (value as any)) check(property as Schema, (value as any)[key]);
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error("string expected");
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      throw new Error("pattern mismatch");
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength)
      throw new Error("string too long");
  } else if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      throw new Error("safe integer expected");
    if (schema.minimum !== undefined && value < schema.minimum)
      throw new Error("number too small");
    if (schema.maximum !== undefined && value > schema.maximum)
      throw new Error("number too large");
  } else if (schema.type === "boolean" && typeof value !== "boolean")
    throw new Error("boolean expected");
}

export function validateEnvelope(value: unknown): Envelope {
  check(BRIDGE_SCHEMA, value);
  return value as Envelope;
}

export function parseEnvelope(raw: string): Envelope {
  if (new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES)
    throw new Error("message exceeds 256 KiB");
  return validateEnvelope(JSON.parse(raw) as unknown);
}

export function encodeEnvelope(value: Envelope): string {
  const encoded = JSON.stringify(validateEnvelope(value));
  if (new TextEncoder().encode(encoded).length > MAX_MESSAGE_BYTES)
    throw new Error("message exceeds 256 KiB");
  return encoded;
}

export function isEnvelope(value: unknown): value is Envelope {
  try {
    validateEnvelope(value);
    return true;
  } catch {
    return false;
  }
}
