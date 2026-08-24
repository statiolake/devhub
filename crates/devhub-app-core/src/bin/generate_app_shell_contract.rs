//! Generate the App Shell v1 schema, shared fixtures, and TypeScript seam.
//!
//! Rust wire DTOs are the source of truth. `--check` is used by the normal
//! repository check so the generated TypeScript/parser cannot drift silently.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use devhub_app_core::shell::*;
use devhub_app_core::{
    AppModel, AppReadiness, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH,
};
use schemars::schema_for;
use serde_json::{json, Map, Value};

fn root_schema<T: schemars::JsonSchema>() -> Value {
    serde_json::to_value(schema_for!(T)).expect("serialize App Shell schema")
}

fn contract_schema() -> Value {
    let roots = [
        ("AppSnapshotWire", root_schema::<AppSnapshotWire>()),
        ("AgentProfilesWire", root_schema::<AgentProfilesWire>()),
        ("AppAppearanceWire", root_schema::<AppAppearanceWire>()),
        ("AppIntentWire", root_schema::<AppIntentWire>()),
        ("AppOutcomeWire", root_schema::<AppOutcomeWire>()),
        ("WorkspacePickerEventWire", root_schema::<WorkspacePickerEventWire>()),
        ("AppErrorWire", root_schema::<AppErrorWire>()),
        ("ReplayWire", root_schema::<ReplayWire>()),
    ];
    let mut defs = Map::new();
    for (name, root) in roots {
        if let Some(root_defs) = root.get("$defs").and_then(Value::as_object) {
            defs.extend(root_defs.iter().map(|(key, value)| (key.clone(), value.clone())));
        }
        if let Some(schema) = root.get("schema") {
            if let Some(root_defs) = schema.get("$defs").and_then(Value::as_object) {
                defs.extend(root_defs.iter().map(|(key, value)| (key.clone(), value.clone())));
            }
        }
        if let Some(definition) = root.get("$ref") {
            defs.insert(name.to_owned(), json!({ "$ref": definition }));
        } else if let Some(schema) = root.get("schema") {
            defs.insert(name.to_owned(), schema.clone());
        } else {
            defs.insert(name.to_owned(), root.clone());
        }
    }
    let mut schema = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://devhub.local/contracts/app-shell/app-shell-v1.schema.json",
        "title": "DevHub App Shell v1",
        "$defs": defs,
        "oneOf": [
            { "$ref": "#/$defs/AppSnapshotWire" },
            { "$ref": "#/$defs/AgentProfilesWire" },
            { "$ref": "#/$defs/AppAppearanceWire" },
            { "$ref": "#/$defs/AppIntentWire" },
            { "$ref": "#/$defs/AppOutcomeWire" },
            { "$ref": "#/$defs/WorkspacePickerEventWire" },
            { "$ref": "#/$defs/AppErrorWire" },
            { "$ref": "#/$defs/ReplayWire" }
        ]
    });
    normalize_schema_constants(&mut schema);
    schema
}

fn normalize_schema_constants(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        if let Some(values) = value.as_array_mut() {
            for value in values {
                normalize_schema_constants(value);
            }
        }
        return;
    };
    if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
        if properties.contains_key("schemaVersion") {
            properties
                .insert("schemaVersion".to_owned(), json!({ "const": APP_SHELL_SCHEMA_VERSION }));
        }
    }
    for child in object.values_mut() {
        normalize_schema_constants(child);
    }
}

fn valid_values() -> Vec<Value> {
    let snapshot = AppSnapshotWire::from_snapshot(&AppModel::new().snapshot(), AppReadiness::Ready)
        .expect("default App Shell snapshot is representable");
    let snapshot = serde_json::to_value(snapshot).expect("serialize snapshot fixture");
    let profiles = serde_json::to_value(
        AgentProfilesWire::from_profiles(&[], 1).expect("empty profile fixture"),
    )
    .expect("serialize profile fixture");
    vec![
        snapshot.clone(),
        profiles,
        serde_json::to_value(AppAppearanceWire::from_config(
            &devhub_app_core::config::AppearanceConfig::default(),
            1,
        ))
        .expect("serialize appearance fixture"),
        serde_json::to_value(AppErrorWire::at(AppErrorCodeWire::NativeUnavailable, 1))
            .expect("serialize error surface fixture"),
        json!({ "type": "select_context", "context": { "kind": "global" } }),
        json!({ "type": "select_activity", "activity": "terminal" }),
        json!({ "type": "resize_sidebar", "width": SIDEBAR_DEFAULT_WIDTH }),
        json!({ "type": "toggle_workspace_disclosure", "workspaceId": "00000000-0000-4000-8000-000000000001", "expanded": true }),
        json!({ "type": "request_create_agent", "workspaceId": "00000000-0000-4000-8000-000000000001", "profileId": "codex" }),
        json!({ "type": "rename_agent", "agentId": "00000000-0000-4000-8000-000000000002", "displayName": "Codex 1" }),
        json!({ "type": "stop_agent", "agentId": "00000000-0000-4000-8000-000000000002" }),
        json!({ "type": "confirm_stop_agent", "confirmationId": "00000000-0000-4000-8000-000000000003" }),
        json!({ "type": "retry_stop_agent", "agentId": "00000000-0000-4000-8000-000000000002" }),
        json!({ "type": "reconcile_agent", "agentId": "00000000-0000-4000-8000-000000000002" }),
        json!({ "type": "open_workspace_picker" }),
        json!({ "kind": "noop", "snapshot": snapshot.clone() }),
        json!({ "cursor": 0, "historyGap": false, "snapshot" : snapshot, "events": [] }),
    ]
}

fn invalid_values() -> Vec<Value> {
    let valid = valid_values();
    let snapshot = valid[0].clone();
    let mut unknown = snapshot.clone();
    unknown["unexpected"] = Value::Bool(true);
    let mut bad_version = snapshot.clone();
    bad_version["schemaVersion"] = Value::Number(2.into());
    let mut bad_width = snapshot.clone();
    bad_width["sidebar"]["width"] = Value::Number((SIDEBAR_MIN_WIDTH - 1).into());
    let mut unsafe_revision = snapshot.clone();
    unsafe_revision["revision"] = Value::Number((MAX_SAFE_JS_INTEGER + 1).into());
    let mut bad_appearance = valid[2].clone();
    bad_appearance["sequence"] = Value::Number((MAX_SAFE_JS_INTEGER + 1).into());
    let mut bad_profiles = valid[1].clone();
    bad_profiles["sequence"] = Value::Number((MAX_SAFE_JS_INTEGER + 1).into());
    vec![
        unknown,
        bad_version,
        bad_width,
        unsafe_revision,
        bad_appearance,
        bad_profiles,
        json!({ "type": "unknown_intent" }),
        json!({ "type": "select_activity", "activity": "unknown" }),
        json!({ "type": "resize_sidebar", "width": 401 }),
        json!({ "type": "select_context", "context": { "kind": "global", "extra": true } }),
        json!({
            "cursor": 1,
            "historyGap": false,
            "snapshot": snapshot,
            "events": [{ "sequence": 1, "kind": "effect" }]
        }),
    ]
}

fn json_fixture(values: Vec<Value>) -> String {
    format!("{}\n", serde_json::to_string_pretty(&values).expect("serialize fixture values"))
}

fn ref_name(schema: &Value) -> Option<&str> {
    schema.get("$ref").and_then(Value::as_str).and_then(|reference| reference.rsplit('/').next())
}

fn ts_type(schema: &Value) -> String {
    if let Some(name) = ref_name(schema) {
        return name.to_owned();
    }
    if let Some(value) = schema.get("const") {
        return match value {
            Value::String(value) => serde_json::to_string(value).expect("TS literal"),
            Value::Bool(value) => value.to_string(),
            Value::Number(value) => value.to_string(),
            _ => "unknown".to_owned(),
        };
    }
    if let Some(values) = schema.get("oneOf").and_then(Value::as_array) {
        return values.iter().map(ts_type).collect::<Vec<_>>().join(" | ");
    }
    if let Some(values) = schema.get("anyOf").and_then(Value::as_array) {
        return values.iter().map(ts_type).collect::<Vec<_>>().join(" | ");
    }
    if let Some(values) = schema.get("type").and_then(Value::as_array) {
        return values
            .iter()
            .map(|value| ts_type(&json!({ "type": value })))
            .collect::<Vec<_>>()
            .join(" | ");
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => schema
            .get("enum")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|value| serde_json::to_string(value).expect("TS enum literal"))
                    .collect::<Vec<_>>()
                    .join(" | ")
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "string".to_owned()),
        Some("null") => "null".to_owned(),
        Some("integer") | Some("number") => "number".to_owned(),
        Some("boolean") => "boolean".to_owned(),
        Some("array") => format!(
            "readonly {}[]",
            schema.get("items").map(ts_type).unwrap_or_else(|| "unknown".to_owned())
        ),
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
                    format!("  readonly {name}{optional}: {};", ts_type(property))
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("{{\n{fields}\n}}")
        }
        _ => "unknown".to_owned(),
    }
}

fn generated_typescript(schema: &Value) -> String {
    let schema_text = serde_json::to_string(schema).expect("embed App Shell schema");
    let defs = schema["$defs"].as_object().expect("Rust schema definitions");
    let mut output = String::from(
        "// @generated by crates/devhub-app-core/src/bin/generate_app_shell_contract.rs; DO NOT EDIT.\n/* eslint-disable @typescript-eslint/no-explicit-any */\n\n",
    );
    output.push_str("export type AppAppearance = AppAppearanceWire;\n");
    output.push_str(
        &format!(
            "export const APP_SHELL_SCHEMA_VERSION = {} as const;\nexport const MAX_SAFE_JS_INTEGER = {} as const;\nexport const MIN_SIDEBAR_WIDTH = {} as const;\nexport const MAX_SIDEBAR_WIDTH = {} as const;\nexport const DEFAULT_SIDEBAR_WIDTH = {} as const;\n\n",
            APP_SHELL_SCHEMA_VERSION,
            MAX_SAFE_JS_INTEGER,
            SIDEBAR_MIN_WIDTH,
            SIDEBAR_MAX_WIDTH,
            SIDEBAR_DEFAULT_WIDTH,
        ),
    );
    for (name, definition) in defs {
        if name.ends_with("Wire")
            && definition.get("type") == Some(&Value::String("object".to_owned()))
        {
            output.push_str(&format!("export interface {name} {}\n", ts_type(definition)));
        } else {
            output.push_str(&format!("export type {name} = {};\n", ts_type(definition)));
        }
    }
    output.push_str(
        "export type Activity = ActivityName;\nexport const ACTIVITIES: readonly Activity[] = [\"editor\", \"agent\", \"terminal\"] as const;\nexport type SnapshotReadiness = AppReadiness;\nexport type NavigationContext = ContextWire;\nexport type SelectionSnapshot = SelectionWire;\nexport type ActivityResolution = ResolutionWire;\nexport type ActivitySnapshot = ActivityWire;\nexport type AgentStatus = AgentStatusWire;\nexport type RuntimeHealth = RuntimeHealthWire;\nexport type AgentControlState = AgentControlStateWire;\nexport type WorkspaceState = WorkspaceStateWire;\nexport type WorkspaceSnapshot = WorkspaceWire;\nexport type AgentSnapshot = AgentWire;\nexport type SidebarSnapshot = SidebarWire;\nexport type AppSnapshot = AppSnapshotWire;\nexport type AppIntent = AppIntentWire;\nexport type AppOutcome = AppOutcomeWire;\nexport type AppError = AppErrorWire;\nexport type AppErrorCode = AppErrorCodeWire;\nexport type AppEventCursor = ReplayWire;\nexport type AppLoadState = { readonly status: \"loading\" } | { readonly status: \"ready\"; readonly snapshot: AppSnapshot } | { readonly status: \"error\"; readonly error: AppError };\n\nexport function contextKey(context: NavigationContext): string { switch (context.kind) { case \"global\": return \"global\"; case \"workspace\": return `workspace:${context.workspaceId}`; case \"agent\": return `agent:${context.agentId}`; } }\nexport function isContextSelected(selected: NavigationContext, candidate: NavigationContext): boolean { return contextKey(selected) === contextKey(candidate); }\nexport function activityLabel(activity: Activity): string { return activity[0].toUpperCase() + activity.slice(1); }\nexport function workspaceById(snapshot: AppSnapshot, workspaceId: string): WorkspaceSnapshot | undefined { return snapshot.workspaces.find((workspace) => workspace.id === workspaceId); }\nexport function workspaceForContext(snapshot: AppSnapshot, context: NavigationContext): WorkspaceSnapshot | undefined { if (context.kind === \"workspace\") return workspaceById(snapshot, context.workspaceId); if (context.kind === \"agent\") return snapshot.workspaces.find((workspace) => workspace.agents.some((agent) => agent.id === context.agentId)); return undefined; }\nexport function activeActivitySnapshot(snapshot: AppSnapshot): ActivitySnapshot { return snapshot.activities.find(({ activity }) => activity === snapshot.selection.activity) ?? snapshot.activities[0]; }\nexport function isWorkspaceExpanded(snapshot: AppSnapshot, workspaceId: string): boolean { return snapshot.sidebar.expandedWorkspaceIds.includes(workspaceId); }\n\n",
    );
    output.push_str("export type AgentProfile = AgentProfileWire;\nexport type AgentProfiles = AgentProfilesWire;\n\n");
    output.push_str("const APP_SHELL_SCHEMA = ");
    output.push_str(&schema_text);
    output.push_str(" as const;\n\n");
    output.push_str(TS_RUNTIME);
    output
}

fn format_artifact(root: &Path, path: &Path, contents: String) -> Result<String, String> {
    let parser = match path.extension().and_then(|extension| extension.to_str()) {
        Some("json") => "json",
        Some("ts") => "typescript",
        _ => return Ok(contents),
    };
    let prettier = root.join("apps/devhub/node_modules/.bin/prettier");
    if !prettier.is_file() {
        return Err(format!(
            "pinned Prettier is missing at {}; install the locked workspace dependencies",
            prettier.display()
        ));
    }
    let mut child = match Command::new(prettier)
        .args(["--parser", parser, "--stdin-filepath"])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return Err(format!("failed to execute pinned Prettier: {error}")),
    };
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        if stdin.write_all(contents.as_bytes()).is_err() {
            return Err("failed to send artifact to pinned Prettier".to_owned());
        }
    }
    match child.wait_with_output() {
        Ok(output) if output.status.success() => String::from_utf8(output.stdout)
            .map_err(|_| "pinned Prettier returned non-UTF-8 output".to_owned()),
        Ok(output) => {
            let detail = String::from_utf8_lossy(&output.stderr);
            Err(format!("pinned Prettier rejected {}: {detail}", path.display()))
        }
        Err(error) => Err(format!("failed waiting for pinned Prettier: {error}")),
    }
}

const TS_RUNTIME: &str = r###"type Schema = Record<string, any>;

function resolve(ref: string): Schema {
  let value: any = APP_SHELL_SCHEMA;
  for (const part of ref.replace(/^#\//, "").split("/")) value = value[part];
  return value;
}

function check(schema: Schema, value: unknown): void {
  if (schema.$ref) return check(resolve(schema.$ref), value);
  if ("const" in schema && !Object.is(value, schema.const)) throw new Error("constant mismatch");
  if (Array.isArray(schema.enum) && !schema.enum.some((entry: unknown) => Object.is(entry, value))) throw new Error("enum mismatch");
  for (const key of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(schema[key])) continue;
    let passed = 0;
    for (const candidate of schema[key]) {
      try {
        check(candidate, value);
        passed++;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
    }
    if (key === "anyOf" ? passed < 1 : passed !== 1) throw new Error(`${key} mismatch`);
  }
  if (Array.isArray(schema.allOf)) for (const candidate of schema.allOf) check(candidate, value);
  if (Array.isArray(schema.type)) {
    const matched = schema.type.some((type: unknown) => {
      try {
        check({ ...schema, type }, value);
        return true;
      } catch {
        return false;
      }
    });
    if (!matched) throw new Error("type mismatch");
    return;
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("object expected");
    const item = value as Record<string, unknown>;
    for (const required of schema.required ?? []) if (!(required in item)) throw new Error("missing field");
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) for (const key of Object.keys(item)) if (!(key in properties)) throw new Error(`unknown field ${key}`);
    for (const [key, property] of Object.entries(properties)) if (key in item) check(property as Schema, item[key]);
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error("array expected");
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error("array too short");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error("array too long");
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) throw new Error("duplicate array item");
    if (schema.items) for (const item of value) check(schema.items, item);
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error("string expected");
    if (schema.minLength !== undefined && [...value].length < schema.minLength) throw new Error("string too short");
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) throw new Error("string too long");
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) throw new Error("pattern mismatch");
  }
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("safe integer expected");
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error("number too small");
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error("number too large");
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("finite number expected");
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error("number too small");
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error("number too large");
  }
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error("boolean expected");
  if (schema.type === "null" && value !== null) throw new Error("null expected");
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function validateAgentProfilesProjection(value: AgentProfiles): void {
  const diagnostic = value.diagnostic ?? null;
  if (value.availability === "available" && diagnostic !== null)
    throw new Error("available agent profiles cannot contain a diagnostic");
  if (value.availability !== "available" && diagnostic === null)
    throw new Error("degraded or unavailable agent profiles require a diagnostic");
  if (value.availability === "unavailable" && value.profiles.length > 0)
    throw new Error("unavailable agent profiles cannot contain choices");
}

export function parseAppAppearance(value: unknown): AppAppearance { check({ $ref: "#/$defs/AppAppearanceWire" }, value); return freeze(value as AppAppearance); }
export function parseAgentProfiles(value: unknown): AgentProfiles { check({ $ref: "#/$defs/AgentProfilesWire" }, value); const profiles = value as AgentProfiles; validateAgentProfilesProjection(profiles); return freeze(profiles); }
export function parseAppSnapshot(value: unknown): AppSnapshot { check({ $ref: "#/$defs/AppSnapshotWire" }, value); return freeze(value as AppSnapshot); }
export function parseAppIntent(value: unknown): AppIntent { check({ $ref: "#/$defs/AppIntentWire" }, value); return freeze(value as AppIntent); }
export function parseAppOutcome(value: unknown): AppOutcome { check({ $ref: "#/$defs/AppOutcomeWire" }, value); return freeze(value as AppOutcome); }
export function parseAppError(value: unknown): AppError { check({ $ref: "#/$defs/AppErrorWire" }, value); return freeze(value as AppError); }
export function parseAppEventCursor(value: unknown): AppEventCursor { check({ $ref: "#/$defs/ReplayWire" }, value); return freeze(value as AppEventCursor); }
export function parseWorkspacePickerEvent(value: unknown): WorkspacePickerEventWire { check({ $ref: "#/$defs/WorkspacePickerEventWire" }, value); return freeze(value as WorkspacePickerEventWire); }
export function validateAppShell(value: unknown): void { const errors: unknown[] = []; for (const candidate of (APP_SHELL_SCHEMA.oneOf as readonly Schema[])) { try { check(candidate, value); return; } catch (error) { errors.push(error); } } throw new Error(`invalid App Shell value (${errors.length} alternatives rejected)`); }
"###;

fn outputs(root: &Path) -> Vec<(PathBuf, String)> {
    let schema = contract_schema();
    let valid = json_fixture(valid_values());
    let invalid = json_fixture(invalid_values());
    vec![
        (
            root.join("contracts/app-shell/app-shell-v1.schema.json"),
            format!("{}\n", serde_json::to_string_pretty(&schema).expect("schema")),
        ),
        (root.join("contracts/app-shell/valid.json"), valid),
        (root.join("contracts/app-shell/invalid.json"), invalid),
        (root.join("apps/devhub/src/generated/app-shell/index.ts"), generated_typescript(&schema)),
    ]
}

fn main() {
    let check = env::args().skip(1).any(|argument| argument == "--check");
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir.parent().and_then(Path::parent).expect("workspace root");
    let mut failed = false;
    for (path, raw_contents) in outputs(root) {
        let contents = match format_artifact(root, &path, raw_contents) {
            Ok(contents) => contents,
            Err(error) => {
                eprintln!("App Shell contract generation failed: {error}");
                failed = true;
                continue;
            }
        };
        if check {
            match fs::read_to_string(&path) {
                Ok(actual) if actual == contents => {}
                Ok(_) => {
                    eprintln!("generated App Shell artifact differs: {}", path.display());
                    failed = true;
                }
                Err(error) => {
                    eprintln!("missing generated App Shell artifact {}: {error}", path.display());
                    failed = true;
                }
            }
        } else {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create generated artifact directory");
            }
            fs::write(&path, contents).expect("write generated App Shell artifact");
        }
    }
    if failed {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::format_artifact;
    use std::path::PathBuf;

    #[test]
    fn formatter_fails_closed_when_pinned_prettier_is_missing() {
        let root = PathBuf::from("/tmp/devhub-app-shell-contract-without-node-modules");
        let path = root.join("contracts/app-shell/app-shell-v1.schema.json");
        let error = format_artifact(&root, &path, "{}\n".to_owned())
            .expect_err("missing formatter must fail closed");
        assert!(error.contains("pinned Prettier is missing"));
    }
}
