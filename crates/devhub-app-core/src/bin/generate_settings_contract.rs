//! Generate the strict Settings v1 schema, fixtures, and TypeScript parser.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use devhub_app_core::config::{Config, ContentRevision};
use devhub_app_core::settings::*;
use devhub_app_core::state::TmuxState;
use schemars::schema_for;
use serde_json::{json, Map, Value};

fn root_schema<T: schemars::JsonSchema>() -> Value {
    serde_json::to_value(schema_for!(T)).expect("serialize Settings schema")
}

fn contract_schema() -> Value {
    let roots = [
        ("SettingsSnapshotWire", root_schema::<SettingsSnapshotWire>()),
        ("SettingsConfigWire", root_schema::<SettingsConfigWire>()),
        ("SettingsSaveRequestWire", root_schema::<SettingsSaveRequestWire>()),
        ("SettingsCommandRequestWire", root_schema::<SettingsCommandRequestWire>()),
        ("SettingsSocketChangeRequestWire", root_schema::<SettingsSocketChangeRequestWire>()),
        ("SettingsErrorWire", root_schema::<SettingsErrorWire>()),
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
        if let Some(reference) = root.get("$ref") {
            defs.insert(name.to_owned(), json!({ "$ref": reference }));
        } else if let Some(schema) = root.get("schema") {
            defs.insert(name.to_owned(), schema.clone());
        } else {
            defs.insert(name.to_owned(), root.clone());
        }
    }
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://devhub.local/contracts/settings/settings-v1.schema.json",
        "title": "DevHub Settings v1",
        "$defs": defs,
        "oneOf": [
            { "$ref": "#/$defs/SettingsSnapshotWire" },
            { "$ref": "#/$defs/SettingsConfigWire" },
            { "$ref": "#/$defs/SettingsSaveRequestWire" },
            { "$ref": "#/$defs/SettingsCommandRequestWire" },
            { "$ref": "#/$defs/SettingsSocketChangeRequestWire" },
            { "$ref": "#/$defs/SettingsErrorWire" }
        ]
    })
}

fn fixture_snapshot() -> Value {
    let config = Config::default();
    let revision = ContentRevision::from_hex(&"00".repeat(32)).expect("fixture revision");
    let runtime_view = runtime_view_for_config(&config, "devhub");
    let runtime = SettingsRuntimeWire::from_runtime_view(
        &runtime_view,
        &TmuxState::default(),
        SettingsRuntimeHealthWire::unavailable(),
        false,
    );
    serde_json::to_value(SettingsSnapshotWire::from_config(&config, revision, 1, runtime, None))
        .expect("serialize Settings snapshot fixture")
}

fn valid_values() -> Vec<Value> {
    let snapshot = fixture_snapshot();
    let config = snapshot["config"].clone();
    vec![
        snapshot.clone(),
        config.clone(),
        json!({
            "schemaVersion": 1,
            "revision": "0000000000000000000000000000000000000000000000000000000000000000",
            "config": config
        }),
        json!({ "schemaVersion": 1 }),
        json!({
            "schemaVersion": 1,
            "revision": "0000000000000000000000000000000000000000000000000000000000000000",
            "confirmed": false
        }),
        json!({
            "code": "invalid_config",
            "diagnostic": null,
            "currentRevision": null
        }),
    ]
}

fn invalid_values() -> Vec<Value> {
    let valid = valid_values();
    let mut bad_snapshot = valid[0].clone();
    bad_snapshot["unexpected"] = Value::Bool(true);
    let mut bad_config = valid[1].clone();
    bad_config["runtimes"]["unexpected"] = Value::Bool(true);
    let mut bad_save = valid[2].clone();
    bad_save["revision"] = Value::String("not-a-revision".to_owned());
    let mut bad_uppercase_save = valid[2].clone();
    bad_uppercase_save["revision"] = Value::String("ABCDEF0123456789".repeat(4));
    vec![
        bad_snapshot,
        bad_config,
        bad_save,
        bad_uppercase_save,
        json!({ "schemaVersion": 2 }),
        json!({
            "schemaVersion": 1,
            "revision": "0000000000000000000000000000000000000000000000000000000000000000",
            "confirmed": false,
            "unexpected": true
        }),
    ]
}

fn json_fixture(values: Vec<Value>) -> String {
    format!("{}\n", serde_json::to_string_pretty(&values).expect("serialize Settings fixtures"))
}

fn ref_name(schema: &Value) -> Option<&str> {
    schema.get("$ref").and_then(Value::as_str).and_then(|reference| reference.rsplit('/').next())
}

fn ts_type(schema: &Value) -> String {
    if let Some(name) = ref_name(schema) {
        return name.to_owned();
    }
    if schema.get("type").and_then(Value::as_str) == Some("null") {
        return "null".to_owned();
    }
    if let Some(types) = schema.get("type").and_then(Value::as_array) {
        if types.iter().any(|value| value.as_str() == Some("null")) {
            let non_null = types
                .iter()
                .find(|value| value.as_str() != Some("null"))
                .cloned()
                .unwrap_or(Value::String("unknown".to_owned()));
            let mut without_null = schema.clone();
            without_null["type"] = non_null;
            return format!("{} | null", ts_type(&without_null));
        }
    }
    if let Some(values) = schema.get("anyOf").and_then(Value::as_array) {
        let values = values.iter().map(ts_type).collect::<Vec<_>>();
        if !values.is_empty() {
            return values.join(" | ");
        }
        return "null".to_owned();
    }
    if let Some(value) = schema.get("const") {
        return serde_json::to_string(value).expect("TS const");
    }
    if let Some(values) = schema.get("oneOf").and_then(Value::as_array) {
        return values.iter().map(ts_type).collect::<Vec<_>>().join(" | ");
    }
    let type_name = schema.get("type").and_then(|value| {
        value.as_str().map(str::to_owned).or_else(|| {
            value.as_array().and_then(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .find(|value| *value != "null")
                    .map(str::to_owned)
            })
        })
    });
    match type_name.as_deref() {
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
                return format!(
                    "Record<string, {}>",
                    schema
                        .get("additionalProperties")
                        .map(ts_type)
                        .unwrap_or_else(|| "unknown".to_owned())
                );
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
    let schema_text = serde_json::to_string(schema).expect("embed Settings schema");
    let defs = schema["$defs"].as_object().expect("Settings schema definitions");
    let mut output = String::from(
        "// @generated by crates/devhub-app-core/src/bin/generate_settings_contract.rs; DO NOT EDIT.\n/* eslint-disable @typescript-eslint/no-explicit-any */\n\n",
    );
    output.push_str(&format!(
        "export const SETTINGS_SCHEMA_VERSION = {} as const;\n\n",
        SETTINGS_SCHEMA_VERSION
    ));
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
        "export type SettingsSnapshot = SettingsSnapshotWire;\nexport type SettingsConfig = SettingsConfigWire;\nexport type SettingsError = SettingsErrorWire;\n\n",
    );
    output.push_str("const SETTINGS_SCHEMA = ");
    output.push_str(&schema_text);
    output.push_str(" as const;\n\n");
    output.push_str(TS_RUNTIME);
    output
}

const TS_RUNTIME: &str = r###"type Schema = Record<string, any>;

function resolve(ref: string): Schema {
  let value: any = SETTINGS_SCHEMA;
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
      try { check(candidate, value); passed++; } catch (error) { if (!(error instanceof Error)) throw error; }
    }
    if (key === "anyOf" ? passed < 1 : passed !== 1) throw new Error(`${key} mismatch`);
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
    if (schema.items) for (const item of value) check(schema.items, item);
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error("string expected");
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
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

export function parseSettingsSnapshot(value: unknown): SettingsSnapshot { check({ $ref: "#/$defs/SettingsSnapshotWire" }, value); return freeze(value as SettingsSnapshot); }
export function parseSettingsConfig(value: unknown): SettingsConfig { check({ $ref: "#/$defs/SettingsConfigWire" }, value); return freeze(value as SettingsConfig); }
export function parseSettingsError(value: unknown): SettingsError { check({ $ref: "#/$defs/SettingsErrorWire" }, value); return freeze(value as SettingsError); }
export function validateSettings(value: unknown): void { for (const candidate of (SETTINGS_SCHEMA.oneOf as readonly Schema[])) { try { check(candidate, value); return; } catch (error) { if (!(error instanceof Error)) throw error; } } throw new Error("invalid Settings value"); }
"###;

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

fn outputs(root: &Path) -> Vec<(PathBuf, String)> {
    let schema = contract_schema();
    vec![
        (
            root.join("contracts/settings/settings-v1.schema.json"),
            format!("{}\n", serde_json::to_string_pretty(&schema).expect("Settings schema")),
        ),
        (root.join("contracts/settings/valid.json"), json_fixture(valid_values())),
        (root.join("contracts/settings/invalid.json"), json_fixture(invalid_values())),
        (root.join("apps/devhub/src/generated/settings/index.ts"), generated_typescript(&schema)),
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
                eprintln!("Settings contract generation failed: {error}");
                failed = true;
                continue;
            }
        };
        if check {
            match fs::read_to_string(&path) {
                Ok(actual) if actual == contents => {}
                Ok(_) => {
                    eprintln!("generated Settings artifact differs: {}", path.display());
                    failed = true;
                }
                Err(error) => {
                    eprintln!("missing generated Settings artifact {}: {error}", path.display());
                    failed = true;
                }
            }
        } else {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create generated Settings artifact directory");
            }
            fs::write(&path, contents).expect("write generated Settings artifact");
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
        let root = PathBuf::from("/tmp/devhub-settings-contract-without-node-modules");
        let path = root.join("contracts/settings/settings-v1.schema.json");
        let error = format_artifact(&root, &path, "{}\n".to_owned())
            .expect_err("missing formatter must fail closed");
        assert!(error.contains("pinned Prettier is missing"));
    }
}
