//! Deterministic generator for the frozen Bridge v1 consumer artifacts.
//!
//! Rust protocol types own the schema and canonical fixture values. The
//! TypeScript module is emitted from that schema, so field names, variants,
//! and validation limits cannot silently drift in a second hand-maintained
//! contract.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use devhub_app_core::bridge::*;
use schemars::schema_for;
use serde_json::Value;

fn uuid(raw: &str) -> Uuid {
    Uuid::parse(raw).expect("generator UUID")
}

fn path(raw: &str) -> AbsolutePath {
    AbsolutePath::parse(raw).expect("generator path")
}

fn semver(raw: &str) -> SemVer {
    SemVer::parse(raw).expect("generator semver")
}

fn envelope(connection_id: Option<Uuid>, sequence: u64, id: &str, payload: Payload) -> Envelope {
    Envelope::new(connection_id, sequence, uuid(id), payload.kind(), payload)
        .expect("generator envelope")
}

fn valid_envelopes() -> Vec<Envelope> {
    let surface = uuid("11111111-1111-4111-8111-111111111111");
    let connection = uuid("55555555-5555-4555-8555-555555555555");
    let context = Context::workspace(
        uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        path("/tmp/devhub-bridge"),
    );
    vec![
        envelope(
            None,
            1,
            "33333333-3333-4333-8333-333333333333",
            Payload::Hello(HelloPayload {
                extension_version: semver("0.0.1"),
                surface_id: surface.clone(),
                workbench_instance_id: uuid("44444444-4444-4444-8444-444444444444"),
            }),
        ),
        envelope(
            Some(connection.clone()),
            1,
            "66666666-6666-4666-8666-666666666666",
            Payload::HelloAccepted(HelloAcceptedPayload {
                accepted_version: BRIDGE_PROTOCOL_VERSION,
                surface_id: surface.clone(),
                connection_generation: 1,
            }),
        ),
        envelope(
            Some(connection.clone()),
            2,
            "77777777-7777-4777-8777-777777777777",
            Payload::StateSnapshot(StateSnapshotPayload {
                surface_id: surface,
                readiness: Readiness::Ready,
                context: context.clone(),
                dirty: false,
            }),
        ),
        envelope(
            Some(connection.clone()),
            3,
            "88888888-8888-4888-8888-888888888888",
            Payload::ReadyChanged(ReadyChangedPayload { readiness: Readiness::Unavailable }),
        ),
        envelope(
            Some(connection.clone()),
            4,
            "99999999-9999-4999-8999-999999999999",
            Payload::IdentityChanged(IdentityChangedPayload { context: Context::Global }),
        ),
        envelope(
            Some(connection.clone()),
            5,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            Payload::DirtyChanged(DirtyChangedPayload { dirty: true }),
        ),
        envelope(
            Some(connection.clone()),
            6,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            Payload::OpenWorkspaceRequested(OpenWorkspaceRequestedPayload {
                absolute_path: path("/tmp/devhub-bridge"),
                source: OpenWorkspaceSource::OpenFolder,
            }),
        ),
        envelope(
            Some(connection.clone()),
            7,
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            Payload::NewWindowRequested(NewWindowRequestedPayload {
                absolute_path: None,
                source: NewWindowSource::Unknown,
            }),
        ),
        envelope(
            Some(connection.clone()),
            8,
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            Payload::RequestStateSnapshot(RequestStateSnapshotPayload {
                reason: SnapshotRequestReason::ManualTest,
            }),
        ),
        envelope(
            Some(connection.clone()),
            9,
            "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            Payload::Focus(FocusPayload { reason: FocusReason::Navigation }),
        ),
        envelope(
            Some(connection.clone()),
            10,
            "ffffffff-ffff-4fff-8fff-ffffffffffff",
            Payload::Response(ResponsePayload {
                request_message_id: uuid("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
                result: ResponseResult::SnapshotWillFollow,
            }),
        ),
        envelope(
            Some(connection.clone()),
            11,
            "12121212-1212-4121-8121-121212121212",
            Payload::Response(ResponsePayload {
                request_message_id: uuid("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
                result: ResponseResult::Focused,
            }),
        ),
        envelope(
            Some(connection),
            12,
            "13131313-1313-4131-8131-131313131313",
            Payload::Error(ErrorPayload {
                request_message_id: None,
                code: ErrorCode::ConnectionLost,
                summary: ContentFreeSummary::parse("connection lost").expect("summary"),
            }),
        ),
    ]
}

fn fixture_lines() -> (String, String) {
    let valid_values: Vec<Value> = valid_envelopes()
        .into_iter()
        .map(|envelope| serde_json::to_value(envelope).expect("serialize fixture"))
        .collect();
    let valid = valid_values
        .iter()
        .map(|value| serde_json::to_string(value).expect("serialize valid fixture"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";

    let mut unknown_field = valid_values[0].clone();
    unknown_field["payload"]["unknown"] = Value::Bool(true);
    let mut bad_id = valid_values[0].clone();
    bad_id["message_id"] = Value::String("33333333-3333-4333-8333-33333333333A".to_owned());
    let mut relative_path = valid_values[2].clone();
    relative_path["payload"]["context"]["canonical_root"] =
        Value::String("relative/path".to_owned());
    let mut dot_path = valid_values[2].clone();
    dot_path["payload"]["context"]["canonical_root"] = Value::String("/.".to_owned());
    let mut dotdot_path = valid_values[2].clone();
    dotdot_path["payload"]["context"]["canonical_root"] = Value::String("/..".to_owned());
    let mut duplicate_slash_path = valid_values[2].clone();
    duplicate_slash_path["payload"]["context"]["canonical_root"] =
        Value::String("/tmp//devhub-bridge".to_owned());
    let mut trailing_slash_path = valid_values[2].clone();
    trailing_slash_path["payload"]["context"]["canonical_root"] =
        Value::String("/tmp/devhub-bridge/".to_owned());
    let mut extra_envelope = valid_values[3].clone();
    extra_envelope["unknown"] = Value::Bool(true);
    let mut unknown_kind = valid_values[0].clone();
    unknown_kind["kind"] = Value::String("unknown_kind".to_owned());
    let mut missing_error_request_id = valid_values[12].clone();
    missing_error_request_id["payload"]
        .as_object_mut()
        .expect("error payload object")
        .remove("request_message_id");
    let mut missing_new_window_path = valid_values[7].clone();
    missing_new_window_path["payload"]
        .as_object_mut()
        .expect("new-window payload object")
        .remove("absolute_path");
    let mut missing_connection_id = valid_values[3].clone();
    missing_connection_id.as_object_mut().expect("envelope object").remove("connection_id");
    let invalid = [
        unknown_field,
        bad_id,
        relative_path,
        dot_path,
        dotdot_path,
        duplicate_slash_path,
        trailing_slash_path,
        extra_envelope,
        unknown_kind,
        missing_error_request_id,
        missing_new_window_path,
        missing_connection_id,
    ]
    .iter()
    .map(|value| serde_json::to_string(value).expect("serialize invalid fixture"))
    .collect::<Vec<_>>()
    .join("\n")
        + "\n";
    (valid, invalid)
}

fn schema() -> Value {
    let mut schema = serde_json::to_value(schema_for!(Envelope)).expect("serialize Rust schema");
    schema["$id"] =
        Value::String("https://devhub.local/contracts/bridge/bridge-v1.schema.json".to_owned());
    schema["title"] = Value::String("DevHub Bridge v1 envelope".to_owned());
    schema
}

fn ref_name(schema: &Value) -> Option<String> {
    schema
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|raw| raw.rsplit('/').next())
        .map(ToOwned::to_owned)
}

fn ts_name(name: &str) -> String {
    match name {
        "Uuid" => "UUID".to_owned(),
        "SemVer" => "SemVer".to_owned(),
        "AbsolutePath" => "AbsolutePath".to_owned(),
        "ContentFreeSummary" => "ContentFreeSummary".to_owned(),
        other => other.to_owned(),
    }
}

fn ts_string(value: &str) -> String {
    serde_json::to_string(value).expect("serialize TS string")
}

fn ts_type(schema: &Value) -> String {
    if let Some(name) = ref_name(schema) {
        return ts_name(&name);
    }
    if let Some(value) = schema.get("const") {
        return match value {
            Value::String(value) => ts_string(value),
            Value::Bool(value) => value.to_string(),
            Value::Number(value) => value.to_string(),
            _ => "unknown".to_owned(),
        };
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(values) = schema.get(key).and_then(Value::as_array) {
            return values.iter().map(ts_type).collect::<Vec<_>>().join(" | ");
        }
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => {
            if let Some(values) = schema.get("enum").and_then(Value::as_array) {
                return values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ts_string)
                    .collect::<Vec<_>>()
                    .join(" | ");
            }
            "string".to_owned()
        }
        Some("integer") | Some("number") => "number".to_owned(),
        Some("boolean") => "boolean".to_owned(),
        Some("null") => "null".to_owned(),
        Some("object") => {
            let properties = schema.get("properties").and_then(Value::as_object);
            let required = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default();
            let Some(properties) = properties else {
                return "Record<string, unknown>".to_owned();
            };
            let fields = properties
                .iter()
                .map(|(name, property)| {
                    let optional =
                        if required.iter().any(|required| required == name) { "" } else { "?" };
                    format!("  {name}{optional}: {};", ts_type(property))
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("{{\n{fields}\n}}")
        }
        _ => "unknown".to_owned(),
    }
}

fn generated_typescript(schema: &Value) -> String {
    let defs = schema["$defs"].as_object().expect("Rust schema definitions");
    let mut output = String::from(
        "/** Generated from Rust bridge protocol types; do not edit by hand. */\n/* eslint-disable @typescript-eslint/no-explicit-any, no-empty */\n\n",
    );
    output.push_str(&format!(
        "export const BRIDGE_PROTOCOL_VERSION = {} as const;\nexport const MAX_MESSAGE_BYTES = {} as const;\nexport const MAX_SAFE_INTEGER = {} as const;\n\n",
        BRIDGE_PROTOCOL_VERSION, MAX_MESSAGE_BYTES, MAX_SAFE_INTEGER
    ));
    for (name, definition) in defs {
        let name = ts_name(name);
        if name == "MessageKind" {
            continue;
        }
        if name == "ContentFreeSummary" && definition.get("enum").is_some() {
            output.push_str(&format!("export type {name} = {};\n", ts_type(definition)));
        } else if ["UUID", "SemVer", "AbsolutePath"].contains(&name.as_str()) {
            let brand = match name.as_str() {
                "UUID" => "__devhubUuid",
                "SemVer" => "__devhubSemVer",
                "AbsolutePath" => "__devhubAbsolutePath",
                _ => unreachable!("handled special bridge type"),
            };
            output.push_str(&format!(
                "export type {name} = string & {{ readonly {brand}: unique symbol }};\n"
            ));
        } else if definition.get("type") == Some(&Value::String("object".to_owned())) {
            output.push_str(&format!("export interface {name} {}\n", ts_type(definition)));
        } else {
            output.push_str(&format!("export type {name} = {};\n", ts_type(definition)));
        }
    }
    let kinds = MessageKind::ALL;
    let kind_values = kinds.iter().map(|kind| ts_string(kind)).collect::<Vec<_>>().join(" | ");
    output.push_str(&format!("export type MessageKind = {kind_values};\n"));
    output.push_str("export type PayloadForKind<K extends MessageKind> =\n");
    for (index, kind) in kinds.iter().enumerate() {
        let payload_schema = schema["allOf"]
            .as_array()
            .expect("envelope conditions")
            .iter()
            .find(|condition| condition["if"]["properties"]["kind"]["const"] == *kind)
            .expect("payload condition")["then"]["properties"]["payload"]
            .clone();
        let payload_name = ref_name(&payload_schema).expect("payload ref");
        let separator = if index + 1 == kinds.len() { "" } else { " :" };
        output.push_str(&format!(
            "  K extends {} ? {}{separator}\n",
            ts_string(kind),
            ts_name(&payload_name)
        ));
    }
    output.push_str(
        "  : never;\n\nexport interface Envelope<K extends MessageKind = MessageKind> {\n",
    );
    let envelope_properties = schema["properties"].as_object().expect("envelope properties");
    let envelope_required = schema["required"]
        .as_array()
        .expect("envelope required")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    for (name, property) in envelope_properties {
        let optional =
            if envelope_required.iter().any(|required| required == name) { "" } else { "?" };
        let property_type = match name.as_str() {
            "kind" => "K".to_owned(),
            "payload" => "PayloadForKind<K>".to_owned(),
            _ => ts_type(property),
        };
        output.push_str(&format!("  {name}{optional}: {property_type};\n"));
    }
    output.push_str("}\n\n");
    output.push_str("const BRIDGE_SCHEMA = ");
    output.push_str(&serde_json::to_string(schema).expect("serialize embedded schema"));
    output.push_str(" as const;\n\n");
    output.push_str(TS_VALIDATOR_RUNTIME);
    output
}

const TS_VALIDATOR_RUNTIME: &str = r#"type Schema = Record<string, any>;

function resolve(ref: string): Schema {
  const parts = ref.replace(/^#\//, "").split("/");
  let value: any = BRIDGE_SCHEMA;
  for (const part of parts) value = value[part];
  return value;
}

function check(schema: Schema, value: unknown): void {
  if (schema.$ref) return check(resolve(schema.$ref), value);
  if ("const" in schema && value !== schema.const) throw new Error("constant mismatch");
  if (Array.isArray(schema.enum) && !schema.enum.some((entry: unknown) => Object.is(entry, value))) throw new Error("enum mismatch");
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) {
      let passed = 0;
      for (const candidate of schema[key]) { try { check(candidate, value); passed++; } catch {} }
      if (key === "anyOf" ? passed < 1 : passed !== 1) throw new Error(`${key} mismatch`);
    }
  }
  if (Array.isArray(schema.allOf)) for (const candidate of schema.allOf) {
    if (candidate.if) { try { check(candidate.if, value); } catch { continue; } check(candidate.then, value); }
    else check(candidate, value);
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("object expected");
    const item = value as Record<string, unknown>;
    for (const required of schema.required ?? []) if (!(required in item)) throw new Error("missing field");
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) for (const key of Object.keys(item)) if (!(key in properties)) throw new Error("unknown field");
    for (const [key, property] of Object.entries(properties)) if (key in item) check(property as Schema, item[key]);
  } else if (schema.properties && typeof value === "object" && value !== null) {
    for (const [key, property] of Object.entries(schema.properties)) if (key in (value as any)) check(property as Schema, (value as any)[key]);
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error("string expected");
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) throw new Error("pattern mismatch");
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) throw new Error("string too long");
  } else if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("safe integer expected");
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error("number too small");
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error("number too large");
  } else if (schema.type === "boolean" && typeof value !== "boolean") throw new Error("boolean expected");
}

export function validateEnvelope(value: unknown): Envelope {
  check(BRIDGE_SCHEMA, value);
  return value as Envelope;
}

export function parseEnvelope(raw: string): Envelope {
  if (new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) throw new Error("message exceeds 256 KiB");
  return validateEnvelope(JSON.parse(raw) as unknown);
}

export function encodeEnvelope(value: Envelope): string {
  const encoded = JSON.stringify(validateEnvelope(value));
  if (new TextEncoder().encode(encoded).length > MAX_MESSAGE_BYTES) throw new Error("message exceeds 256 KiB");
  return encoded;
}

export function isEnvelope(value: unknown): value is Envelope {
  try { validateEnvelope(value); return true; } catch { return false; }
}
"#;

fn outputs(root: &Path) -> Vec<(PathBuf, String)> {
    let schema = schema();
    let (valid, invalid) = fixture_lines();
    vec![
        (
            root.join("contracts/bridge/bridge-v1.schema.json"),
            format!("{}\n", serde_json::to_string_pretty(&schema).expect("schema JSON")),
        ),
        (root.join("contracts/bridge/valid.ndjson"), valid),
        (root.join("contracts/bridge/invalid.ndjson"), invalid),
        (
            root.join("extensions/devhub-bridge/src/generated/bridge/index.ts"),
            generated_typescript(&schema),
        ),
    ]
}

fn main() {
    let check = env::args().skip(1).any(|argument| argument == "--check");
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir.parent().and_then(Path::parent).expect("workspace root");
    let mut failed = false;
    for (path, contents) in outputs(root) {
        if check {
            match fs::read_to_string(&path) {
                Ok(actual) if actual == contents => {}
                Ok(_) => {
                    eprintln!("generated bridge artifact differs: {}", path.display());
                    failed = true;
                }
                Err(error) => {
                    eprintln!("missing generated bridge artifact {}: {error}", path.display());
                    failed = true;
                }
            }
        } else {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create generated artifact directory");
            }
            fs::write(&path, contents).expect("write generated bridge artifact");
        }
    }
    if failed {
        std::process::exit(1);
    }
}
