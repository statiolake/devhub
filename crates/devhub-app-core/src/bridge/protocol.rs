//! The frozen, provider-free DevHub Bridge v1 wire contract.
//!
//! This module is deliberately independent of the application coordinator and
//! of any transport implementation.  WebSocket adapters deal in
//! [`Envelope`] values and therefore cannot accidentally make editor content,
//! provider handles, or credentials part of the product contract.

use std::borrow::Cow;
use std::fmt;
use std::fs::File;
use std::io::Read;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::de::{self, DeserializeOwned};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The only protocol version currently supported by DevHub.
pub const BRIDGE_PROTOCOL_VERSION: u8 = 1;
/// Maximum encoded JSON message size, including the UTF-8 bytes of the JSON
/// envelope itself.
pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// Request deadline required by the wire contract.
pub const REQUEST_DEADLINE_SECONDS: u64 = 5;
/// Minimum result-ledger capacity required by the wire contract.
pub const REQUEST_LEDGER_MIN_ENTRIES: usize = 1_024;
/// Absolute in-process bound for a surface ledger. The protocol minimum is
/// retained under normal volume; this hard ceiling prevents a burst within the
/// retention window from becoming an unbounded allocation.
pub const REQUEST_LEDGER_MAX_ENTRIES: usize = 4_096;
/// Minimum result-ledger retention required by the wire contract.
pub const REQUEST_LEDGER_MIN_RETENTION_SECONDS: u64 = 10 * 60;
/// Maximum integer that can be represented exactly by both Rust and JavaScript.
pub const MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

/// A lowercase, canonical, hyphenated UUID.
///
/// The bridge intentionally owns this small value object instead of exposing
/// a UUID crate type in its public contract.  Canonical form is the invariant
/// that matters on the wire; all UUID versions (including nil and newer UUID
/// versions) are accepted.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Uuid(String);

impl Uuid {
    /// Parses a canonical lowercase hyphenated UUID.
    pub fn parse(raw: impl Into<String>) -> Result<Self, ProtocolError> {
        let raw = raw.into();
        if !is_canonical_uuid(&raw) {
            return Err(ProtocolError::invalid("invalid canonical UUID"));
        }
        Ok(Self(raw))
    }

    /// Creates a fresh UUID from the verified operating-system CSPRNG.
    ///
    /// Bridge state machines use this seam for production identifiers. There
    /// is deliberately no counter/time fallback: a failure to obtain secure
    /// randomness is surfaced as a failure instead of pretending uniqueness.
    pub fn fresh() -> Self {
        let mut source = SecureIdSource;
        Self::from_source(&mut source).expect("secure UUID source unavailable")
    }

    /// Gets an identifier from an injected source. Tests and embedders can
    /// provide deterministic sources without weakening production generation.
    pub fn from_source(source: &mut (impl IdSource + ?Sized)) -> Result<Self, IdSourceError> {
        source.next_uuid()
    }

    /// Returns the canonical wire representation.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consumes the value and returns its canonical wire representation.
    pub fn into_string(self) -> String {
        self.0
    }
}

fn format_uuid(bytes: [u8; 16]) -> String {
    let mut output = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            output.push('-');
        }
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

/// Failure obtaining a production-quality identifier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IdSourceError {
    Unavailable(String),
    Invalid(String),
}

/// Injectable UUID source used to keep deterministic tests independent of
/// process-global state.
pub trait IdSource {
    fn next_uuid(&mut self) -> Result<Uuid, IdSourceError>;
}

/// Operating-system CSPRNG UUID source used by production bridge sessions.
#[derive(Clone, Copy, Debug, Default)]
pub struct SecureIdSource;

impl IdSource for SecureIdSource {
    fn next_uuid(&mut self) -> Result<Uuid, IdSourceError> {
        let mut bytes = [0_u8; 16];
        File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut bytes))
            .map_err(|error| IdSourceError::Unavailable(error.to_string()))?;
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        Uuid::parse(format_uuid(bytes)).map_err(|error| IdSourceError::Invalid(error.to_string()))
    }
}

impl fmt::Display for Uuid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl AsRef<str> for Uuid {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl Serialize for Uuid {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Uuid {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(raw).map_err(de::Error::custom)
    }
}

impl JsonSchema for Uuid {
    fn schema_name() -> Cow<'static, str> {
        "Uuid".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
        })
    }
}

fn is_canonical_uuid(raw: &str) -> bool {
    raw.len() == 36
        && raw.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}

/// A strict Semantic Version value used by the hello payload.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SemVer(String);

impl SemVer {
    pub fn parse(raw: impl Into<String>) -> Result<Self, ProtocolError> {
        let raw = raw.into();
        if !is_semver(&raw) {
            return Err(ProtocolError::invalid("invalid semantic version"));
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SemVer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Serialize for SemVer {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SemVer {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(raw).map_err(de::Error::custom)
    }
}

impl JsonSchema for SemVer {
    fn schema_name() -> Cow<'static, str> {
        "SemVer".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
        })
    }
}

fn is_semver(raw: &str) -> bool {
    // SemVer 2.0.0: major.minor.patch, optional prerelease and build
    // metadata.  Keeping this parser local avoids another runtime dependency.
    let (core, build) = match raw.split_once('+') {
        Some((core, build)) => (core, Some(build)),
        None => (raw, None),
    };
    if let Some(build) = build {
        if build.is_empty()
            || !build
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(is_semver_identifier_byte))
        {
            return false;
        }
    }
    let (core, prerelease) = match core.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (core, None),
    };
    let mut numbers = core.split('.');
    let valid_core = [numbers.next(), numbers.next(), numbers.next()].into_iter().all(|part| {
        part.is_some_and(|part| {
            !part.is_empty()
                && (part == "0" || !part.starts_with('0'))
                && part.bytes().all(|byte| byte.is_ascii_digit())
        })
    }) && numbers.next().is_none();
    if !valid_core {
        return false;
    }
    prerelease.is_none_or(|value| {
        !value.is_empty()
            && value.split('.').all(|part| {
                !part.is_empty()
                    && part.bytes().all(is_semver_identifier_byte)
                    && (part.bytes().any(|byte| !byte.is_ascii_digit())
                        || part == "0"
                        || !part.starts_with('0'))
            })
    })
}

fn is_semver_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-'
}

/// An absolute, UTF-8, NUL-free, lexically normalized path.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct AbsolutePath(String);

impl AbsolutePath {
    pub fn parse(raw: impl Into<String>) -> Result<Self, ProtocolError> {
        let raw = raw.into();
        if !is_normalized_absolute_path(&raw) {
            return Err(ProtocolError::invalid("invalid absolute path"));
        }
        Ok(Self(raw))
    }

    /// Lexically normalizes an absolute path without consulting the file
    /// system.  A normalized input is returned by [`AbsolutePath::parse`].
    /// Paths that would escape root are rejected rather than guessed at.
    pub fn normalize(raw: impl AsRef<str>) -> Result<Self, ProtocolError> {
        let raw = raw.as_ref();
        if !raw.starts_with('/') || raw.contains('\0') {
            return Err(ProtocolError::invalid("path must be absolute and NUL-free"));
        }
        let mut parts = Vec::new();
        for part in raw.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    if parts.pop().is_none() {
                        return Err(ProtocolError::invalid("path escapes root"));
                    }
                }
                part => parts.push(part),
            }
        }
        let normalized =
            if parts.is_empty() { "/".to_owned() } else { format!("/{}", parts.join("/")) };
        Self::parse(normalized)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AbsolutePath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl AsRef<str> for AbsolutePath {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl Serialize for AbsolutePath {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AbsolutePath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(raw).map_err(de::Error::custom)
    }
}

impl JsonSchema for AbsolutePath {
    fn schema_name() -> Cow<'static, str> {
        "AbsolutePath".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "pattern": "^/(?!$)(?!.*//)(?!\\.(?:/|$))(?!\\.\\.(?:/|$))(?!.*\\/\\.(?:\\/|$))(?!.*\\/\\.\\.(?:\\/|$))(?!.*\\/$)[^\\u0000]*$|^/$"
        })
    }
}

fn is_normalized_absolute_path(raw: &str) -> bool {
    if !raw.starts_with('/') || raw.contains('\0') {
        return false;
    }
    if raw.len() > 1 && raw.ends_with('/') {
        return false;
    }
    raw.split('/').skip(1).all(|part| !part.is_empty() && part != "." && part != "..")
}

/// A closed set of stable, content-free diagnostic summaries. Paths,
/// commands, provider output, and arbitrary user text cannot cross the Bridge
/// error boundary because there is no free-form summary constructor.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ContentFreeSummary {
    InvalidMessage,
    InvalidIdentity,
    UnsupportedVersion,
    SequenceError,
    PayloadTooLarge,
    SecureIdentifierUnavailable,
    ConnectionLost,
    BridgeRequestTimedOut,
    InvalidHelloAcceptance,
    ResponseHasNoPendingRequest,
    ResponseResultInvalid,
    ErrorHasNoPendingRequest,
    UnknownHostRequest,
    Failed,
}

impl ContentFreeSummary {
    const ALL: [Self; 14] = [
        Self::InvalidMessage,
        Self::InvalidIdentity,
        Self::UnsupportedVersion,
        Self::SequenceError,
        Self::PayloadTooLarge,
        Self::SecureIdentifierUnavailable,
        Self::ConnectionLost,
        Self::BridgeRequestTimedOut,
        Self::InvalidHelloAcceptance,
        Self::ResponseHasNoPendingRequest,
        Self::ResponseResultInvalid,
        Self::ErrorHasNoPendingRequest,
        Self::UnknownHostRequest,
        Self::Failed,
    ];

    pub fn parse(raw: impl AsRef<str>) -> Result<Self, ProtocolError> {
        let raw = raw.as_ref();
        let value = match raw {
            "connection lost" => Self::ConnectionLost,
            "bridge request timed out" => Self::BridgeRequestTimedOut,
            "invalid hello acceptance" => Self::InvalidHelloAcceptance,
            "response has no pending request" => Self::ResponseHasNoPendingRequest,
            "response result is invalid" => Self::ResponseResultInvalid,
            "error has no pending request" => Self::ErrorHasNoPendingRequest,
            "unknown host request" => Self::UnknownHostRequest,
            "failed" => Self::Failed,
            "unsupported bridge protocol version" => Self::UnsupportedVersion,
            "secure identifier source unavailable" => Self::SecureIdentifierUnavailable,
            "message exceeds the maximum encoded size" => Self::PayloadTooLarge,
            "hello acceptance has no connection ID"
            | "hello acceptance identity mismatch"
            | "client has no connection ID" => Self::InvalidIdentity,
            "hello has already been sent"
            | "hello acceptance is out of order"
            | "snapshot is not expected"
            | "client connection is not established"
            | "state snapshot is required before events"
            | "requests require an active connection"
            | "client sequence exhausted" => Self::SequenceError,
            _ if raw.starts_with("invalid")
                || raw.starts_with("path ")
                || raw.starts_with("summary ")
                || raw.starts_with("payload ")
                || raw.starts_with("sequence ")
                || raw.starts_with("non-hello ")
                || raw.starts_with("hello must ")
                || raw.starts_with("message kind ")
                || raw.starts_with("response result ")
                || raw.starts_with("ledger limits ")
                || raw.starts_with("requests require ") =>
            {
                Self::InvalidMessage
            }
            _ => {
                return Err(ProtocolError {
                    code: ErrorCode::InvalidMessage,
                    summary: Self::InvalidMessage,
                })
            }
        };
        Ok(value)
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidMessage => "invalid bridge message",
            Self::InvalidIdentity => "invalid bridge identity",
            Self::UnsupportedVersion => "unsupported bridge protocol version",
            Self::SequenceError => "bridge sequence error",
            Self::PayloadTooLarge => "message exceeds the maximum encoded size",
            Self::SecureIdentifierUnavailable => "secure identifier source unavailable",
            Self::ConnectionLost => "connection lost",
            Self::BridgeRequestTimedOut => "bridge request timed out",
            Self::InvalidHelloAcceptance => "invalid hello acceptance",
            Self::ResponseHasNoPendingRequest => "response has no pending request",
            Self::ResponseResultInvalid => "response result is invalid",
            Self::ErrorHasNoPendingRequest => "error has no pending request",
            Self::UnknownHostRequest => "unknown host request",
            Self::Failed => "failed",
        }
    }
}

impl fmt::Display for ContentFreeSummary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Serialize for ContentFreeSummary {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ContentFreeSummary {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(raw).map_err(de::Error::custom)
    }
}

impl JsonSchema for ContentFreeSummary {
    fn schema_name() -> Cow<'static, str> {
        "ContentFreeSummary".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "enum": Self::ALL.iter().map(|summary| summary.as_str()).collect::<Vec<_>>()
        })
    }
}

/// Bridge readiness reported by the Workbench.
#[derive(Clone, Copy, Debug, Eq, JsonSchema, PartialEq)]
#[schemars(rename_all = "snake_case")]
pub enum Readiness {
    Starting,
    Ready,
    Unavailable,
}

impl Serialize for Readiness {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Unavailable => "unavailable",
        })
    }
}

impl<'de> Deserialize<'de> for Readiness {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match String::deserialize(deserializer)?.as_str() {
            "starting" => Ok(Self::Starting),
            "ready" => Ok(Self::Ready),
            "unavailable" => Ok(Self::Unavailable),
            _ => Err(de::Error::custom("unknown bridge readiness")),
        }
    }
}

/// Stable Workbench identity context.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Context {
    Global,
    Workspace { workspace_id: Uuid, canonical_root: AbsolutePath },
}

impl Serialize for Context {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(match self {
            Self::Global => 1,
            Self::Workspace { .. } => 3,
        }))?;
        match self {
            Self::Global => map.serialize_entry("kind", "global")?,
            Self::Workspace { workspace_id, canonical_root } => {
                map.serialize_entry("kind", "workspace")?;
                map.serialize_entry("workspace_id", workspace_id)?;
                map.serialize_entry("canonical_root", canonical_root)?;
            }
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Context {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let serde_json::Value::Object(map) = value else {
            return Err(de::Error::custom("context must be an object"));
        };
        let Some(kind) = map.get("kind").and_then(serde_json::Value::as_str) else {
            return Err(de::Error::custom("context kind is required"));
        };
        match kind {
            "global" => {
                if map.len() != 1 || !map.contains_key("kind") {
                    return Err(de::Error::custom("global context fields are not exact"));
                }
                Ok(Self::Global)
            }
            "workspace" => {
                if map.len() != 3
                    || !map.contains_key("workspace_id")
                    || !map.contains_key("canonical_root")
                {
                    return Err(de::Error::custom("workspace context fields are not exact"));
                }
                let workspace_id = serde_json::from_value(
                    map.get("workspace_id").cloned().expect("checked workspace ID"),
                )
                .map_err(de::Error::custom)?;
                let canonical_root = serde_json::from_value(
                    map.get("canonical_root").cloned().expect("checked canonical root"),
                )
                .map_err(de::Error::custom)?;
                Ok(Self::Workspace { workspace_id, canonical_root })
            }
            _ => Err(de::Error::custom("unknown context kind")),
        }
    }
}

impl Context {
    pub const fn global() -> Self {
        Self::Global
    }

    pub fn workspace(workspace_id: Uuid, canonical_root: AbsolutePath) -> Self {
        Self::Workspace { workspace_id, canonical_root }
    }

    pub const fn is_global(&self) -> bool {
        matches!(self, Self::Global)
    }
}

impl JsonSchema for Context {
    fn schema_name() -> Cow<'static, str> {
        "Context".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let uuid = generator.subschema_for::<Uuid>();
        let path = generator.subschema_for::<AbsolutePath>();
        json_schema!({
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["kind"],
                    "properties": {"kind": {"const": "global"}}
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["kind", "workspace_id", "canonical_root"],
                    "properties": {
                        "kind": {"const": "workspace"},
                        "workspace_id": uuid,
                        "canonical_root": path
                    }
                }
            ]
        })
    }
}

/// All protocol message kinds. Unknown kinds fail deserialization.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MessageKind {
    Hello,
    HelloAccepted,
    StateSnapshot,
    ReadyChanged,
    IdentityChanged,
    DirtyChanged,
    OpenWorkspaceRequested,
    NewWindowRequested,
    RequestStateSnapshot,
    Focus,
    Response,
    Error,
}

impl MessageKind {
    /// Canonical wire names used by the generator and transport adapters.
    pub const ALL: [&'static str; 12] = [
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
    ];

    pub const fn wire_name(self) -> &'static str {
        Self::ALL[self as usize]
    }

    fn from_wire_name(raw: &str) -> Option<Self> {
        Self::ALL.iter().position(|kind| *kind == raw).map(|index| match index {
            0 => Self::Hello,
            1 => Self::HelloAccepted,
            2 => Self::StateSnapshot,
            3 => Self::ReadyChanged,
            4 => Self::IdentityChanged,
            5 => Self::DirtyChanged,
            6 => Self::OpenWorkspaceRequested,
            7 => Self::NewWindowRequested,
            8 => Self::RequestStateSnapshot,
            9 => Self::Focus,
            10 => Self::Response,
            11 => Self::Error,
            _ => unreachable!("MessageKind::ALL and enum variants diverged"),
        })
    }
}

impl Serialize for MessageKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.wire_name())
    }
}

impl<'de> Deserialize<'de> for MessageKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::from_wire_name(&raw).ok_or_else(|| de::Error::custom("unknown bridge message kind"))
    }
}

impl JsonSchema for MessageKind {
    fn schema_name() -> Cow<'static, str> {
        "MessageKind".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({"type": "string", "enum": MessageKind::ALL})
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HelloPayload {
    pub extension_version: SemVer,
    pub surface_id: Uuid,
    pub workbench_instance_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HelloAcceptedPayload {
    pub accepted_version: u8,
    pub surface_id: Uuid,
    pub connection_generation: u64,
}

impl JsonSchema for HelloAcceptedPayload {
    fn schema_name() -> Cow<'static, str> {
        "HelloAcceptedPayload".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "object",
            "additionalProperties": false,
            "required": ["accepted_version", "surface_id", "connection_generation"],
            "properties": {
                "accepted_version": {"const": BRIDGE_PROTOCOL_VERSION},
                "surface_id": generator.subschema_for::<Uuid>(),
                "connection_generation": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_SAFE_INTEGER
                }
            }
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StateSnapshotPayload {
    pub surface_id: Uuid,
    pub readiness: Readiness,
    pub context: Context,
    pub dirty: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReadyChangedPayload {
    pub readiness: Readiness,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityChangedPayload {
    pub context: Context,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DirtyChangedPayload {
    pub dirty: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenWorkspaceSource {
    OpenFolder,
    OpenWorkspace,
    ExternalUri,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpenWorkspaceRequestedPayload {
    pub absolute_path: AbsolutePath,
    pub source: OpenWorkspaceSource,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NewWindowSource {
    Command,
    ExternalUri,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NewWindowRequestedPayload {
    pub absolute_path: Option<AbsolutePath>,
    pub source: NewWindowSource,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewWindowRequestedWire {
    absolute_path: serde_json::Value,
    source: NewWindowSource,
}

impl<'de> Deserialize<'de> for NewWindowRequestedPayload {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = NewWindowRequestedWire::deserialize(deserializer)?;
        Ok(Self {
            absolute_path: if wire.absolute_path.is_null() {
                None
            } else {
                Some(serde_json::from_value(wire.absolute_path).map_err(de::Error::custom)?)
            },
            source: wire.source,
        })
    }
}

impl JsonSchema for NewWindowRequestedPayload {
    fn schema_name() -> Cow<'static, str> {
        "NewWindowRequestedPayload".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "object",
            "additionalProperties": false,
            "required": ["absolute_path", "source"],
            "properties": {
                "absolute_path": {
                    "anyOf": [generator.subschema_for::<AbsolutePath>(), {"type": "null"}]
                },
                "source": generator.subschema_for::<NewWindowSource>()
            }
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotRequestReason {
    HostReconcile,
    ManualTest,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestStateSnapshotPayload {
    pub reason: SnapshotRequestReason,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FocusReason {
    Navigation,
    WindowRestore,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FocusPayload {
    pub reason: FocusReason,
}

/// The only result variants accepted in a response payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResponseResult {
    WorkspaceRouted { context: Context },
    GlobalRouted { context: Context },
    SnapshotWillFollow,
    Focused,
}

impl Serialize for ResponseResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(match self {
            Self::WorkspaceRouted { .. } | Self::GlobalRouted { .. } => 2,
            Self::SnapshotWillFollow | Self::Focused => 1,
        }))?;
        match self {
            Self::WorkspaceRouted { context } => {
                map.serialize_entry("kind", "workspace_routed")?;
                map.serialize_entry("context", context)?;
            }
            Self::GlobalRouted { context } => {
                map.serialize_entry("kind", "global_routed")?;
                map.serialize_entry("context", context)?;
            }
            Self::SnapshotWillFollow => map.serialize_entry("kind", "snapshot_will_follow")?,
            Self::Focused => map.serialize_entry("kind", "focused")?,
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for ResponseResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let serde_json::Value::Object(map) = value else {
            return Err(de::Error::custom("response result must be an object"));
        };
        let Some(kind) = map.get("kind").and_then(serde_json::Value::as_str) else {
            return Err(de::Error::custom("response result kind is required"));
        };
        match kind {
            "workspace_routed" => {
                if map.len() != 2 || !map.contains_key("context") {
                    return Err(de::Error::custom("workspace result fields are not exact"));
                }
                let context: Context = serde_json::from_value(
                    map.get("context").cloned().expect("checked result context"),
                )
                .map_err(de::Error::custom)?;
                if !matches!(context, Context::Workspace { .. }) {
                    return Err(de::Error::custom("workspace result requires workspace context"));
                }
                Ok(Self::WorkspaceRouted { context })
            }
            "global_routed" => {
                if map.len() != 2 || !map.contains_key("context") {
                    return Err(de::Error::custom("global result fields are not exact"));
                }
                let context: Context = serde_json::from_value(
                    map.get("context").cloned().expect("checked result context"),
                )
                .map_err(de::Error::custom)?;
                if !context.is_global() {
                    return Err(de::Error::custom("global result requires global context"));
                }
                Ok(Self::GlobalRouted { context })
            }
            "snapshot_will_follow" => {
                if map.len() != 1 {
                    return Err(de::Error::custom("snapshot result fields are not exact"));
                }
                Ok(Self::SnapshotWillFollow)
            }
            "focused" => {
                if map.len() != 1 {
                    return Err(de::Error::custom("focus result fields are not exact"));
                }
                Ok(Self::Focused)
            }
            _ => Err(de::Error::custom("unknown response result kind")),
        }
    }
}

impl JsonSchema for ResponseResult {
    fn schema_name() -> Cow<'static, str> {
        "ResponseResult".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let uuid = generator.subschema_for::<Uuid>();
        let path = generator.subschema_for::<AbsolutePath>();
        json_schema!({
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["kind", "context"],
                    "properties": {
                        "kind": {"const": "workspace_routed"},
                        "context": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["kind", "workspace_id", "canonical_root"],
                            "properties": {
                                "kind": {"const": "workspace"},
                                "workspace_id": uuid,
                                "canonical_root": path
                            }
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["kind", "context"],
                    "properties": {
                        "kind": {"const": "global_routed"},
                        "context": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["kind"],
                            "properties": {"kind": {"const": "global"}}
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["kind"],
                    "properties": {"kind": {"const": "snapshot_will_follow"}}
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["kind"],
                    "properties": {"kind": {"const": "focused"}}
                }
            ]
        })
    }
}

impl ResponseResult {
    pub fn validate_for_request(&self, request: &ClientRequest) -> Result<(), ProtocolError> {
        let valid = match (request, self) {
            (
                ClientRequest::OpenWorkspace(_),
                Self::WorkspaceRouted { context: Context::Workspace { .. } },
            ) => true,
            (
                ClientRequest::NewWindow(payload),
                Self::WorkspaceRouted { context: Context::Workspace { .. } },
            ) => payload.absolute_path.is_some(),
            (
                ClientRequest::NewWindow(payload),
                Self::GlobalRouted { context: Context::Global },
            ) => payload.absolute_path.is_none(),
            (ClientRequest::RequestStateSnapshot(_), Self::SnapshotWillFollow) => true,
            (ClientRequest::Focus(_), Self::Focused) => true,
            _ => false,
        };
        if valid {
            Ok(())
        } else {
            Err(ProtocolError::invalid("response result does not match request"))
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorCode {
    UnsupportedVersion,
    InvalidIdentity,
    InvalidMessage,
    SequenceError,
    PayloadTooLarge,
    SurfaceUnavailable,
    RequestFailed,
    RequestCancelled,
    BridgeTimeout,
    ConnectionLost,
}

impl ErrorCode {
    pub const ALL: [&'static str; 10] = [
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
    ];

    pub const fn wire_name(self) -> &'static str {
        Self::ALL[self as usize]
    }

    fn from_wire_name(raw: &str) -> Option<Self> {
        Self::ALL.iter().position(|code| *code == raw).map(|index| match index {
            0 => Self::UnsupportedVersion,
            1 => Self::InvalidIdentity,
            2 => Self::InvalidMessage,
            3 => Self::SequenceError,
            4 => Self::PayloadTooLarge,
            5 => Self::SurfaceUnavailable,
            6 => Self::RequestFailed,
            7 => Self::RequestCancelled,
            8 => Self::BridgeTimeout,
            9 => Self::ConnectionLost,
            _ => unreachable!("ErrorCode::ALL and enum variants diverged"),
        })
    }
}

impl Serialize for ErrorCode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.wire_name())
    }
}

impl<'de> Deserialize<'de> for ErrorCode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::from_wire_name(&raw).ok_or_else(|| de::Error::custom("unknown bridge error code"))
    }
}

impl JsonSchema for ErrorCode {
    fn schema_name() -> Cow<'static, str> {
        "ErrorCode".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({"type": "string", "enum": ErrorCode::ALL})
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResponsePayload {
    pub request_message_id: Uuid,
    pub result: ResponseResult,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorPayload {
    pub request_message_id: Option<Uuid>,
    pub code: ErrorCode,
    pub summary: ContentFreeSummary,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorPayloadWire {
    request_message_id: serde_json::Value,
    code: ErrorCode,
    summary: ContentFreeSummary,
}

impl<'de> Deserialize<'de> for ErrorPayload {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ErrorPayloadWire::deserialize(deserializer)?;
        Ok(Self {
            request_message_id: if wire.request_message_id.is_null() {
                None
            } else {
                Some(serde_json::from_value(wire.request_message_id).map_err(de::Error::custom)?)
            },
            code: wire.code,
            summary: wire.summary,
        })
    }
}

impl JsonSchema for ErrorPayload {
    fn schema_name() -> Cow<'static, str> {
        "ErrorPayload".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "object",
            "additionalProperties": false,
            "required": ["request_message_id", "code", "summary"],
            "properties": {
                "request_message_id": {
                    "anyOf": [generator.subschema_for::<Uuid>(), {"type": "null"}]
                },
                "code": generator.subschema_for::<ErrorCode>(),
                "summary": generator.subschema_for::<ContentFreeSummary>()
            }
        })
    }
}

/// Messages sent from the extension to the host and from the host to the
/// extension.  The enum intentionally has no editor/provider types.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Payload {
    Hello(HelloPayload),
    HelloAccepted(HelloAcceptedPayload),
    StateSnapshot(StateSnapshotPayload),
    ReadyChanged(ReadyChangedPayload),
    IdentityChanged(IdentityChangedPayload),
    DirtyChanged(DirtyChangedPayload),
    OpenWorkspaceRequested(OpenWorkspaceRequestedPayload),
    NewWindowRequested(NewWindowRequestedPayload),
    RequestStateSnapshot(RequestStateSnapshotPayload),
    Focus(FocusPayload),
    Response(ResponsePayload),
    Error(ErrorPayload),
}

impl Payload {
    pub const fn kind(&self) -> MessageKind {
        match self {
            Self::Hello(_) => MessageKind::Hello,
            Self::HelloAccepted(_) => MessageKind::HelloAccepted,
            Self::StateSnapshot(_) => MessageKind::StateSnapshot,
            Self::ReadyChanged(_) => MessageKind::ReadyChanged,
            Self::IdentityChanged(_) => MessageKind::IdentityChanged,
            Self::DirtyChanged(_) => MessageKind::DirtyChanged,
            Self::OpenWorkspaceRequested(_) => MessageKind::OpenWorkspaceRequested,
            Self::NewWindowRequested(_) => MessageKind::NewWindowRequested,
            Self::RequestStateSnapshot(_) => MessageKind::RequestStateSnapshot,
            Self::Focus(_) => MessageKind::Focus,
            Self::Response(_) => MessageKind::Response,
            Self::Error(_) => MessageKind::Error,
        }
    }

    fn from_kind(kind: MessageKind, value: serde_json::Value) -> Result<Self, ProtocolError> {
        macro_rules! parse {
            ($variant:ident, $type:ty) => {
                serde_json::from_value::<$type>(value)
                    .map(Self::$variant)
                    .map_err(|_| ProtocolError::invalid("invalid bridge payload"))
            };
        }
        match kind {
            MessageKind::Hello => parse!(Hello, HelloPayload),
            MessageKind::HelloAccepted => parse!(HelloAccepted, HelloAcceptedPayload),
            MessageKind::StateSnapshot => parse!(StateSnapshot, StateSnapshotPayload),
            MessageKind::ReadyChanged => parse!(ReadyChanged, ReadyChangedPayload),
            MessageKind::IdentityChanged => parse!(IdentityChanged, IdentityChangedPayload),
            MessageKind::DirtyChanged => parse!(DirtyChanged, DirtyChangedPayload),
            MessageKind::OpenWorkspaceRequested => {
                parse!(OpenWorkspaceRequested, OpenWorkspaceRequestedPayload)
            }
            MessageKind::NewWindowRequested => {
                parse!(NewWindowRequested, NewWindowRequestedPayload)
            }
            MessageKind::RequestStateSnapshot => {
                parse!(RequestStateSnapshot, RequestStateSnapshotPayload)
            }
            MessageKind::Focus => parse!(Focus, FocusPayload),
            MessageKind::Response => parse!(Response, ResponsePayload),
            MessageKind::Error => parse!(Error, ErrorPayload),
        }
    }

    fn to_value(&self) -> Result<serde_json::Value, ProtocolError> {
        macro_rules! value {
            ($value:expr) => {
                serde_json::to_value($value)
                    .map_err(|_| ProtocolError::invalid("invalid bridge payload"))
            };
        }
        match self {
            Self::Hello(value) => value!(value),
            Self::HelloAccepted(value) => value!(value),
            Self::StateSnapshot(value) => value!(value),
            Self::ReadyChanged(value) => value!(value),
            Self::IdentityChanged(value) => value!(value),
            Self::DirtyChanged(value) => value!(value),
            Self::OpenWorkspaceRequested(value) => value!(value),
            Self::NewWindowRequested(value) => value!(value),
            Self::RequestStateSnapshot(value) => value!(value),
            Self::Focus(value) => value!(value),
            Self::Response(value) => value!(value),
            Self::Error(value) => value!(value),
        }
    }
}

impl JsonSchema for Payload {
    fn schema_name() -> Cow<'static, str> {
        "Payload".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "oneOf": [
                generator.subschema_for::<HelloPayload>(),
                generator.subschema_for::<HelloAcceptedPayload>(),
                generator.subschema_for::<StateSnapshotPayload>(),
                generator.subschema_for::<ReadyChangedPayload>(),
                generator.subschema_for::<IdentityChangedPayload>(),
                generator.subschema_for::<DirtyChangedPayload>(),
                generator.subschema_for::<OpenWorkspaceRequestedPayload>(),
                generator.subschema_for::<NewWindowRequestedPayload>(),
                generator.subschema_for::<RequestStateSnapshotPayload>(),
                generator.subschema_for::<FocusPayload>(),
                generator.subschema_for::<ResponsePayload>(),
                generator.subschema_for::<ErrorPayload>()
            ]
        })
    }
}

/// The six-field strict protocol envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Envelope {
    version: u8,
    connection_id: Option<Uuid>,
    sequence: u64,
    message_id: Uuid,
    kind: MessageKind,
    payload: Payload,
}

impl Envelope {
    pub fn new(
        connection_id: Option<Uuid>,
        sequence: u64,
        message_id: Uuid,
        kind: MessageKind,
        payload: Payload,
    ) -> Result<Self, ProtocolError> {
        if sequence == 0 || sequence > MAX_SAFE_INTEGER {
            return Err(ProtocolError::invalid("sequence is outside the safe integer range"));
        }
        if kind != payload.kind() {
            return Err(ProtocolError::invalid("payload does not match message kind"));
        }
        if kind == MessageKind::Hello && (connection_id.is_some() || sequence != 1) {
            return Err(ProtocolError::invalid(
                "hello must use sequence 1 and a null connection ID",
            ));
        }
        if kind == MessageKind::HelloAccepted && sequence != 1 {
            return Err(ProtocolError::invalid("hello acceptance must use server sequence 1"));
        }
        if kind != MessageKind::Hello && connection_id.is_none() {
            return Err(ProtocolError::invalid("non-hello messages require a connection ID"));
        }
        if let Payload::HelloAccepted(payload) = &payload {
            if payload.accepted_version != BRIDGE_PROTOCOL_VERSION
                || payload.connection_generation == 0
            {
                return Err(ProtocolError::invalid("invalid hello acceptance payload"));
            }
        }
        if let Payload::Response(response) = &payload {
            match &response.result {
                ResponseResult::WorkspaceRouted { context: Context::Workspace { .. } }
                | ResponseResult::GlobalRouted { context: Context::Global }
                | ResponseResult::SnapshotWillFollow
                | ResponseResult::Focused => {}
                _ => return Err(ProtocolError::invalid("invalid response result context")),
            }
        }
        let envelope = Self {
            version: BRIDGE_PROTOCOL_VERSION,
            connection_id,
            sequence,
            message_id,
            kind,
            payload,
        };
        envelope.validate()?;
        Ok(envelope)
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self)
            .map_err(|_| ProtocolError::invalid("bridge payload could not be serialized"))?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(ProtocolError::payload_too_large());
        }
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(ProtocolError::payload_too_large());
        }
        let value = serde_json::from_slice::<serde_json::Value>(bytes)
            .map_err(|_| ProtocolError::invalid("invalid bridge message"))?;
        if value
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|version| version != u64::from(BRIDGE_PROTOCOL_VERSION))
        {
            return Err(ProtocolError::unsupported_version());
        }
        serde_json::from_value(value).map_err(|_| ProtocolError::invalid("invalid bridge message"))
    }

    pub fn is_request(&self) -> bool {
        matches!(
            self.kind(),
            MessageKind::OpenWorkspaceRequested
                | MessageKind::NewWindowRequested
                | MessageKind::RequestStateSnapshot
                | MessageKind::Focus
        )
    }

    pub fn is_event(&self) -> bool {
        matches!(
            self.kind(),
            MessageKind::StateSnapshot
                | MessageKind::ReadyChanged
                | MessageKind::IdentityChanged
                | MessageKind::DirtyChanged
        )
    }

    pub const fn version(&self) -> u8 {
        self.version
    }

    pub fn connection_id(&self) -> Option<&Uuid> {
        self.connection_id.as_ref()
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn message_id(&self) -> &Uuid {
        &self.message_id
    }

    pub const fn kind(&self) -> MessageKind {
        self.kind
    }

    pub fn payload(&self) -> &Payload {
        &self.payload
    }

    pub fn into_payload(self) -> Payload {
        self.payload
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        if self.version != BRIDGE_PROTOCOL_VERSION {
            return Err(ProtocolError::unsupported_version());
        }
        if self.sequence == 0 || self.sequence > MAX_SAFE_INTEGER {
            return Err(ProtocolError::invalid("sequence is outside the safe integer range"));
        }
        if self.kind != self.payload.kind() {
            return Err(ProtocolError::invalid("payload does not match message kind"));
        }
        if self.kind == MessageKind::Hello && (self.connection_id.is_some() || self.sequence != 1) {
            return Err(ProtocolError::invalid(
                "hello must use sequence 1 and a null connection ID",
            ));
        }
        if self.kind == MessageKind::HelloAccepted && self.sequence != 1 {
            return Err(ProtocolError::invalid("hello acceptance must use server sequence 1"));
        }
        if self.kind != MessageKind::Hello && self.connection_id.is_none() {
            return Err(ProtocolError::invalid("non-hello messages require a connection ID"));
        }
        if let Payload::HelloAccepted(payload) = &self.payload {
            if payload.accepted_version != BRIDGE_PROTOCOL_VERSION
                || payload.connection_generation == 0
                || payload.connection_generation > MAX_SAFE_INTEGER
            {
                return Err(ProtocolError::invalid("invalid hello acceptance payload"));
            }
        }
        if let Payload::Response(response) = &self.payload {
            match &response.result {
                ResponseResult::WorkspaceRouted { context: Context::Workspace { .. } }
                | ResponseResult::GlobalRouted { context: Context::Global }
                | ResponseResult::SnapshotWillFollow
                | ResponseResult::Focused => {}
                _ => return Err(ProtocolError::invalid("invalid response result context")),
            }
        }
        Ok(())
    }
}

impl JsonSchema for Envelope {
    fn schema_name() -> Cow<'static, str> {
        "BridgeEnvelope".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let uuid = generator.subschema_for::<Uuid>();
        let payload = generator.subschema_for::<Payload>();
        let connection = json_schema!({"anyOf": [{"type": "null"}, uuid.clone()]});
        let mut all_of = Vec::with_capacity(MessageKind::ALL.len());
        for kind in MessageKind::ALL {
            let payload_schema = match kind {
                "hello" => generator.subschema_for::<HelloPayload>(),
                "hello_accepted" => generator.subschema_for::<HelloAcceptedPayload>(),
                "state_snapshot" => generator.subschema_for::<StateSnapshotPayload>(),
                "ready_changed" => generator.subschema_for::<ReadyChangedPayload>(),
                "identity_changed" => generator.subschema_for::<IdentityChangedPayload>(),
                "dirty_changed" => generator.subschema_for::<DirtyChangedPayload>(),
                "open_workspace_requested" => {
                    generator.subschema_for::<OpenWorkspaceRequestedPayload>()
                }
                "new_window_requested" => generator.subschema_for::<NewWindowRequestedPayload>(),
                "request_state_snapshot" => {
                    generator.subschema_for::<RequestStateSnapshotPayload>()
                }
                "focus" => generator.subschema_for::<FocusPayload>(),
                "response" => generator.subschema_for::<ResponsePayload>(),
                "error" => generator.subschema_for::<ErrorPayload>(),
                _ => unreachable!("MessageKind::ALL and payload schemas diverged"),
            };
            let connection_schema =
                if kind == "hello" { json_schema!({"const": null}) } else { uuid.clone() };
            let mut properties = serde_json::Map::new();
            properties.insert("connection_id".to_owned(), connection_schema.to_value());
            properties.insert("payload".to_owned(), payload_schema.to_value());
            if kind == "hello" || kind == "hello_accepted" {
                properties.insert("sequence".to_owned(), json_schema!({"const": 1}).to_value());
            }
            all_of.push(json_schema!({
                "if": {"properties": {"kind": {"const": kind}}},
                "then": {"properties": properties}
            }));
        }
        json_schema!({
            "$id": "https://devhub.local/contracts/bridge/bridge-v1.schema.json",
            "title": "DevHub Bridge v1 envelope",
            "type": "object",
            "additionalProperties": false,
            "required": ["version", "connection_id", "sequence", "message_id", "kind", "payload"],
            "properties": {
                "version": {"const": BRIDGE_PROTOCOL_VERSION},
                "connection_id": connection,
                "sequence": {"type": "integer", "minimum": 1, "maximum": MAX_SAFE_INTEGER},
                "message_id": uuid,
                "kind": generator.subschema_for::<MessageKind>(),
                "payload": payload
            },
            "allOf": all_of
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEnvelope {
    version: u8,
    connection_id: serde_json::Value,
    sequence: u64,
    message_id: Uuid,
    kind: MessageKind,
    payload: serde_json::Value,
}

impl Serialize for Envelope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let payload = self.payload.to_value().map_err(serde::ser::Error::custom)?;
        RawEnvelopeForSerialize {
            version: self.version,
            connection_id: self.connection_id.as_ref(),
            sequence: self.sequence,
            message_id: &self.message_id,
            kind: self.kind,
            payload,
        }
        .serialize(serializer)
    }
}

#[derive(Serialize)]
struct RawEnvelopeForSerialize<'a> {
    version: u8,
    connection_id: Option<&'a Uuid>,
    sequence: u64,
    message_id: &'a Uuid,
    kind: MessageKind,
    payload: serde_json::Value,
}

impl<'de> Deserialize<'de> for Envelope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawEnvelope::deserialize(deserializer)?;
        if raw.version != BRIDGE_PROTOCOL_VERSION {
            return Err(de::Error::custom("unsupported bridge protocol version"));
        }
        let connection_id = if raw.connection_id.is_null() {
            None
        } else {
            Some(serde_json::from_value(raw.connection_id).map_err(de::Error::custom)?)
        };
        let payload = Payload::from_kind(raw.kind, raw.payload).map_err(de::Error::custom)?;
        Self::new(connection_id, raw.sequence, raw.message_id, raw.kind, payload)
            .map_err(de::Error::custom)
    }
}

/// A request that can be sent by either side of the bridge.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientRequest {
    OpenWorkspace(OpenWorkspaceRequestedPayload),
    NewWindow(NewWindowRequestedPayload),
    RequestStateSnapshot(RequestStateSnapshotPayload),
    Focus(FocusPayload),
}

impl ClientRequest {
    pub fn from_payload(payload: &Payload) -> Option<Self> {
        match payload {
            Payload::OpenWorkspaceRequested(payload) => Some(Self::OpenWorkspace(payload.clone())),
            Payload::NewWindowRequested(payload) => Some(Self::NewWindow(payload.clone())),
            Payload::RequestStateSnapshot(payload) => {
                Some(Self::RequestStateSnapshot(payload.clone()))
            }
            Payload::Focus(payload) => Some(Self::Focus(payload.clone())),
            _ => None,
        }
    }

    pub const fn kind(&self) -> MessageKind {
        match self {
            Self::OpenWorkspace(_) => MessageKind::OpenWorkspaceRequested,
            Self::NewWindow(_) => MessageKind::NewWindowRequested,
            Self::RequestStateSnapshot(_) => MessageKind::RequestStateSnapshot,
            Self::Focus(_) => MessageKind::Focus,
        }
    }
}

/// A compact protocol error used by all pure contract APIs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolError {
    code: ErrorCode,
    summary: ContentFreeSummary,
}

impl ProtocolError {
    pub fn invalid(summary: impl Into<String>) -> Self {
        let summary =
            ContentFreeSummary::parse(summary.into()).unwrap_or(ContentFreeSummary::InvalidMessage);
        Self { code: ErrorCode::InvalidMessage, summary }
    }

    pub fn invalid_identity(summary: impl Into<String>) -> Self {
        let summary = ContentFreeSummary::parse(summary.into())
            .unwrap_or(ContentFreeSummary::InvalidIdentity);
        Self { code: ErrorCode::InvalidIdentity, summary }
    }

    pub fn unsupported_version() -> Self {
        Self {
            code: ErrorCode::UnsupportedVersion,
            summary: ContentFreeSummary::UnsupportedVersion,
        }
    }

    pub fn sequence(summary: impl Into<String>) -> Self {
        let summary =
            ContentFreeSummary::parse(summary.into()).unwrap_or(ContentFreeSummary::SequenceError);
        Self { code: ErrorCode::SequenceError, summary }
    }

    pub fn payload_too_large() -> Self {
        Self { code: ErrorCode::PayloadTooLarge, summary: ContentFreeSummary::PayloadTooLarge }
    }

    pub fn id_source_unavailable() -> Self {
        Self {
            code: ErrorCode::SurfaceUnavailable,
            summary: ContentFreeSummary::SecureIdentifierUnavailable,
        }
    }

    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    pub fn summary(&self) -> &str {
        self.summary.as_str()
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.summary())
    }
}

impl std::error::Error for ProtocolError {}

/// A secret used only for loopback upgrade authentication.
pub struct BearerToken(String);

impl BearerToken {
    pub fn new(raw: impl Into<String>) -> Result<Self, AuthError> {
        let raw = raw.into();
        if raw.is_empty()
            || raw.chars().any(|character| character.is_whitespace() || character == '\0')
        {
            return Err(AuthError::Unauthorized);
        }
        Ok(Self(raw))
    }

    fn matches(&self, authorization: Option<&str>) -> bool {
        authorization == Some(&format!("Bearer {}", self.0))
    }
}

impl fmt::Debug for BearerToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BearerToken(REDACTED)")
    }
}

/// A loopback-only endpoint and its ephemeral upgrade token.
pub struct LoopbackEndpoint {
    endpoint: String,
    token: BearerToken,
}

impl LoopbackEndpoint {
    pub fn new(endpoint: impl Into<String>, token: BearerToken) -> Result<Self, AuthError> {
        let endpoint = endpoint.into();
        if !is_loopback_endpoint(&endpoint) || endpoint.contains(&token.0) {
            return Err(AuthError::InvalidEndpoint);
        }
        Ok(Self { endpoint, token })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Validates the exact `Authorization: Bearer <token>` value.  Failure
    /// does not include or expose the supplied token.
    pub fn validate_authorization(&self, authorization: Option<&str>) -> Result<(), AuthError> {
        if self.token.matches(authorization) {
            Ok(())
        } else {
            Err(AuthError::Unauthorized)
        }
    }
}

impl fmt::Debug for LoopbackEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LoopbackEndpoint")
            .field("endpoint", &self.endpoint)
            .field("token", &self.token)
            .finish()
    }
}

fn is_loopback_endpoint(endpoint: &str) -> bool {
    let Some((scheme, rest)) = endpoint.split_once("://") else {
        return false;
    };
    if scheme != "ws" && scheme != "wss" {
        return false;
    }
    if rest.contains(['?', '#']) {
        return false;
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let (host, port) = if let Some(host_and_port) = authority.strip_prefix('[') {
        let Some(end) = host_and_port.find(']') else {
            return false;
        };
        let host = &host_and_port[..end];
        let port = host_and_port[end + 1..].strip_prefix(':');
        (host, port)
    } else {
        let Some((host, port)) = authority.rsplit_once(':') else {
            return false;
        };
        (host, Some(port))
    };
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1");
    let valid_port = port.is_some_and(|port| {
        !port.is_empty()
            && port.bytes().all(|byte| byte.is_ascii_digit())
            && port.parse::<u16>().is_ok_and(|value| value != 0)
    });
    loopback && valid_port
}

/// Authentication failures intentionally have no token-bearing detail.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthError {
    InvalidEndpoint,
    Unauthorized,
}

impl fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidEndpoint => "invalid loopback endpoint",
            Self::Unauthorized => "unauthorized bridge connection",
        })
    }
}

impl std::error::Error for AuthError {}

/// Creates a bearer token without exposing its value in debug output.
pub fn bearer_token(raw: impl Into<String>) -> Result<BearerToken, AuthError> {
    BearerToken::new(raw)
}

/// Validates a raw JSON object against a strict type.  This helper is useful
/// to transport adapters that need to validate nested fixture values without
/// making those values part of their own model.
pub fn decode_strict<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, ProtocolError> {
    serde_json::from_value(value).map_err(|_| ProtocolError::invalid("invalid bridge value"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uuid(value: &str) -> Uuid {
        Uuid::parse(value).expect("fixture UUID")
    }

    fn semver(value: &str) -> SemVer {
        SemVer::parse(value).expect("fixture semver")
    }

    fn path(value: &str) -> AbsolutePath {
        AbsolutePath::parse(value).expect("fixture path")
    }

    fn hello() -> Envelope {
        Envelope::new(
            None,
            1,
            uuid("33333333-3333-4333-8333-333333333333"),
            MessageKind::Hello,
            Payload::Hello(HelloPayload {
                extension_version: semver("0.0.1"),
                surface_id: uuid("11111111-1111-4111-8111-111111111111"),
                workbench_instance_id: uuid("44444444-4444-4444-8444-444444444444"),
            }),
        )
        .expect("valid hello")
    }

    #[test]
    fn every_message_variant_round_trips() {
        let surface = uuid("11111111-1111-4111-8111-111111111111");
        let connection = uuid("55555555-5555-4555-8555-555555555555");
        let workspace = uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let context = Context::workspace(workspace, path("/tmp/devhub-bridge"));
        let payloads = vec![
            Payload::Hello(HelloPayload {
                extension_version: semver("0.0.1"),
                surface_id: surface.clone(),
                workbench_instance_id: uuid("44444444-4444-4444-8444-444444444444"),
            }),
            Payload::HelloAccepted(HelloAcceptedPayload {
                accepted_version: 1,
                surface_id: surface.clone(),
                connection_generation: 1,
            }),
            Payload::StateSnapshot(StateSnapshotPayload {
                surface_id: surface.clone(),
                readiness: Readiness::Ready,
                context: context.clone(),
                dirty: false,
            }),
            Payload::ReadyChanged(ReadyChangedPayload { readiness: Readiness::Unavailable }),
            Payload::IdentityChanged(IdentityChangedPayload { context: Context::Global }),
            Payload::DirtyChanged(DirtyChangedPayload { dirty: true }),
            Payload::OpenWorkspaceRequested(OpenWorkspaceRequestedPayload {
                absolute_path: path("/tmp/devhub-bridge"),
                source: OpenWorkspaceSource::OpenFolder,
            }),
            Payload::NewWindowRequested(NewWindowRequestedPayload {
                absolute_path: None,
                source: NewWindowSource::Unknown,
            }),
            Payload::RequestStateSnapshot(RequestStateSnapshotPayload {
                reason: SnapshotRequestReason::ManualTest,
            }),
            Payload::Focus(FocusPayload { reason: FocusReason::Navigation }),
            Payload::Response(ResponsePayload {
                request_message_id: uuid("77777777-7777-4777-8777-777777777777"),
                result: ResponseResult::WorkspaceRouted { context },
            }),
            Payload::Error(ErrorPayload {
                request_message_id: None,
                code: ErrorCode::ConnectionLost,
                summary: ContentFreeSummary::parse("connection lost").expect("summary"),
            }),
        ];
        for (index, payload) in payloads.into_iter().enumerate() {
            let kind = payload.kind();
            let connection_id = (kind != MessageKind::Hello).then(|| connection.clone());
            let sequence = if kind == MessageKind::HelloAccepted { 1 } else { index as u64 + 1 };
            let message = Envelope::new(connection_id, sequence, Uuid::fresh(), kind, payload)
                .expect("valid message");
            let decoded = Envelope::decode(&message.encode().expect("encode")).expect("decode");
            assert_eq!(decoded, message);
        }
    }

    #[test]
    fn strict_envelope_rejects_unknown_fields_and_bad_ids() {
        let mut value = serde_json::to_value(hello()).expect("serialize hello");
        value["unknown"] = serde_json::Value::Bool(true);
        assert!(Envelope::decode(value.to_string().as_bytes()).is_err());

        let mut value = serde_json::to_value(hello()).expect("serialize hello");
        value["version"] = serde_json::Value::from(2_u8);
        assert_eq!(
            Envelope::decode(value.to_string().as_bytes()).expect_err("unsupported version").code(),
            ErrorCode::UnsupportedVersion
        );

        let mut value = serde_json::to_value(
            Envelope::new(
                Some(uuid("55555555-5555-4555-8555-555555555555")),
                2,
                uuid("66666666-6666-4666-8666-666666666666"),
                MessageKind::StateSnapshot,
                Payload::StateSnapshot(StateSnapshotPayload {
                    surface_id: uuid("11111111-1111-4111-8111-111111111111"),
                    readiness: Readiness::Ready,
                    context: Context::Global,
                    dirty: false,
                }),
            )
            .expect("snapshot"),
        )
        .expect("serialize snapshot");
        value["payload"]["context"]["unknown"] = serde_json::Value::Bool(true);
        assert!(Envelope::decode(value.to_string().as_bytes()).is_err());

        let mut value = serde_json::to_value(hello()).expect("serialize hello");
        value["message_id"] =
            serde_json::Value::String("33333333-3333-4333-8333-33333333333A".to_owned());
        assert!(Envelope::decode(value.to_string().as_bytes()).is_err());
    }

    #[test]
    fn encode_revalidates_private_invariants_and_id_source_is_injectable() {
        let mut invalid = hello();
        invalid.sequence = 0;
        assert!(invalid.encode().is_err());

        struct FakeSource {
            next: Result<Uuid, IdSourceError>,
        }
        impl IdSource for FakeSource {
            fn next_uuid(&mut self) -> Result<Uuid, IdSourceError> {
                self.next.clone()
            }
        }

        let expected = uuid("99999999-9999-4999-8999-999999999999");
        let mut fake = FakeSource { next: Ok(expected.clone()) };
        assert_eq!(Uuid::from_source(&mut fake).expect("fake UUID"), expected);
        let mut failed = FakeSource { next: Err(IdSourceError::Unavailable("test".into())) };
        assert_eq!(Uuid::from_source(&mut failed), Err(IdSourceError::Unavailable("test".into())));
    }

    #[test]
    fn safe_integer_limits_are_enforced() {
        let message = Envelope::new(
            Some(uuid("55555555-5555-4555-8555-555555555555")),
            MAX_SAFE_INTEGER,
            uuid("33333333-3333-4333-8333-333333333333"),
            MessageKind::StateSnapshot,
            Payload::StateSnapshot(StateSnapshotPayload {
                surface_id: uuid("11111111-1111-4111-8111-111111111111"),
                readiness: Readiness::Ready,
                context: Context::Global,
                dirty: false,
            }),
        )
        .expect("maximum safe sequence");
        assert!(message.encode().is_ok());
        assert!(Envelope::new(
            Some(uuid("55555555-5555-4555-8555-555555555555")),
            MAX_SAFE_INTEGER + 1,
            uuid("33333333-3333-4333-8333-333333333333"),
            MessageKind::StateSnapshot,
            Payload::StateSnapshot(StateSnapshotPayload {
                surface_id: uuid("11111111-1111-4111-8111-111111111111"),
                readiness: Readiness::Ready,
                context: Context::Global,
                dirty: false,
            }),
        )
        .is_err());
    }

    #[test]
    fn path_and_size_limits_are_strict() {
        assert!(AbsolutePath::parse("relative").is_err());
        assert!(AbsolutePath::parse("/tmp/../secret").is_err());
        assert!(AbsolutePath::parse("/tmp//secret").is_err());
        assert!(AbsolutePath::normalize("/tmp/../secret").is_ok());
        assert!(ContentFreeSummary::parse("x".repeat(257)).is_err());
        assert!(ContentFreeSummary::parse("/Users/private/secret.txt").is_err());

        let bytes = vec![b' '; MAX_MESSAGE_BYTES + 1];
        assert_eq!(
            Envelope::decode(&bytes).expect_err("oversize").code(),
            ErrorCode::PayloadTooLarge
        );
    }

    #[test]
    fn checked_in_fixtures_are_owned_by_the_rust_decoder() {
        for line in include_str!("../../../../contracts/bridge/valid.ndjson").lines() {
            Envelope::decode(line.as_bytes()).expect("valid bridge fixture");
        }
        for line in include_str!("../../../../contracts/bridge/invalid.ndjson").lines() {
            assert!(Envelope::decode(line.as_bytes()).is_err(), "invalid fixture decoded: {line}");
        }
    }

    #[test]
    fn bearer_debug_never_leaks_token() {
        let endpoint = LoopbackEndpoint::new(
            "ws://127.0.0.1:1234/bridge",
            bearer_token("super-secret").expect("token"),
        )
        .expect("endpoint");
        assert!(format!("{endpoint:?}").contains("REDACTED"));
        assert!(!format!("{endpoint:?}").contains("super-secret"));
        assert!(endpoint.validate_authorization(Some("Bearer super-secret")).is_ok());
        assert!(endpoint.validate_authorization(Some("Bearer wrong")).is_err());
        assert!(LoopbackEndpoint::new(
            "ws://192.168.0.1:1234/bridge",
            bearer_token("token").expect("token"),
        )
        .is_err());
    }
}
