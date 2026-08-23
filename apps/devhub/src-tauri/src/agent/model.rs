//! Provider-private mappings and bounded projection helpers.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use devhub_app_core::{
    AgentId, AgentProfile, AgentProfileKind, AgentStatus, OpaqueProviderMapping, RuntimeHealth,
    WorkspaceId, WorkspaceRoot,
};

use super::control::TerminalControl;
use super::error::{AgentRuntimeError, AgentRuntimeErrorCode};

pub(crate) const MAX_PROFILE_ARGS: usize = 64;
pub(crate) const MAX_PROFILE_ARG_BYTES: usize = 16 * 1024;
pub(crate) const MAX_PROFILE_ENV: usize = 128;
pub(crate) const MAX_PROFILE_ENV_KEY_BYTES: usize = 256;
pub(crate) const MAX_PROFILE_ENV_VALUE_BYTES: usize = 16 * 1024;
/// Conservative combined JSON budget for profile args/env. Herdr accepts
/// initial API lines below 1 MiB; this leaves headroom for request IDs,
/// workspace metadata, escaping, and the terminating newline.
pub(crate) const MAX_PROFILE_WIRE_BYTES: usize = 900 * 1024;
pub(crate) const MAX_PROVIDER_ID_BYTES: usize = 512;
pub(crate) const MAX_SURFACE_KEY_BYTES: usize = 256;
pub(crate) const MAX_TOMBSTONES: usize = 1_024;
pub(crate) const MAX_TOMBSTONE_ATTEMPTS: u8 = 8;
pub(crate) const CLEANUP_RETRY_BASE: Duration = Duration::from_millis(100);
pub(crate) const RUNTIME_JOURNAL_SCHEMA_VERSION: u16 = 1;
const MAX_RUNTIME_JOURNAL_BYTES: usize = 512 * 1024;
const RUNTIME_JOURNAL_BACKUP_SUFFIX: &str = ".bak";
static RUNTIME_JOURNAL_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentRuntimeHealthState {
    Starting,
    Healthy,
    Degraded,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AgentRuntimeHealth {
    state: AgentRuntimeHealthState,
    diagnostic: Option<AgentRuntimeErrorCode>,
}

impl AgentRuntimeHealth {
    pub(crate) const fn starting() -> Self {
        Self { state: AgentRuntimeHealthState::Starting, diagnostic: None }
    }

    pub(crate) const fn healthy() -> Self {
        Self { state: AgentRuntimeHealthState::Healthy, diagnostic: None }
    }

    pub(crate) const fn degraded(code: AgentRuntimeErrorCode) -> Self {
        Self { state: AgentRuntimeHealthState::Degraded, diagnostic: Some(code) }
    }

    pub(crate) const fn unavailable(code: AgentRuntimeErrorCode) -> Self {
        Self { state: AgentRuntimeHealthState::Unavailable, diagnostic: Some(code) }
    }

    pub(crate) const fn failed(code: AgentRuntimeErrorCode) -> Self {
        Self { state: AgentRuntimeHealthState::Failed, diagnostic: Some(code) }
    }

    pub const fn state(self) -> AgentRuntimeHealthState {
        self.state
    }

    pub const fn diagnostic(self) -> Option<AgentRuntimeErrorCode> {
        self.diagnostic
    }

    pub const fn is_ready(self) -> bool {
        matches!(self.state, AgentRuntimeHealthState::Healthy)
    }

    pub const fn runtime_health(self) -> RuntimeHealth {
        match self.state {
            AgentRuntimeHealthState::Starting => RuntimeHealth::Starting,
            AgentRuntimeHealthState::Healthy => RuntimeHealth::Healthy,
            AgentRuntimeHealthState::Degraded => RuntimeHealth::Degraded,
            AgentRuntimeHealthState::Unavailable => RuntimeHealth::Unavailable,
            AgentRuntimeHealthState::Failed => RuntimeHealth::Failed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderProfile {
    pub(crate) kind: &'static str,
    pub(crate) args: Vec<String>,
    pub(crate) env: BTreeMap<String, String>,
}

pub(crate) fn validate_profile(
    profile: &AgentProfile,
) -> Result<ProviderProfile, AgentRuntimeError> {
    let kind = match profile.kind() {
        AgentProfileKind::Codex => "codex",
        AgentProfileKind::Claude => "claude",
    };
    if profile.args().len() > MAX_PROFILE_ARGS
        || profile
            .args()
            .iter()
            .any(|arg| arg.chars().any(char::is_control) || arg.len() > MAX_PROFILE_ARG_BYTES)
        || profile.env().len() > MAX_PROFILE_ENV
        || profile.env().iter().any(|(key, value)| {
            key.is_empty()
                || key.len() > MAX_PROFILE_ENV_KEY_BYTES
                || value.len() > MAX_PROFILE_ENV_VALUE_BYTES
                || key.chars().any(char::is_control)
                || value.chars().any(char::is_control)
                || !valid_environment_key(key)
        })
    {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::InvalidProfile));
    }
    let aggregate_request = json!({
        "id": "devhub-agent-workspace.create",
        "method": "workspace.create",
        "params": {
            "cwd": "/",
            "focus": false,
            "label": "devhub-agent-profile-budget",
            "env": profile.env(),
            "args": profile.args(),
        },
    });
    let aggregate_size = serde_json::to_vec(&aggregate_request)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::InvalidProfile))?
        .len()
        .saturating_add(1);
    if aggregate_size >= MAX_PROFILE_WIRE_BYTES {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::InvalidProfile));
    }
    Ok(ProviderProfile { kind, args: profile.args().to_vec(), env: profile.env().clone() })
}

fn valid_environment_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ProviderMapping {
    pub(crate) workspace_id: String,
    pub(crate) tab_id: String,
    pub(crate) pane_id: String,
    pub(crate) terminal_id: String,
    pub(crate) workspace_root: PathBuf,
    pub(crate) workspace_domain_id: Option<WorkspaceId>,
    pub(crate) generation: u64,
}

/// The only value that crosses the core StateStore seam. Its serialized
/// contents are deliberately private to this adapter; the core can persist
/// and return the value without learning provider identifiers or semantics.
#[derive(Debug, Serialize, Deserialize)]
struct OpaqueMappingRecord {
    version: u8,
    workspace_id: String,
    tab_id: String,
    pane_id: String,
    terminal_id: String,
    workspace_root: String,
    workspace_domain_id: Option<String>,
    generation: u64,
}

pub(crate) fn encode_provider_mapping(
    mapping: &ProviderMapping,
) -> Result<OpaqueProviderMapping, AgentRuntimeError> {
    let workspace_root = mapping
        .workspace_root
        .to_str()
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProviderRejected))?;
    let value = serde_json::to_string(&OpaqueMappingRecord {
        version: 1,
        workspace_id: mapping.workspace_id.clone(),
        tab_id: mapping.tab_id.clone(),
        pane_id: mapping.pane_id.clone(),
        terminal_id: mapping.terminal_id.clone(),
        workspace_root: workspace_root.to_owned(),
        workspace_domain_id: mapping.workspace_domain_id.as_ref().map(ToString::to_string),
        generation: mapping.generation,
    })
    .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Internal))?;
    if value.len() > MAX_OPAQUE_MAPPING_BYTES {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
    }
    OpaqueProviderMapping::new(value)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput))
}

pub(crate) fn decode_provider_mapping(
    value: &OpaqueProviderMapping,
) -> Result<ProviderMapping, AgentRuntimeError> {
    let record: OpaqueMappingRecord = serde_json::from_str(value.as_str())
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))?;
    if record.version != 1 {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch));
    }
    let workspace_domain_id = record
        .workspace_domain_id
        .map(|raw| {
            raw.parse::<WorkspaceId>()
                .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))
        })
        .transpose()?;
    let workspace_root = WorkspaceRoot::new(record.workspace_root)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))?
        .as_path()
        .to_path_buf();
    Ok(ProviderMapping {
        workspace_id: bounded_provider_id(record.workspace_id)?,
        tab_id: bounded_provider_id(record.tab_id)?,
        pane_id: bounded_provider_id(record.pane_id)?,
        terminal_id: bounded_provider_id(record.terminal_id)?,
        workspace_root,
        workspace_domain_id,
        generation: record.generation,
    })
}

/// Herdr names are provider-only. Encode the complete UUID into base-36 so
/// the name is deterministic and remains within Herdr's 32-byte grammar.
pub(crate) fn provider_agent_name(agent_id: &AgentId) -> String {
    let mut value = 0_u128;
    let mut valid_uuid = true;
    let mut digits = 0_u8;
    for byte in agent_id.as_str().bytes() {
        if byte == b'-' {
            continue;
        }
        let Some(digit) = (byte as char).to_digit(16) else {
            valid_uuid = false;
            break;
        };
        value = value.saturating_mul(16).saturating_add(u128::from(digit));
        digits = digits.saturating_add(1);
    }
    if !valid_uuid || digits != 32 {
        value = agent_id.as_str().bytes().fold(0_u128, |hash, byte| {
            hash.wrapping_mul(0x100000001b3).wrapping_add(u128::from(byte))
        });
    }
    let mut encoded = [b'0'; 25];
    let alphabet = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut cursor = encoded.len();
    while value > 0 && cursor > 0 {
        cursor -= 1;
        encoded[cursor] = alphabet[(value % 36) as usize];
        value /= 36;
    }
    let suffix = std::str::from_utf8(&encoded[cursor..]).unwrap_or("0");
    format!("a{suffix}")
}

const MAX_OPAQUE_MAPPING_BYTES: usize = 16 * 1024;

impl std::fmt::Debug for ProviderMapping {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProviderMapping")
            .field("workspace_id", &"<redacted>")
            .field("tab_id", &"<redacted>")
            .field("pane_id", &"<redacted>")
            .field("terminal_id", &"<redacted>")
            .field("workspace_root", &"<redacted>")
            .field("generation", &self.generation)
            .finish()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TombstoneReason {
    NaturalExit,
    ExplicitStop,
}

#[derive(Clone)]
pub(crate) struct CleanupTombstone {
    pub(crate) mapping: ProviderMapping,
    pub(crate) reason: TombstoneReason,
    pub(crate) attempts: u8,
    pub(crate) next_retry: Instant,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeJournal {
    schema_version: u16,
    tombstones: Vec<RuntimeJournalTombstone>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeJournalTombstone {
    agent_id: String,
    mapping: String,
    reason: String,
    attempts: u8,
}

pub(crate) fn load_cleanup_journal(
    path: &Path,
) -> Result<BTreeMap<AgentId, CleanupTombstone>, AgentRuntimeError> {
    let primary = read_private_file(path)?;
    let backup_path = sibling_with_suffix(path, RUNTIME_JOURNAL_BACKUP_SUFFIX);
    let backup = if primary.is_some() { None } else { read_private_file(&backup_path)? };
    let Some(bytes) = primary.as_deref().or(backup.as_deref()) else {
        return Ok(BTreeMap::new());
    };
    match decode_cleanup_journal(bytes) {
        Ok(tombstones) => return Ok(tombstones),
        Err(_) if primary.is_none() => {
            // A corrupt backup cannot be used, but quarantine it before
            // starting fresh so the failure is recoverable/auditable.
            quarantine_and_sync(&backup_path)
                .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?;
            return Ok(BTreeMap::new());
        }
        Err(_) => {}
    }

    // The primary is corrupt. Quarantine it before consulting the backup;
    // a valid previous commit remains available without silently deleting
    // evidence of the failed write.
    quarantine_and_sync(path)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?;
    let Some(backup_bytes) = read_private_file(&backup_path)? else {
        return Ok(BTreeMap::new());
    };
    match decode_cleanup_journal(&backup_bytes) {
        Ok(tombstones) => Ok(tombstones),
        Err(_) => {
            quarantine_and_sync(&backup_path)
                .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?;
            Ok(BTreeMap::new())
        }
    }
}

fn decode_cleanup_journal(
    bytes: &[u8],
) -> Result<BTreeMap<AgentId, CleanupTombstone>, AgentRuntimeError> {
    if bytes.len() > MAX_RUNTIME_JOURNAL_BYTES {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
    }
    let journal: RuntimeJournal = serde_json::from_slice(bytes)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))?;
    if journal.schema_version != RUNTIME_JOURNAL_SCHEMA_VERSION
        || journal.tombstones.len() > MAX_TOMBSTONES
    {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch));
    }
    let mut tombstones = BTreeMap::new();
    for record in journal.tombstones {
        let agent_id = record
            .agent_id
            .parse::<AgentId>()
            .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))?;
        let mapping = decode_provider_mapping(
            &OpaqueProviderMapping::new(record.mapping)
                .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))?,
        )?;
        let reason = match record.reason.as_str() {
            "natural_exit" => TombstoneReason::NaturalExit,
            "explicit_stop" => TombstoneReason::ExplicitStop,
            _ => return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch)),
        };
        if tombstones
            .insert(
                agent_id,
                CleanupTombstone {
                    mapping,
                    reason,
                    attempts: record.attempts,
                    next_retry: Instant::now(),
                },
            )
            .is_some()
        {
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch));
        }
    }
    Ok(tombstones)
}

pub(crate) fn save_cleanup_journal(
    path: &Path,
    tombstones: &BTreeMap<AgentId, CleanupTombstone>,
) -> Result<(), AgentRuntimeError> {
    if tombstones.len() > MAX_TOMBSTONES {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::CleanupPending));
    }
    let mut records = Vec::with_capacity(tombstones.len());
    for (agent_id, tombstone) in tombstones {
        let mapping = encode_provider_mapping(&tombstone.mapping)?;
        records.push(RuntimeJournalTombstone {
            agent_id: agent_id.to_string(),
            mapping: mapping.as_str().to_owned(),
            reason: match tombstone.reason {
                TombstoneReason::NaturalExit => "natural_exit".to_owned(),
                TombstoneReason::ExplicitStop => "explicit_stop".to_owned(),
            },
            attempts: tombstone.attempts,
        });
    }
    let bytes = serde_json::to_vec(&RuntimeJournal {
        schema_version: RUNTIME_JOURNAL_SCHEMA_VERSION,
        tombstones: records,
    })
    .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Internal))?;
    if bytes.len() > MAX_RUNTIME_JOURNAL_BYTES {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?;
    ensure_directory_chain(parent)?;
    ensure_private_target(path)?;
    let backup_path = sibling_with_suffix(path, RUNTIME_JOURNAL_BACKUP_SUFFIX);
    ensure_private_target(&backup_path)?;

    // Keep the last known-good primary as recovery evidence. A corrupt
    // primary is quarantined and deliberately does not poison the backup.
    if let Some(primary_bytes) = read_private_file(path)? {
        if decode_cleanup_journal(&primary_bytes).is_err() {
            quarantine_and_sync(path)
                .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?;
        } else {
            copy_private(path, &backup_path, parent)?;
        }
    }

    let temporary = temporary_path(path);
    let write_result = (|| {
        let mut file = open_private_new(&temporary)?;
        file.write_all(&bytes).map_err(map_journal_io)?;
        file.sync_all().map_err(map_journal_io)?;
        drop(file);
        fs::rename(&temporary, path).map_err(map_journal_io)?;
        sync_directory(parent).map_err(map_journal_io)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn read_private_file(path: &Path) -> Result<Option<Vec<u8>>, AgentRuntimeError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable));
    }
    ensure_private_permissions(&metadata)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use nix::fcntl::OFlag;
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(OFlag::O_NOFOLLOW.bits());
    }
    let file = options
        .open(path)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?;
    let mut bytes = Vec::new();
    file.take((MAX_RUNTIME_JOURNAL_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?;
    Ok(Some(bytes))
}

fn ensure_private_target(path: &Path) -> Result<(), AgentRuntimeError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))
        }
        Ok(metadata) => ensure_private_permissions(&metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable)),
    }
}

fn ensure_private_permissions(metadata: &fs::Metadata) -> Result<(), AgentRuntimeError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable));
        }
    }
    let _ = metadata;
    Ok(())
}

fn ensure_directory_chain(path: &Path) -> Result<(), AgentRuntimeError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let (metadata, created) = match fs::symlink_metadata(&current) {
            Ok(metadata) => (metadata, false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?;
                (
                    fs::symlink_metadata(&current)
                        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?,
                    true,
                )
            }
            Err(_) => return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable));
        }
        if created {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&current, fs::Permissions::from_mode(0o700))
                    .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))?;
            }
        }
    }
    Ok(())
}

fn open_private_new(path: &Path) -> Result<File, AgentRuntimeError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use nix::fcntl::OFlag;
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(OFlag::O_NOFOLLOW.bits());
    }
    options.open(path).map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))
}

fn copy_private(from: &Path, to: &Path, parent: &Path) -> Result<(), AgentRuntimeError> {
    let Some(bytes) = read_private_file(from)? else {
        return Ok(());
    };
    let temporary = temporary_path(to);
    let copy_result = (|| {
        let mut file = open_private_new(&temporary)?;
        file.write_all(&bytes).map_err(map_journal_io)?;
        file.sync_all().map_err(map_journal_io)?;
        drop(file);
        fs::rename(&temporary, to).map_err(map_journal_io)?;
        sync_directory(parent).map_err(map_journal_io)
    })();
    if copy_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    copy_result
}

fn map_journal_io(_: io::Error) -> AgentRuntimeError {
    AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable)
}

fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path).and_then(|directory| directory.sync_all())
}

fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("journal.json");
    path.with_file_name(format!("{file_name}{suffix}"))
}

fn temporary_path(path: &Path) -> PathBuf {
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("journal.json");
    let counter = RUNTIME_JOURNAL_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!("{file_name}.tmp.{}.{}", std::process::id(), counter))
}

fn quarantine_and_sync(path: &Path) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("journal.json");
    for suffix in 0..1_000_u32 {
        let candidate = path.with_file_name(format!("{file_name}.corrupt.{suffix}"));
        if fs::symlink_metadata(&candidate).is_ok() {
            continue;
        }
        match fs::rename(path, &candidate) {
            Ok(()) => return sync_directory(parent),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "journal quarantine slots exhausted"))
}

impl std::fmt::Debug for CleanupTombstone {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CleanupTombstone")
            .field("mapping", &self.mapping)
            .field("reason", &self.reason)
            .field("attempts", &self.attempts)
            .finish()
    }
}

impl std::fmt::Debug for TombstoneReason {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::NaturalExit => "natural_exit",
            Self::ExplicitStop => "explicit_stop",
        })
    }
}

#[derive(Default)]
pub(crate) struct AgentRuntimeState {
    pub(crate) mappings: BTreeMap<AgentId, ProviderMapping>,
    /// Provider-private proof that this mapping has been observed as an
    /// active agent. Herdr can clear the detected label after exit while the
    /// pane remains alive, so absence is only exit evidence after confirmation.
    pub(crate) confirmed_agents: BTreeSet<AgentId>,
    pub(crate) workspace_roots: BTreeMap<AgentId, (WorkspaceId, WorkspaceRoot)>,
    pub(crate) tombstones: BTreeMap<AgentId, CleanupTombstone>,
    pub(crate) stopping: BTreeSet<AgentId>,
    pub(crate) surfaces: BTreeMap<String, AgentId>,
    pub(crate) controls: BTreeMap<String, Arc<dyn TerminalControl>>,
    pub(crate) next_generation: u64,
}

impl AgentRuntimeState {
    pub(crate) fn next_generation(&mut self) -> u64 {
        self.next_generation = self.next_generation.saturating_add(1).max(1);
        self.next_generation
    }

    pub(crate) fn add_tombstone(
        &mut self,
        agent_id: AgentId,
        mapping: ProviderMapping,
        reason: TombstoneReason,
    ) -> Result<(), AgentRuntimeError> {
        self.confirmed_agents.remove(&agent_id);
        if self.tombstones.len() >= MAX_TOMBSTONES && !self.tombstones.contains_key(&agent_id) {
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::CleanupPending));
        }
        self.tombstones.entry(agent_id).or_insert_with(|| CleanupTombstone {
            mapping,
            reason,
            attempts: 0,
            next_retry: Instant::now(),
        });
        Ok(())
    }

    pub(crate) fn record_cleanup_failure(&mut self, agent_id: &AgentId) {
        if let Some(tombstone) = self.tombstones.get_mut(agent_id) {
            tombstone.attempts = tombstone.attempts.saturating_add(1);
            let exponent = u32::from(tombstone.attempts.min(4));
            tombstone.next_retry =
                Instant::now() + CLEANUP_RETRY_BASE.saturating_mul(2_u32.saturating_pow(exponent));
        }
    }

    pub(crate) fn take_surfaces(&mut self, agent_id: &AgentId) -> Vec<Arc<dyn TerminalControl>> {
        let keys = self
            .surfaces
            .iter()
            .filter(|(_, owner)| *owner == agent_id)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let mut controls = Vec::with_capacity(keys.len());
        for key in keys {
            self.surfaces.remove(&key);
            if let Some(control) = self.controls.remove(&key) {
                controls.push(control);
            }
        }
        controls
    }
}

/// Provider snapshot data is private and intentionally lossy. Only fields
/// required for reconciliation and mapping recovery are retained.
#[derive(Debug, Clone, Default)]
pub(crate) struct ProviderSnapshot {
    pub(crate) workspaces: Vec<ProviderWorkspace>,
    pub(crate) panes: Vec<ProviderPane>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ProviderWorkspace {
    pub(crate) id: String,
    pub(crate) label: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ProviderPane {
    pub(crate) id: String,
    pub(crate) terminal_id: String,
    pub(crate) workspace_id: String,
    pub(crate) tab_id: String,
    pub(crate) agent: Option<String>,
    pub(crate) status: ProviderStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum ProviderStatus {
    Idle,
    Working,
    Blocked,
    Done,
    #[default]
    Unknown,
}

impl ProviderStatus {
    pub(crate) fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("idle") => Self::Idle,
            Some("working") => Self::Working,
            Some("blocked") => Self::Blocked,
            Some("done") => Self::Done,
            _ => Self::Unknown,
        }
    }

    pub(crate) fn is_exited(self) -> bool {
        matches!(self, Self::Done)
    }

    pub(crate) fn project(self) -> (AgentStatus, RuntimeHealth) {
        match self {
            Self::Working => (AgentStatus::Working, RuntimeHealth::Healthy),
            Self::Blocked => (AgentStatus::Waiting, RuntimeHealth::Healthy),
            Self::Idle => (AgentStatus::Idle, RuntimeHealth::Healthy),
            Self::Done => (AgentStatus::Idle, RuntimeHealth::Healthy),
            Self::Unknown => (AgentStatus::Error, RuntimeHealth::Degraded),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawSessionSnapshot {
    #[serde(default)]
    workspaces: Vec<RawWorkspace>,
    #[serde(default)]
    panes: Vec<RawPane>,
}

#[derive(Debug, Deserialize)]
struct RawWorkspace {
    workspace_id: String,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawPane {
    pane_id: String,
    terminal_id: String,
    workspace_id: String,
    tab_id: String,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    agent_status: Option<String>,
}

pub(crate) fn parse_session_snapshot(value: &Value) -> Result<ProviderSnapshot, AgentRuntimeError> {
    let raw = value
        .get("snapshot")
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProviderRejected))?;
    let raw: RawSessionSnapshot = serde_json::from_value(raw.clone())
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::ProviderRejected))?;
    if raw.workspaces.len().saturating_add(raw.panes.len()) > 16_384 {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
    }
    let workspaces = raw
        .workspaces
        .into_iter()
        .map(|workspace| {
            Ok(ProviderWorkspace {
                id: bounded_provider_id(workspace.workspace_id)?,
                label: workspace.label.and_then(|label| bounded_label(label).ok()),
            })
        })
        .collect::<Result<Vec<_>, AgentRuntimeError>>()?;
    let panes = raw
        .panes
        .into_iter()
        .map(|pane| {
            Ok(ProviderPane {
                id: bounded_provider_id(pane.pane_id)?,
                terminal_id: bounded_provider_id(pane.terminal_id)?,
                workspace_id: bounded_provider_id(pane.workspace_id)?,
                tab_id: bounded_provider_id(pane.tab_id)?,
                agent: pane.agent.and_then(|agent| bounded_label(agent).ok()),
                status: ProviderStatus::from_wire(pane.agent_status.as_deref()),
            })
        })
        .collect::<Result<Vec<_>, AgentRuntimeError>>()?;
    Ok(ProviderSnapshot { workspaces, panes })
}

pub(crate) fn parse_created_mapping(
    value: &Value,
    workspace_root: PathBuf,
    workspace_domain_id: Option<WorkspaceId>,
    generation: u64,
) -> Result<ProviderMapping, AgentRuntimeError> {
    let workspace = value
        .get("workspace")
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProviderRejected))?;
    let tab = value
        .get("tab")
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProviderRejected))?;
    let pane = value
        .get("root_pane")
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProviderRejected))?;
    let workspace_id = bounded_provider_id(field_string(workspace, "workspace_id")?)?;
    let tab_id = bounded_provider_id(field_string(tab, "tab_id")?)?;
    let pane_id = bounded_provider_id(field_string(pane, "pane_id")?)?;
    let terminal_id = bounded_provider_id(field_string(pane, "terminal_id")?)?;
    Ok(ProviderMapping {
        workspace_id,
        tab_id,
        pane_id,
        terminal_id,
        workspace_root,
        workspace_domain_id,
        generation,
    })
}

/// Best-effort mapping used only when workspace creation returned a malformed
/// response after creating provider resources. Cleanup needs only workspace
/// and pane IDs; synthetic values keep the retry record schema complete while
/// never exposing a partial provider response at the domain boundary.
pub(crate) fn cleanup_mapping_from_created(
    value: &Value,
    workspace_root: PathBuf,
    workspace_domain_id: Option<WorkspaceId>,
    generation: u64,
) -> Option<ProviderMapping> {
    let workspace_id = value
        .get("workspace")
        .and_then(|workspace| field_string(workspace, "workspace_id").ok())
        .and_then(|value| bounded_provider_id(value).ok())?;
    let pane = value.get("root_pane")?;
    let pane_id =
        field_string(pane, "pane_id").ok().and_then(|value| bounded_provider_id(value).ok())?;
    let tab_id = value
        .get("tab")
        .and_then(|tab| field_string(tab, "tab_id").ok())
        .and_then(|value| bounded_provider_id(value).ok())
        .unwrap_or_else(|| "cleanup-tab-unavailable".to_owned());
    let terminal_id = field_string(pane, "terminal_id")
        .ok()
        .and_then(|value| bounded_provider_id(value).ok())
        .unwrap_or_else(|| "cleanup-terminal-unavailable".to_owned());
    Some(ProviderMapping {
        workspace_id,
        tab_id,
        pane_id,
        terminal_id,
        workspace_root,
        workspace_domain_id,
        generation,
    })
}

pub(crate) fn terminal_id_from_started(value: &Value) -> Result<String, AgentRuntimeError> {
    let agent = value
        .get("agent")
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProviderRejected))?;
    bounded_provider_id(field_string(agent, "terminal_id")?)
}

fn field_string(value: &Value, field: &str) -> Result<String, AgentRuntimeError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProviderRejected))
}

fn bounded_provider_id(value: String) -> Result<String, AgentRuntimeError> {
    if value.is_empty()
        || value.len() > MAX_PROVIDER_ID_BYTES
        || value.chars().any(char::is_control)
    {
        Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput))
    } else {
        Ok(value)
    }
}

fn bounded_label(value: String) -> Result<String, AgentRuntimeError> {
    if value.len() > MAX_PROVIDER_ID_BYTES || value.chars().any(char::is_control) {
        Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput))
    } else {
        Ok(value)
    }
}

pub(crate) fn marker_label(agent_id: &AgentId) -> String {
    format!("devhub-agent-{}", agent_id.as_str())
}

pub(crate) fn recover_mapping(
    snapshot: &ProviderSnapshot,
    agent_id: &AgentId,
    root: PathBuf,
    workspace_domain_id: Option<WorkspaceId>,
    generation: u64,
) -> Option<ProviderMapping> {
    let label = marker_label(agent_id);
    let workspace = snapshot
        .workspaces
        .iter()
        .find(|workspace| workspace.label.as_deref() == Some(label.as_str()))?;
    let pane = snapshot
        .panes
        .iter()
        .find(|pane| pane.workspace_id == workspace.id && pane.agent.is_some())
        .or_else(|| snapshot.panes.iter().find(|pane| pane.workspace_id == workspace.id))?;
    Some(ProviderMapping {
        workspace_id: workspace.id.clone(),
        tab_id: pane.tab_id.clone(),
        pane_id: pane.id.clone(),
        terminal_id: pane.terminal_id.clone(),
        workspace_root: root,
        workspace_domain_id,
        generation,
    })
}

pub(crate) fn pane_for<'a>(
    snapshot: &'a ProviderSnapshot,
    mapping: &ProviderMapping,
) -> Option<&'a ProviderPane> {
    snapshot.panes.iter().find(|pane| pane.id == mapping.pane_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use devhub_app_core::AgentProfileId;

    fn profile(
        kind: AgentProfileKind,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    ) -> AgentProfile {
        AgentProfile::new(
            AgentProfileId::from_slug("profile").expect("profile id"),
            "Profile",
            kind,
            args,
            env,
        )
        .expect("profile")
    }

    #[test]
    fn supported_profiles_map_without_provider_ids() {
        let codex =
            validate_profile(&profile(AgentProfileKind::Codex, Vec::new(), BTreeMap::new()))
                .expect("codex");
        assert_eq!(codex.kind, "codex");
        let claude =
            validate_profile(&profile(AgentProfileKind::Claude, Vec::new(), BTreeMap::new()))
                .expect("claude");
        assert_eq!(claude.kind, "claude");
    }

    #[test]
    fn profile_environment_names_and_bounds_are_rechecked_at_launch() {
        let mut env = BTreeMap::new();
        env.insert("A-B".to_owned(), "value".to_owned());
        let error = validate_profile(&profile(AgentProfileKind::Codex, Vec::new(), env))
            .expect_err("invalid environment key");
        assert_eq!(error.code(), AgentRuntimeErrorCode::InvalidProfile);

        let error = validate_profile(&profile(
            AgentProfileKind::Codex,
            vec!["x".repeat(MAX_PROFILE_ARG_BYTES + 1)],
            BTreeMap::new(),
        ))
        .expect_err("oversized argument");
        assert_eq!(error.code(), AgentRuntimeErrorCode::InvalidProfile);
    }

    #[test]
    fn profile_arguments_reject_every_control_character() {
        for control in ['\n', '\r', '\t', '\u{1b}', '\u{7f}'] {
            let error = validate_profile(&profile(
                AgentProfileKind::Codex,
                vec![format!("prefix{control}suffix")],
                BTreeMap::new(),
            ))
            .expect_err("control character must be rejected before workspace creation");
            assert_eq!(error.code(), AgentRuntimeErrorCode::InvalidProfile);
        }
    }

    #[test]
    fn provider_name_is_deterministic_unique_and_herdr_safe() {
        let first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".parse::<AgentId>().unwrap();
        let second = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab".parse::<AgentId>().unwrap();
        let first_name = provider_agent_name(&first);
        let second_name = provider_agent_name(&second);
        assert_eq!(first_name, provider_agent_name(&first));
        assert_ne!(first_name, second_name);
        assert!(first_name.len() <= 32);
        assert!(first_name.chars().next().is_some_and(|value| value.is_ascii_lowercase()));
        assert!(first_name.chars().all(|value| value.is_ascii_lowercase()
            || value.is_ascii_digit()
            || value == '_'
            || value == '-'));
    }

    #[test]
    fn opaque_mapping_and_cleanup_journal_round_trip_without_core_interpretation() {
        let agent_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".parse::<AgentId>().unwrap();
        let workspace_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".parse::<WorkspaceId>().unwrap();
        let mapping = ProviderMapping {
            workspace_id: "workspace-private".to_owned(),
            tab_id: "tab-private".to_owned(),
            pane_id: "pane-private".to_owned(),
            terminal_id: "terminal-private".to_owned(),
            workspace_root: PathBuf::from("/tmp/devhub-agent"),
            workspace_domain_id: Some(workspace_id),
            generation: 4,
        };
        let opaque = encode_provider_mapping(&mapping).expect("opaque mapping");
        assert!(format!("{opaque:?}").contains("redacted"));
        assert_eq!(decode_provider_mapping(&opaque).expect("decoded"), mapping);
        let temp_dir = fs::canonicalize(std::env::temp_dir()).expect("temp directory");
        let path = temp_dir.join(format!(
            "devhub-agent-journal-{}-{}.json",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let mut tombstones = BTreeMap::new();
        tombstones.insert(
            agent_id.clone(),
            CleanupTombstone {
                mapping,
                reason: TombstoneReason::ExplicitStop,
                attempts: 2,
                next_retry: Instant::now(),
            },
        );
        save_cleanup_journal(&path, &tombstones).expect("save journal");
        let restored = load_cleanup_journal(&path).expect("load journal");
        assert_eq!(restored.get(&agent_id).expect("tombstone").attempts, 2);
        remove_journal_artifacts(&path);
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_journal_rejects_symlink_targets() {
        use std::os::unix::fs::symlink;

        let target = journal_test_path("symlink-target");
        let path = journal_test_path("symlink");
        fs::write(&target, b"not a journal").expect("target");
        symlink(&target, &path).expect("symlink");
        let tombstones = BTreeMap::new();
        assert_eq!(
            save_cleanup_journal(&path, &tombstones)
                .expect_err("symlink must not be followed")
                .code(),
            AgentRuntimeErrorCode::Unavailable
        );
        assert_eq!(
            load_cleanup_journal(&path).expect_err("symlink must not be read").code(),
            AgentRuntimeErrorCode::Unavailable
        );
        remove_journal_artifacts(&path);
        let _ = fs::remove_file(target);
    }

    #[test]
    fn cleanup_journal_is_private_and_uses_unique_temporary_files() {
        let path = journal_test_path("permissions");
        let stale_fixed_temp = path.with_extension("tmp");
        fs::write(&stale_fixed_temp, b"interrupted old writer").expect("stale temp");
        save_cleanup_journal(&path, &BTreeMap::new()).expect("journal save");
        assert!(stale_fixed_temp.exists(), "fixed temporary names are never reused");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).expect("journal metadata").permissions().mode() & 0o777,
                0o600
            );
        }
        remove_journal_artifacts(&path);
        let _ = fs::remove_file(stale_fixed_temp);
    }

    #[test]
    fn corrupt_primary_is_quarantined_and_previous_commit_is_restored() {
        let path = journal_test_path("recovery");
        let agent_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".parse::<AgentId>().unwrap();
        let mapping = ProviderMapping {
            workspace_id: "workspace-private".to_owned(),
            tab_id: "tab-private".to_owned(),
            pane_id: "pane-private".to_owned(),
            terminal_id: "terminal-private".to_owned(),
            workspace_root: PathBuf::from("/tmp/devhub-agent"),
            workspace_domain_id: None,
            generation: 1,
        };
        let mut old = BTreeMap::new();
        old.insert(
            agent_id.clone(),
            CleanupTombstone {
                mapping: mapping.clone(),
                reason: TombstoneReason::NaturalExit,
                attempts: 1,
                next_retry: Instant::now(),
            },
        );
        save_cleanup_journal(&path, &old).expect("first journal save");
        let mut current = old.clone();
        current.get_mut(&agent_id).expect("old tombstone").attempts = 2;
        save_cleanup_journal(&path, &current).expect("second journal save");
        fs::write(&path, b"{not-json").expect("corrupt primary");

        let restored = load_cleanup_journal(&path).expect("backup recovery");
        assert_eq!(restored.get(&agent_id).expect("restored tombstone").attempts, 1);
        assert!(path
            .with_file_name(format!("{}.corrupt.0", path.file_name().unwrap().to_string_lossy()))
            .exists());
        remove_journal_artifacts(&path);
    }

    fn journal_test_path(label: &str) -> PathBuf {
        let temp_dir = fs::canonicalize(std::env::temp_dir()).expect("temp directory");
        temp_dir.join(format!(
            "devhub-agent-journal-{label}-{}-{}",
            std::process::id(),
            RUNTIME_JOURNAL_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn remove_journal_artifacts(path: &Path) {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(sibling_with_suffix(path, RUNTIME_JOURNAL_BACKUP_SUFFIX));
        let _ = fs::remove_file(path.with_extension("tmp"));
        for suffix in 0..4_u32 {
            let _ = fs::remove_file(path.with_file_name(format!(
                "{}.corrupt.{suffix}",
                path.file_name().unwrap().to_string_lossy()
            )));
        }
    }

    #[test]
    fn provider_status_projects_to_product_status_without_leaking_wire_values() {
        assert_eq!(
            ProviderStatus::Working.project(),
            (AgentStatus::Working, RuntimeHealth::Healthy)
        );
        assert_eq!(
            ProviderStatus::Blocked.project(),
            (AgentStatus::Waiting, RuntimeHealth::Healthy)
        );
        assert_eq!(
            ProviderStatus::Unknown.project(),
            (AgentStatus::Error, RuntimeHealth::Degraded)
        );
        assert!(ProviderStatus::Done.is_exited());
    }

    #[test]
    fn snapshot_mapping_uses_hidden_workspace_marker() {
        let agent_id = AgentId::from_uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").expect("id");
        let snapshot = ProviderSnapshot {
            workspaces: vec![ProviderWorkspace {
                id: "workspace-provider".to_owned(),
                label: Some(marker_label(&agent_id)),
            }],
            panes: vec![ProviderPane {
                id: "pane-provider".to_owned(),
                terminal_id: "terminal-provider".to_owned(),
                workspace_id: "workspace-provider".to_owned(),
                tab_id: "tab-provider".to_owned(),
                agent: Some("codex".to_owned()),
                status: ProviderStatus::Idle,
            }],
        };
        let mapping = recover_mapping(&snapshot, &agent_id, PathBuf::from("/tmp/root"), None, 1)
            .expect("mapping");
        assert_eq!(mapping.pane_id, "pane-provider");
        assert!(!format!("{mapping:?}").contains("pane-provider"));
    }
}
