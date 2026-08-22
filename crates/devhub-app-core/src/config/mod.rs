//! The user-authored DevHub configuration store.
//!
//! This module is deliberately independent from providers.  It parses and
//! validates one TOML document, keeps a transactional last-known-good value,
//! and persists edits without following a configuration symlink during the
//! rename.  Runtime resolution in this module is also pure: finding an
//! executable, importing a login environment, and probing tmux belong to
//! adapters.

#![allow(clippy::module_name_repetitions)]

use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use toml_edit::{DocumentMut, Item, Table, TableLike};

/// The only schema accepted by the MVP.
pub const CONFIG_SCHEMA_VERSION: u16 = 1;

/// The canonical path relative to a user's home directory.
pub const CONFIG_RELATIVE_PATH: &str = ".config/devhub/config.toml";

/// The default path for a user supplied home directory.
pub fn default_config_path(home: impl AsRef<Path>) -> PathBuf {
    home.as_ref().join(CONFIG_RELATIVE_PATH)
}

/// The default filesystem exclusions for a personal source.
pub const DEFAULT_EXCLUDE_NAMES: &[&str] =
    &[".git", "node_modules", "target", "dist", "build", ".cache"];

const DEFAULT_SHELL: &str = "/bin/zsh";
const DEFAULT_GIT: &str = "git";
const DEFAULT_TMUX: &str = "tmux";
const DEFAULT_HERDR: &str = "herdr";
const DEFAULT_TMUX_SOCKET: &str = "devhub";
const DEFAULT_FONT_FAMILY: &str = "SF Mono";

/// A source kind understood by the Workspace Picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceKind {
    Directory,
    GitRepository,
    GitWorktree,
}

/// A source that walks a filesystem root.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesystemSource {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub min_depth: u8,
    #[serde(default)]
    pub max_depth: Option<u8>,
    #[serde(default = "default_workspace_kinds")]
    pub kinds: Vec<WorkspaceKind>,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default = "default_exclude_names")]
    pub exclude_names: Vec<String>,
}

impl fmt::Debug for FilesystemSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FilesystemSource")
            .field("id", &self.id)
            .field("path", &"<redacted>")
            .field("min_depth", &self.min_depth)
            .field("max_depth", &self.max_depth)
            .field("kinds", &self.kinds)
            .field("include_hidden", &self.include_hidden)
            .field("exclude_name_count", &self.exclude_names.len())
            .finish()
    }
}

/// A shell-free argument-array source for the Workspace Picker.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandSource {
    pub id: String,
    pub command: Vec<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u32,
}

impl fmt::Debug for CommandSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandSource")
            .field("id", &self.id)
            .field("command_count", &self.command.len())
            .field("timeout_ms", &self.timeout_ms)
            .finish()
    }
}

/// A typed source entry in `workspace_sources`.
///
/// The `type` discriminator is represented by the enum tag in TOML.  The
/// strict key walk in [`Config::parse`] rejects fields that the selected
/// variant does not define before serde gets a chance to ignore them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WorkspaceSource {
    #[serde(rename = "filesystem")]
    Filesystem(FilesystemSource),
    #[serde(rename = "command")]
    Command(CommandSource),
}

impl WorkspaceSource {
    /// Returns the configured source ID.
    pub fn id(&self) -> &str {
        match self {
            Self::Filesystem(source) => &source.id,
            Self::Command(source) => &source.id,
        }
    }

    /// Returns the source kind without exposing provider types.
    pub const fn kind(&self) -> SourceType {
        match self {
            Self::Filesystem(_) => SourceType::Filesystem,
            Self::Command(_) => SourceType::Command,
        }
    }
}

/// The discriminator used by Settings and discovery adapters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceType {
    Filesystem,
    Command,
}

/// The supported Agent provider profile kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentProfileKind {
    Codex,
    Claude,
}

/// A personal Agent profile from TOML.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentProfile {
    pub id: String,
    pub display_name: String,
    pub kind: AgentProfileKind,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

impl fmt::Debug for AgentProfile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Environment values are intentionally never included in debug
        // output.  An adapter may log this value while reporting a runtime
        // health change, and env values can contain credentials.
        formatter
            .debug_struct("AgentProfile")
            .field("id", &self.id)
            .field("display_name", &"<redacted>")
            .field("kind", &self.kind)
            .field("args_count", &self.args.len())
            .field("env_count", &self.env.len())
            .finish()
    }
}

/// General application settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GeneralConfig {
    #[serde(default = "default_true")]
    pub import_login_environment: bool,
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self { import_login_environment: true }
    }
}

/// Configured executable names and tmux launch arguments.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeConfig {
    #[serde(default = "default_shell")]
    pub shell: String,
    #[serde(default = "default_git")]
    pub git: String,
    #[serde(default = "default_tmux")]
    pub tmux: String,
    #[serde(default = "default_herdr")]
    pub herdr: String,
    #[serde(default = "default_tmux_socket")]
    pub tmux_socket_name: String,
    #[serde(default)]
    pub tmux_args: Vec<String>,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            shell: default_shell(),
            git: default_git(),
            tmux: default_tmux(),
            herdr: default_herdr(),
            tmux_socket_name: default_tmux_socket(),
            tmux_args: Vec::new(),
        }
    }
}

impl fmt::Debug for RuntimeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeConfig")
            .field("shell", &"<redacted>")
            .field("git", &"<redacted>")
            .field("tmux", &"<redacted>")
            .field("herdr", &"<redacted>")
            .field("tmux_socket_name", &"<redacted>")
            .field("tmux_args_count", &self.tmux_args.len())
            .finish()
    }
}

/// Native presentation settings.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppearanceConfig {
    #[serde(default = "default_color_scheme")]
    pub color_scheme: String,
    #[serde(default = "default_font_family")]
    pub terminal_font_family: String,
    #[serde(default = "default_font_size")]
    pub terminal_font_size: u8,
    #[serde(default = "default_line_height")]
    pub terminal_line_height: f64,
    #[serde(default = "default_sidebar_density")]
    pub sidebar_density: String,
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            color_scheme: default_color_scheme(),
            terminal_font_family: default_font_family(),
            terminal_font_size: default_font_size(),
            terminal_line_height: default_line_height(),
            sidebar_density: default_sidebar_density(),
        }
    }
}

impl fmt::Debug for AppearanceConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AppearanceConfig")
            .field("color_scheme", &self.color_scheme)
            .field("terminal_font_family", &"<redacted>")
            .field("terminal_font_size", &self.terminal_font_size)
            .field("terminal_line_height", &self.terminal_line_height)
            .field("sidebar_density", &self.sidebar_density)
            .finish()
    }
}

/// The complete schema-versioned user configuration.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u16,
    #[serde(default)]
    pub general: GeneralConfig,
    #[serde(default)]
    pub runtimes: RuntimeConfig,
    #[serde(default)]
    pub appearance: AppearanceConfig,
    #[serde(default = "default_workspace_sources")]
    pub workspace_sources: Vec<WorkspaceSource>,
    #[serde(default = "default_agent_profiles")]
    pub agent_profiles: Vec<AgentProfile>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_SCHEMA_VERSION,
            general: GeneralConfig::default(),
            runtimes: RuntimeConfig::default(),
            appearance: AppearanceConfig::default(),
            workspace_sources: default_workspace_sources(),
            agent_profiles: default_agent_profiles(),
        }
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Config")
            .field("version", &self.version)
            .field("general", &self.general)
            .field("runtimes", &self.runtimes)
            .field("appearance", &self.appearance)
            .field("workspace_sources", &self.workspace_sources)
            .field("agent_profiles", &self.agent_profiles)
            .finish()
    }
}

impl Config {
    /// Parses and validates one complete TOML document.
    pub fn parse(input: &str) -> Result<Self, ConfigError> {
        let document = parse_document(input)?;
        validate_known_keys(&document, input)?;
        let config = toml_edit::de::from_document::<Self>(document.clone())
            .map_err(|error| de_error(input, error.span()))?;
        config.validate_with_document(&document, input)?;
        Ok(config)
    }

    /// Validates a value assembled by native Settings code.
    pub fn validate(&self) -> Result<(), ConfigError> {
        self.validate_with_document(&DocumentMut::new(), "")
    }

    /// Converts the normalized model to canonical TOML.
    pub fn to_toml(&self) -> Result<String, ConfigError> {
        self.validate()?;
        let document =
            toml_edit::ser::to_document(self).map_err(|_| ConfigError::serialization())?;
        let mut output = document.to_string();
        if !output.ends_with('\n') {
            output.push('\n');
        }
        Ok(output)
    }

    /// Returns a configured/resolved/effective projection from trusted
    /// runtime state supplied by the adapter layer. This method performs no
    /// executable, PATH, shell-environment, or provider I/O.
    pub fn runtime_view(
        &self,
        resolved: ResolvedRuntimeConfig,
        effective: RuntimeConfig,
    ) -> RuntimeView {
        RuntimeView::new(self.runtimes.clone(), resolved, effective)
    }

    fn validate_with_document(
        &self,
        document: &DocumentMut,
        input: &str,
    ) -> Result<(), ConfigError> {
        if self.version != CONFIG_SCHEMA_VERSION {
            return Err(ConfigError::unsupported_version(
                self.version as u64,
                location_for_key(document, input, "version"),
            ));
        }

        validate_runtime(&self.runtimes, document, input)?;
        validate_appearance(&self.appearance, document, input)?;

        let mut source_ids = BTreeMap::<&str, usize>::new();
        for (index, source) in self.workspace_sources.iter().enumerate() {
            if let Some(previous) = source_ids.insert(source.id(), index) {
                return Err(ConfigError::validation(
                    ValidationCode::DuplicateIdentity,
                    format!("workspace_sources[{index}].id (also {previous})"),
                    source_location(document, input, index, "id"),
                ));
            }
            validate_id(
                source.id(),
                format!("workspace_sources[{index}].id"),
                source_location(document, input, index, "id"),
            )?;
            match source {
                WorkspaceSource::Filesystem(source) => {
                    validate_filesystem_source(source, index, document, input)?;
                }
                WorkspaceSource::Command(source) => {
                    validate_command_source(source, index, document, input)?;
                }
            }
        }

        let mut profile_ids = BTreeMap::<&str, usize>::new();
        for (index, profile) in self.agent_profiles.iter().enumerate() {
            if let Some(previous) = profile_ids.insert(profile.id.as_str(), index) {
                return Err(ConfigError::validation(
                    ValidationCode::DuplicateIdentity,
                    format!("agent_profiles[{index}].id (also {previous})"),
                    profile_location(document, input, index, "id"),
                ));
            }
            validate_id(
                &profile.id,
                format!("agent_profiles[{index}].id"),
                profile_location(document, input, index, "id"),
            )?;
            validate_profile(profile, index, document, input)?;
        }
        Ok(())
    }
}

/// A stable, content-only revision used for edit conflict detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ContentRevision([u8; 32]);

impl ContentRevision {
    fn from_bytes(bytes: &[u8]) -> Self {
        // A deterministic non-cryptographic fingerprint is sufficient for
        // same-process optimistic concurrency.  Four independent FNV lanes
        // make accidental collisions vanishingly unlikely without adding a
        // hashing dependency to the core crate.
        let seeds = [
            0xcbf29ce484222325_u64,
            0x84222325cbf29ce4_u64,
            0x9e3779b185ebca87_u64,
            0x517cc1b727220a95_u64,
        ];
        let mut lanes = seeds;
        for (index, byte) in bytes.iter().copied().enumerate() {
            for (lane, value) in lanes.iter_mut().enumerate() {
                *value ^= u64::from(byte).wrapping_add((index as u64) << (lane + 1));
                *value = value.wrapping_mul(0x100000001b3_u64);
                *value ^= *value >> (13 + lane as u32);
            }
        }
        let mut output = [0_u8; 32];
        for (lane, value) in lanes.into_iter().enumerate() {
            output[lane * 8..(lane + 1) * 8].copy_from_slice(&value.to_le_bytes());
        }
        Self(output)
    }

    /// Returns the opaque bytes of this revision.
    pub const fn as_bytes(self) -> [u8; 32] {
        self.0
    }
}

impl fmt::Display for ContentRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

/// A configuration value paired with the revision read from disk.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedConfig {
    config: Config,
    revision: ContentRevision,
}

impl LoadedConfig {
    /// The validated configuration model.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// The revision that Settings must send back when saving.
    pub const fn revision(&self) -> ContentRevision {
        self.revision
    }
}

/// The result of checking an external edit.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq)]
pub enum ReloadOutcome {
    /// The observed file is byte-for-byte unchanged.
    Unchanged { revision: ContentRevision },
    /// A valid external edit replaced the active value.
    Applied(LoadedConfig),
}

/// A redacted diagnostic delivered to a watcher or Settings surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigDiagnostic {
    code: ValidationCode,
    location: Option<SourceLocation>,
    path: Option<String>,
}

impl ConfigDiagnostic {
    /// Stable diagnostic category.
    pub const fn code(&self) -> ValidationCode {
        self.code
    }

    /// Optional source location, with no source line content.
    pub const fn location(&self) -> Option<SourceLocation> {
        self.location
    }

    /// Optional schema key path, never a value.
    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }
}

/// A 1-based TOML source location without a content excerpt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceLocation {
    pub line: usize,
    pub column: usize,
}

/// Stable validation/error categories.  Values and command output are never
/// stored in an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationCode {
    Io,
    StateUnavailable,
    InvalidUtf8,
    Parse,
    MissingRequiredField,
    UnknownKey,
    InvalidType,
    UnsupportedVersion,
    InvalidString,
    InvalidId,
    DuplicateIdentity,
    InvalidRuntime,
    InvalidSocketName,
    ForbiddenTmuxArgument,
    InvalidAppearance,
    InvalidWorkspacePath,
    InvalidWorkspaceDepth,
    InvalidWorkspaceKind,
    InvalidExclusion,
    InvalidCommand,
    InvalidTimeout,
    InvalidProfile,
    InvalidProfileKind,
    InvalidEnvironmentKey,
    Conflict,
    Serialization,
}

/// File operation names used in content-free I/O errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoOperation {
    Read,
    CreateParent,
    CreateTemp,
    WriteTemp,
    SyncTemp,
    Rename,
    SyncDirectory,
    ResolveSymlink,
    Metadata,
}

/// Errors returned by parsing, validation, reload, and atomic persistence.
///
/// The underlying OS error text and TOML source text are intentionally not
/// retained.  This makes `Display`, `Debug`, and diagnostics safe to copy to
/// logs without leaking paths, secrets, or command arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    Io { operation: IoOperation, kind: io::ErrorKind },
    InvalidUtf8 { offset: usize },
    Parse { location: Option<SourceLocation> },
    Validation { code: ValidationCode, path: Option<String>, location: Option<SourceLocation> },
    UnsupportedVersion { found: u64, location: Option<SourceLocation> },
    Conflict { expected: ContentRevision, actual: Option<ContentRevision> },
    StateUnavailable,
}

impl ConfigError {
    fn io(operation: IoOperation, error: io::Error) -> Self {
        Self::Io { operation, kind: error.kind() }
    }

    fn serialization() -> Self {
        Self::Validation { code: ValidationCode::Serialization, path: None, location: None }
    }

    fn validation(
        code: ValidationCode,
        path: impl Into<String>,
        location: Option<SourceLocation>,
    ) -> Self {
        Self::Validation { code, path: Some(path.into()), location }
    }

    fn unsupported_version(found: u64, location: Option<SourceLocation>) -> Self {
        Self::UnsupportedVersion { found, location }
    }

    /// The stable category suitable for UI and logs.
    pub const fn code(&self) -> ValidationCode {
        match self {
            Self::Io { .. } => ValidationCode::Io,
            Self::InvalidUtf8 { .. } => ValidationCode::InvalidUtf8,
            Self::Parse { .. } => ValidationCode::Parse,
            Self::Validation { code, .. } => *code,
            Self::UnsupportedVersion { .. } => ValidationCode::UnsupportedVersion,
            Self::Conflict { .. } => ValidationCode::Conflict,
            Self::StateUnavailable => ValidationCode::StateUnavailable,
        }
    }

    /// Returns a redacted diagnostic with no source content.
    pub fn diagnostic(&self) -> ConfigDiagnostic {
        let (location, path) = match self {
            Self::Validation { path, location, .. } => (*location, path.clone()),
            Self::UnsupportedVersion { location, .. } => (*location, Some("version".to_owned())),
            Self::Parse { location } => (*location, None),
            _ => (None, None),
        };
        ConfigDiagnostic { code: self.code(), location, path }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { operation, kind } => write!(formatter, "CONFIG_IO_{operation:?}_{kind:?}"),
            Self::InvalidUtf8 { .. } => formatter.write_str("CONFIG_INVALID_UTF8"),
            Self::Parse { .. } => formatter.write_str("CONFIG_TOML_PARSE_ERROR"),
            Self::Validation { code, path, .. } => {
                write!(formatter, "CONFIG_{code:?}")?;
                if let Some(path) = path {
                    write!(formatter, " at {path}")?;
                }
                Ok(())
            }
            Self::UnsupportedVersion { .. } => formatter.write_str("CONFIG_UNSUPPORTED_VERSION"),
            Self::Conflict { .. } => formatter.write_str("CONFIG_EXTERNAL_EDIT_CONFLICT"),
            Self::StateUnavailable => formatter.write_str("CONFIG_STATE_UNAVAILABLE"),
        }
    }
}

impl std::error::Error for ConfigError {}

struct StoreState {
    active: Option<LoadedInternal>,
    diagnostic: Option<ConfigDiagnostic>,
}

#[derive(Clone)]
struct LoadedInternal {
    loaded: LoadedConfig,
    document: DocumentMut,
}

struct ConfigStoreInner {
    path: PathBuf,
    state: Mutex<StoreState>,
}

/// A transactional, symlink-friendly ConfigStore.
#[derive(Clone)]
pub struct ConfigStore {
    inner: Arc<ConfigStoreInner>,
}

impl fmt::Debug for ConfigStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("ConfigStore").field("path", &"<redacted>").finish()
    }
}

impl ConfigStore {
    /// Creates a store without reading or writing the filesystem.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            inner: Arc::new(ConfigStoreInner {
                path: path.into(),
                state: Mutex::new(StoreState { active: None, diagnostic: None }),
            }),
        }
    }

    /// The configured path.  It may itself be a symbolic link.
    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    /// Loads the canonical file, creating the complete default atomically if
    /// the path is absent.  A malformed existing file is never overwritten.
    pub fn load(&self) -> Result<LoadedConfig, ConfigError> {
        let bytes = match read_config_bytes(&self.inner.path) {
            Ok(bytes) => bytes,
            Err(error) if is_not_found(&self.inner.path, &error) => {
                let config = Config::default();
                let document = config_document(&config)?;
                let output = document.to_string();
                atomic_write(&self.inner.path, output.as_bytes(), None)?;
                output.into_bytes()
            }
            Err(error) => return Err(error),
        };
        let parsed = parse_loaded(&bytes)?;
        let mut state = self.lock_state()?;
        state.active = Some(parsed.clone());
        state.diagnostic = None;
        Ok(parsed.loaded)
    }

    /// Re-reads the file and applies a valid external edit transactionally.
    ///
    /// On invalid content the active value is left untouched and the returned
    /// error contains only a code, key path, and line/column.
    pub fn reload(&self) -> Result<ReloadOutcome, ConfigError> {
        let bytes = read_config_bytes(&self.inner.path)?;
        let revision = ContentRevision::from_bytes(&bytes);
        {
            let state = self.lock_state()?;
            if let Some(active) = &state.active {
                if active.loaded.revision == revision {
                    return Ok(ReloadOutcome::Unchanged { revision });
                }
            }
        }

        let parsed = match parse_loaded(&bytes) {
            Ok(parsed) => parsed,
            Err(error) => {
                let mut state = self.lock_state()?;
                state.diagnostic = Some(error.diagnostic());
                return Err(error);
            }
        };
        let loaded = parsed.loaded.clone();
        let mut state = self.lock_state()?;
        state.active = Some(parsed);
        state.diagnostic = None;
        Ok(ReloadOutcome::Applied(loaded))
    }

    /// Checks for an external edit without requiring a filesystem watcher.
    /// This deterministic polling seam is useful to the native event loop and
    /// to tests; [`Self::watch`] supplies a small optional polling watcher.
    pub fn poll_external(&self) -> Result<ReloadOutcome, ConfigError> {
        self.reload()
    }

    /// Returns the last-known-good value, if one has loaded successfully.
    pub fn current(&self) -> Result<Option<LoadedConfig>, ConfigError> {
        Ok(self.lock_state()?.active.as_ref().map(|active| active.loaded.clone()))
    }

    /// Returns the most recent redacted parse/validation diagnostic.
    pub fn last_diagnostic(&self) -> Result<Option<ConfigDiagnostic>, ConfigError> {
        Ok(self.lock_state()?.diagnostic.clone())
    }

    /// Saves a Settings model only if its read revision is still current.
    ///
    /// Existing table order and decorations are retained where their shape is
    /// compatible.  Unknown keys cannot reach this method because all input
    /// models are validated against the schema before the write.
    pub fn save(
        &self,
        expected_revision: ContentRevision,
        config: Config,
    ) -> Result<LoadedConfig, ConfigError> {
        config.validate()?;
        let current_bytes = read_config_bytes(&self.inner.path)?;
        let actual_revision = ContentRevision::from_bytes(&current_bytes);
        if actual_revision != expected_revision {
            return Err(ConfigError::Conflict {
                expected: expected_revision,
                actual: Some(actual_revision),
            });
        }

        let old_document = {
            let state = self.lock_state()?;
            state.active.as_ref().and_then(|active| {
                (active.loaded.revision == expected_revision).then(|| active.document.clone())
            })
        };
        let old_document = match old_document {
            Some(document) => document,
            None => parse_loaded(&current_bytes)?.document,
        };
        let new_document = config_document(&config)?;
        let merged = merge_documents(old_document, new_document);
        let mut output = merged.to_string();
        if !output.ends_with('\n') {
            output.push('\n');
        }
        // Validate the decorated/merged document before replacing the target;
        // the normalized model is authoritative, while comments and layout
        // are the only state carried forward from the old document.
        let parsed_output = parse_loaded(output.as_bytes())?;
        atomic_write(&self.inner.path, output.as_bytes(), Some(expected_revision))?;

        let loaded = parsed_output.loaded;
        let mut state = self.lock_state()?;
        state.active =
            Some(LoadedInternal { loaded: loaded.clone(), document: parsed_output.document });
        state.diagnostic = None;
        Ok(loaded)
    }

    /// Starts a polling watcher.  The callback receives only successful
    /// external applications and redacted errors.  Dropping the watcher
    /// requests a prompt stop and joins the polling thread.
    pub fn watch<F>(&self, interval: Duration, callback: F) -> ConfigWatcher
    where
        F: Fn(Result<ReloadOutcome, ConfigDiagnostic>) + Send + 'static,
    {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        let store = self.clone();
        let interval = interval.max(Duration::from_millis(10));
        let handle = thread::spawn(move || {
            while !stop_thread.load(Ordering::Acquire) {
                thread::sleep(interval);
                if stop_thread.load(Ordering::Acquire) {
                    break;
                }
                match store.reload() {
                    Ok(ReloadOutcome::Unchanged { .. }) => {}
                    Ok(outcome @ ReloadOutcome::Applied(_)) => callback(Ok(outcome)),
                    Err(error) => callback(Err(error.diagnostic())),
                }
            }
        });
        ConfigWatcher { stop, handle: Some(handle) }
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, StoreState>, ConfigError> {
        self.inner.state.lock().map_err(|_| ConfigError::StateUnavailable)
    }
}

/// Handle returned by [`ConfigStore::watch`].
pub struct ConfigWatcher {
    stop: Arc<std::sync::atomic::AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl ConfigWatcher {
    /// Requests the watcher to stop and waits for its polling thread.
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ConfigWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            if handle.thread().id() != thread::current().id() {
                let _ = handle.join();
            }
        }
    }
}

/// A configured executable after pure path classification.
#[derive(Clone, PartialEq, Eq)]
pub enum ResolvedRuntime {
    AbsolutePath(PathBuf),
    CommandName(String),
}

impl fmt::Debug for ResolvedRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AbsolutePath(_) => formatter.write_str("AbsolutePath(<redacted>)"),
            Self::CommandName(_) => formatter.write_str("CommandName(<redacted>)"),
        }
    }
}

/// Resolved runtime values supplied by a trusted runtime adapter. ConfigStore
/// never constructs these by classifying strings or probing the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRuntimeConfig {
    pub shell: ResolvedRuntime,
    pub git: ResolvedRuntime,
    pub tmux: ResolvedRuntime,
    pub herdr: ResolvedRuntime,
}

/// The configured/resolved/effective values shown by Settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeView {
    pub configured: RuntimeConfig,
    pub resolved: ResolvedRuntimeConfig,
    pub effective: RuntimeConfig,
    pub tmux_socket: TmuxSocketView,
}

/// The tmux socket values needed by the pending-change UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxSocketView {
    pub configured: String,
    pub effective: String,
    pub pending: bool,
}

impl RuntimeView {
    /// Builds the Settings projection from configured values and trusted
    /// runtime state. Resolution (PATH lookup, login-environment import, and
    /// executable validation) belongs to the runtime adapter, not ConfigStore.
    pub fn new(
        configured: RuntimeConfig,
        resolved: ResolvedRuntimeConfig,
        effective: RuntimeConfig,
    ) -> Self {
        let tmux_socket = TmuxSocketView {
            configured: configured.tmux_socket_name.clone(),
            effective: effective.tmux_socket_name.clone(),
            pending: configured.tmux_socket_name != effective.tmux_socket_name,
        };
        Self { configured, resolved, effective, tmux_socket }
    }
}

fn parse_loaded(bytes: &[u8]) -> Result<LoadedInternal, ConfigError> {
    let input = std::str::from_utf8(bytes)
        .map_err(|error| ConfigError::InvalidUtf8 { offset: error.valid_up_to() })?;
    let document = parse_document(input)?;
    validate_known_keys(&document, input)?;
    let config = toml_edit::de::from_document::<Config>(document.clone())
        .map_err(|error| de_error(input, error.span()))?;
    config.validate_with_document(&document, input)?;
    Ok(LoadedInternal {
        loaded: LoadedConfig { config, revision: ContentRevision::from_bytes(bytes) },
        document,
    })
}

fn parse_document(input: &str) -> Result<DocumentMut, ConfigError> {
    input.parse::<DocumentMut>().map_err(|error| ConfigError::Parse {
        location: error.span().and_then(|span| locate(input, span.start)),
    })
}

fn de_error(input: &str, span: Option<std::ops::Range<usize>>) -> ConfigError {
    ConfigError::Validation {
        code: ValidationCode::InvalidType,
        path: None,
        location: span.and_then(|span| locate(input, span.start)),
    }
}

fn validate_known_keys(document: &DocumentMut, input: &str) -> Result<(), ConfigError> {
    check_table_keys(
        document.as_table(),
        &["version", "general", "runtimes", "appearance", "workspace_sources", "agent_profiles"],
        "",
        input,
    )?;

    check_section_table(document, "general", &["import_login_environment"], input)?;
    check_section_table(
        document,
        "runtimes",
        &["shell", "git", "tmux", "herdr", "tmux_socket_name", "tmux_args"],
        input,
    )?;
    check_section_table(
        document,
        "appearance",
        &[
            "color_scheme",
            "terminal_font_family",
            "terminal_font_size",
            "terminal_line_height",
            "sidebar_density",
        ],
        input,
    )?;

    if let Some(item) = document.get("workspace_sources") {
        let sources = array_of_tables(item).ok_or_else(|| {
            ConfigError::validation(
                ValidationCode::InvalidType,
                "workspace_sources",
                item.span().and_then(|span| locate(input, span.start)),
            )
        })?;
        for (index, table) in sources.iter().enumerate() {
            let mut allowed = vec!["id", "type"];
            match table.get("type").and_then(Item::as_value).and_then(toml_edit::Value::as_str) {
                Some("filesystem") => allowed.extend([
                    "path",
                    "min_depth",
                    "max_depth",
                    "kinds",
                    "include_hidden",
                    "exclude_names",
                ]),
                Some("command") => allowed.extend(["command", "timeout_ms"]),
                _ => {
                    // Let serde report a missing or unknown discriminator;
                    // every field is checked once the variant is known.
                    allowed.extend([
                        "path",
                        "min_depth",
                        "max_depth",
                        "kinds",
                        "include_hidden",
                        "exclude_names",
                        "command",
                        "timeout_ms",
                    ]);
                }
            }
            check_table_keys(table, &allowed, &format!("workspace_sources[{index}]"), input)?;
        }
    }

    if let Some(item) = document.get("agent_profiles") {
        let profiles = array_of_tables(item).ok_or_else(|| {
            ConfigError::validation(
                ValidationCode::InvalidType,
                "agent_profiles",
                item.span().and_then(|span| locate(input, span.start)),
            )
        })?;
        for (index, table) in profiles.iter().enumerate() {
            check_table_keys(
                table,
                &["id", "display_name", "kind", "args", "env"],
                &format!("agent_profiles[{index}]"),
                input,
            )?;
            if let Some(env) = table.get("env") {
                if env.as_table_like().is_none() {
                    return Err(ConfigError::validation(
                        ValidationCode::InvalidType,
                        format!("agent_profiles[{index}].env"),
                        env.span().and_then(|span| locate(input, span.start)),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn check_section_table(
    document: &DocumentMut,
    section: &str,
    allowed: &[&str],
    input: &str,
) -> Result<(), ConfigError> {
    let Some(item) = document.get(section) else { return Ok(()) };
    let table = item.as_table_like().ok_or_else(|| {
        ConfigError::validation(
            ValidationCode::InvalidType,
            section,
            item.span().and_then(|span| locate(input, span.start)),
        )
    })?;
    check_table_keys(table, allowed, section, input)
}

fn check_table_keys(
    table: &dyn TableLike,
    allowed: &[&str],
    prefix: &str,
    input: &str,
) -> Result<(), ConfigError> {
    for (key, item) in table.iter() {
        if !allowed.contains(&key) {
            let path = if prefix.is_empty() { key.to_owned() } else { format!("{prefix}.{key}") };
            return Err(ConfigError::validation(
                ValidationCode::UnknownKey,
                path,
                item.span().and_then(|span| locate(input, span.start)),
            ));
        }
    }
    Ok(())
}

fn validate_runtime(
    runtime: &RuntimeConfig,
    document: &DocumentMut,
    input: &str,
) -> Result<(), ConfigError> {
    for (key, value) in [
        ("shell", runtime.shell.as_str()),
        ("git", runtime.git.as_str()),
        ("tmux", runtime.tmux.as_str()),
        ("herdr", runtime.herdr.as_str()),
    ] {
        if value.contains('\0') {
            return Err(ConfigError::validation(
                ValidationCode::InvalidString,
                format!("runtimes.{key}"),
                location_for_key(document, input, &format!("runtimes.{key}")),
            ));
        }
        let valid = value.starts_with('/')
            || value == "~"
            || value.starts_with("~/")
            || (!value.is_empty() && !value.contains('/'));
        if !valid {
            return Err(ConfigError::validation(
                ValidationCode::InvalidRuntime,
                format!("runtimes.{key}"),
                location_for_key(document, input, &format!("runtimes.{key}")),
            ));
        }
    }
    if !is_socket_name(&runtime.tmux_socket_name) {
        return Err(ConfigError::validation(
            ValidationCode::InvalidSocketName,
            "runtimes.tmux_socket_name",
            location_for_key(document, input, "runtimes.tmux_socket_name"),
        ));
    }
    for (index, argument) in runtime.tmux_args.iter().enumerate() {
        if argument.contains('\0') {
            return Err(ConfigError::validation(
                ValidationCode::InvalidString,
                format!("runtimes.tmux_args[{index}]"),
                location_for_key(document, input, "runtimes.tmux_args"),
            ));
        }
        if is_socket_selector(argument) {
            return Err(ConfigError::validation(
                ValidationCode::ForbiddenTmuxArgument,
                format!("runtimes.tmux_args[{index}]"),
                location_for_key(document, input, "runtimes.tmux_args"),
            ));
        }
    }
    Ok(())
}

fn validate_appearance(
    appearance: &AppearanceConfig,
    document: &DocumentMut,
    input: &str,
) -> Result<(), ConfigError> {
    if appearance.color_scheme != "light"
        || appearance.terminal_font_family.trim().is_empty()
        || appearance.terminal_font_family.contains('\0')
        || !(9..=24).contains(&appearance.terminal_font_size)
        || !appearance.terminal_line_height.is_finite()
        || !(1.0..=2.0).contains(&appearance.terminal_line_height)
        || !matches!(appearance.sidebar_density.as_str(), "compact" | "comfortable")
    {
        return Err(ConfigError::validation(
            ValidationCode::InvalidAppearance,
            "appearance",
            location_for_key(document, input, "appearance"),
        ));
    }
    Ok(())
}

fn validate_filesystem_source(
    source: &FilesystemSource,
    index: usize,
    document: &DocumentMut,
    input: &str,
) -> Result<(), ConfigError> {
    let prefix = format!("workspace_sources[{index}]");
    validate_path(
        &source.path,
        format!("{prefix}.path"),
        source_location(document, input, index, "path"),
    )?;
    let max_depth = source.max_depth.unwrap_or(source.min_depth);
    if max_depth < source.min_depth || max_depth > 16 {
        return Err(ConfigError::validation(
            ValidationCode::InvalidWorkspaceDepth,
            format!("{prefix}.max_depth"),
            source_location(document, input, index, "max_depth"),
        ));
    }
    if source.kinds.is_empty() {
        return Err(ConfigError::validation(
            ValidationCode::InvalidWorkspaceKind,
            format!("{prefix}.kinds"),
            source_location(document, input, index, "kinds"),
        ));
    }
    let mut kinds = source.kinds.iter();
    let has_directory = kinds.any(|kind| *kind == WorkspaceKind::Directory);
    let has_git = source
        .kinds
        .iter()
        .any(|kind| matches!(kind, WorkspaceKind::GitRepository | WorkspaceKind::GitWorktree));
    if has_directory && has_git {
        return Err(ConfigError::validation(
            ValidationCode::InvalidWorkspaceKind,
            format!("{prefix}.kinds"),
            source_location(document, input, index, "kinds"),
        ));
    }
    for (exclude_index, name) in source.exclude_names.iter().enumerate() {
        if name.is_empty()
            || name.contains('\0')
            || name.contains('/')
            || name.contains('\\')
            || name.chars().any(|character| "*?[]{}".contains(character))
        {
            return Err(ConfigError::validation(
                ValidationCode::InvalidExclusion,
                format!("{prefix}.exclude_names[{exclude_index}]"),
                source_location(document, input, index, "exclude_names"),
            ));
        }
    }
    Ok(())
}

fn validate_command_source(
    source: &CommandSource,
    index: usize,
    document: &DocumentMut,
    input: &str,
) -> Result<(), ConfigError> {
    let prefix = format!("workspace_sources[{index}]");
    if source.command.is_empty() || source.command.iter().any(|argument| argument.contains('\0')) {
        return Err(ConfigError::validation(
            ValidationCode::InvalidCommand,
            format!("{prefix}.command"),
            source_location(document, input, index, "command"),
        ));
    }
    if !(100..=30_000).contains(&source.timeout_ms) {
        return Err(ConfigError::validation(
            ValidationCode::InvalidTimeout,
            format!("{prefix}.timeout_ms"),
            source_location(document, input, index, "timeout_ms"),
        ));
    }
    Ok(())
}

fn validate_profile(
    profile: &AgentProfile,
    index: usize,
    document: &DocumentMut,
    input: &str,
) -> Result<(), ConfigError> {
    let prefix = format!("agent_profiles[{index}]");
    if profile.display_name.trim().is_empty() || profile.display_name.contains('\0') {
        return Err(ConfigError::validation(
            ValidationCode::InvalidProfile,
            format!("{prefix}.display_name"),
            profile_location(document, input, index, "display_name"),
        ));
    }
    if profile.args.iter().any(|argument| argument.contains('\0')) {
        return Err(ConfigError::validation(
            ValidationCode::InvalidProfile,
            format!("{prefix}.args"),
            profile_location(document, input, index, "args"),
        ));
    }
    for (key, value) in &profile.env {
        if !is_environment_name(key) {
            return Err(ConfigError::validation(
                ValidationCode::InvalidEnvironmentKey,
                format!("{prefix}.env"),
                profile_location(document, input, index, "env"),
            ));
        }
        if value.contains('\0') {
            return Err(ConfigError::validation(
                ValidationCode::InvalidString,
                format!("{prefix}.env"),
                profile_location(document, input, index, "env"),
            ));
        }
    }
    Ok(())
}

fn validate_id(
    id: &str,
    path: String,
    location: Option<SourceLocation>,
) -> Result<(), ConfigError> {
    let bytes = id.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        });
    if valid {
        Ok(())
    } else {
        Err(ConfigError::validation(ValidationCode::InvalidId, path, location))
    }
}

fn validate_path(
    path: &str,
    key: String,
    location: Option<SourceLocation>,
) -> Result<(), ConfigError> {
    if path.is_empty()
        || path.contains('\0')
        || path == "~user"
        || (!path.starts_with('/') && path != "~" && !path.starts_with("~/"))
    {
        return Err(ConfigError::validation(ValidationCode::InvalidWorkspacePath, key, location));
    }
    Ok(())
}

fn is_environment_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes[1..].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

fn is_socket_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn is_socket_selector(argument: &str) -> bool {
    argument == "-L"
        || argument == "-S"
        || argument.starts_with("-L")
        || argument.starts_with("-S")
        || argument == "--socket"
        || argument == "--socket-name"
        || argument.starts_with("--socket=")
        || argument.starts_with("--socket-name=")
}

fn source_location(
    document: &DocumentMut,
    input: &str,
    index: usize,
    key: &str,
) -> Option<SourceLocation> {
    array_table_location(document.get("workspace_sources")?, index, key, input)
}

fn profile_location(
    document: &DocumentMut,
    input: &str,
    index: usize,
    key: &str,
) -> Option<SourceLocation> {
    array_table_location(document.get("agent_profiles")?, index, key, input)
}

fn array_table_location(
    item: &Item,
    index: usize,
    key: &str,
    input: &str,
) -> Option<SourceLocation> {
    if let Some(sources) = item.as_array_of_tables() {
        let source = sources.get(index)?;
        return source
            .get(key)
            .and_then(Item::span)
            .or_else(|| source.span())
            .and_then(|span| locate(input, span.start));
    }
    let sources = item.clone().into_array_of_tables().ok()?;
    let source = sources.get(index)?;
    source
        .get(key)
        .and_then(Item::span)
        .or_else(|| source.span())
        .and_then(|span| locate(input, span.start))
}

fn location_for_key(document: &DocumentMut, input: &str, key: &str) -> Option<SourceLocation> {
    let mut parts = key.split('.');
    let first = parts.next()?;
    let mut item = document.get(first)?;
    for part in parts {
        item = item.get(part)?;
    }
    item.span().and_then(|span| locate(input, span.start))
}

fn array_of_tables(item: &Item) -> Option<toml_edit::ArrayOfTables> {
    if let Some(tables) = item.as_array_of_tables() {
        return Some(tables.clone());
    }
    // TOML has no distinct syntax for an empty array-of-tables.  The parser
    // represents `workspace_sources = []` and `agent_profiles = []` as an
    // ordinary empty value array, so accept that unambiguous empty form while
    // continuing to reject non-table arrays below.
    if item.as_value().and_then(|value| value.as_array()).is_some_and(|array| array.is_empty()) {
        return Some(toml_edit::ArrayOfTables::new());
    }
    item.clone().into_array_of_tables().ok()
}

fn locate(input: &str, offset: usize) -> Option<SourceLocation> {
    if input.is_empty() {
        return None;
    }
    let offset = offset.min(input.len());
    let prefix = &input[..offset];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let line_start = prefix.rfind('\n').map_or(0, |index| index + 1);
    let column = input[line_start..offset].chars().count() + 1;
    Some(SourceLocation { line, column })
}

fn read_config_bytes(path: &Path) -> Result<Vec<u8>, ConfigError> {
    fs::read(path).map_err(|error| ConfigError::io(IoOperation::Read, error))
}

fn is_not_found(path: &Path, error: &ConfigError) -> bool {
    matches!(error, ConfigError::Io { kind: io::ErrorKind::NotFound, .. })
        && fs::symlink_metadata(path).is_err()
}

fn config_document(config: &Config) -> Result<DocumentMut, ConfigError> {
    toml_edit::ser::to_document(config).map_err(|_| ConfigError::serialization())
}

fn merge_documents(mut old: DocumentMut, new: DocumentMut) -> DocumentMut {
    merge_tables(old.as_table_mut(), new.as_table());
    old
}

fn merge_tables(old: &mut Table, new: &Table) {
    merge_table_like(old, new);
}

fn merge_table_like(old: &mut dyn TableLike, new: &dyn TableLike) {
    // The serialized Settings model is authoritative for membership. Remove
    // keys that are no longer present before merging matching values so
    // deleted env entries, optional fields, and variant-specific fields do
    // not survive a save as hidden configuration.
    let old_keys = old.iter().map(|(key, _)| key.to_owned()).collect::<Vec<_>>();
    for key in old_keys {
        if new.get(&key).is_none() {
            old.remove(&key);
        }
    }
    for (key, new_item) in new.iter() {
        if let Some(old_item) = old.get_mut(key) {
            merge_item(old_item, new_item);
        } else {
            old.insert(key, new_item.clone());
        }
    }
}

fn merge_item(old: &mut Item, new: &Item) {
    if let Some(merged) = merge_array_of_tables(old, new) {
        *old = merged;
        return;
    }

    if let Some(old_table) = old.as_table_mut() {
        if let Some(new_table) = new.as_table_like() {
            let decor = old_table.decor().clone();
            merge_table_like(old_table, new_table);
            *old_table.decor_mut() = decor;
            return;
        }
    }

    let value_decor = old.as_value().map(|value| value.decor().clone());
    let table_decor = old.as_table().map(|table| table.decor().clone());
    *old = new.clone();
    if let Some(decor) = value_decor {
        if let Some(value) = old.as_value_mut() {
            *value.decor_mut() = decor;
        }
    }
    if let Some(decor) = table_decor {
        if let Some(table) = old.as_table_mut() {
            *table.decor_mut() = decor;
        }
    }
}

/// Merges the two identity-bearing arrays used by the schema.  The edited
/// model's ID order is authoritative: matching entries retain their old
/// decorations/comments, new entries are inserted, removed IDs disappear,
/// and reordering follows the Settings model.  This makes add/remove/reorder
/// behavior explicit instead of silently replacing the entire array.
fn merge_array_of_tables(old: &Item, new: &Item) -> Option<Item> {
    let old_tables = array_of_tables(old)?;
    let new_tables = array_of_tables(new)?;
    let old_is_inline = old.as_value().and_then(|value| value.as_array()).is_some();
    let old_decor = old.as_value().map(|value| value.decor().clone());

    let mut by_id = BTreeMap::<String, Table>::new();
    let positions = old_tables.iter().map(Table::position).collect::<Vec<_>>();
    let first_position = positions.iter().flatten().copied().min();
    for table in old_tables.iter() {
        if let Some(id) = table_id(table) {
            by_id.insert(id, table.clone());
        }
    }

    let mut merged = toml_edit::ArrayOfTables::new();
    for new_table in new_tables.iter() {
        let old_table = table_id(new_table).and_then(|id| by_id.remove(&id));
        let mut table = old_table.clone().unwrap_or_else(|| new_table.clone());
        if old_table.is_some() {
            // The old table carries the user's header/table decoration.  Its
            // children likewise retain their key decorations via merge_item.
            let decor = table.decor().clone();
            merge_table_like(&mut table, new_table);
            *table.decor_mut() = decor;
        }
        // `DocumentMut` orders array-of-table headers by their document
        // position when rendering.  Reassign the existing slots so an
        // explicit Settings reorder is reflected while comments follow the
        // stable ID-bearing table.
        let slot = merged.len();
        if let Some(position) = positions.get(slot).and_then(|position| *position) {
            table.set_position(position);
        } else if let Some(position) = first_position {
            table.set_position(position.saturating_add(slot));
        }
        merged.push(table);
    }

    if old_is_inline {
        let mut value = toml_edit::Value::from(merged.into_array());
        if let Some(decor) = old_decor {
            *value.decor_mut() = decor;
        }
        Some(Item::Value(value))
    } else {
        Some(Item::ArrayOfTables(merged))
    }
}

fn table_id(table: &Table) -> Option<String> {
    table
        .get("id")
        .and_then(Item::as_value)
        .and_then(toml_edit::Value::as_str)
        .map(ToOwned::to_owned)
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn atomic_write(
    configured_path: &Path,
    bytes: &[u8],
    expected_revision: Option<ContentRevision>,
) -> Result<(), ConfigError> {
    let target = resolve_write_target(configured_path)?;
    if let Some(expected) = expected_revision {
        let current =
            fs::read(&target).map_err(|error| ConfigError::io(IoOperation::Read, error))?;
        let actual = ContentRevision::from_bytes(&current);
        if actual != expected {
            return Err(ConfigError::Conflict { expected, actual: Some(actual) });
        }
    }

    let parent = target.parent().ok_or_else(|| {
        ConfigError::io(
            IoOperation::CreateParent,
            io::Error::new(io::ErrorKind::InvalidInput, "config path has no parent"),
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| ConfigError::io(IoOperation::CreateParent, error))?;

    let permissions = fs::metadata(&target).ok().map(|metadata| metadata.permissions());
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = target.file_name().and_then(|name| name.to_str()).ok_or_else(|| {
        ConfigError::io(
            IoOperation::CreateTemp,
            io::Error::new(io::ErrorKind::InvalidInput, "config path is not UTF-8"),
        )
    })?;
    let temp_path =
        parent.join(format!(".{file_name}.devhub-{counter}-{}.tmp", std::process::id()));
    let mut temp = TempFile::create(&temp_path)?;
    if let Some(permissions) = permissions {
        temp.set_permissions(permissions)?;
    } else {
        set_owner_permissions(&temp.file, 0o600)?;
    }
    temp.file.write_all(bytes).map_err(|error| ConfigError::io(IoOperation::WriteTemp, error))?;
    temp.file.sync_all().map_err(|error| ConfigError::io(IoOperation::SyncTemp, error))?;
    fs::rename(&temp.path, &target).map_err(|error| ConfigError::io(IoOperation::Rename, error))?;
    temp.keep = true;
    let directory =
        File::open(parent).map_err(|error| ConfigError::io(IoOperation::SyncDirectory, error))?;
    directory.sync_all().map_err(|error| ConfigError::io(IoOperation::SyncDirectory, error))?;
    Ok(())
}

struct TempFile {
    path: PathBuf,
    file: File,
    keep: bool,
}

impl TempFile {
    fn create(path: &Path) -> Result<Self, ConfigError> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| ConfigError::io(IoOperation::CreateTemp, error))?;
        Ok(Self { path: path.to_path_buf(), file, keep: false })
    }

    fn set_permissions(&self, permissions: fs::Permissions) -> Result<(), ConfigError> {
        fs::set_permissions(&self.path, permissions)
            .map_err(|error| ConfigError::io(IoOperation::WriteTemp, error))
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn set_owner_permissions(file: &File, mode: u32) -> Result<(), ConfigError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(mode))
            .map_err(|error| ConfigError::io(IoOperation::WriteTemp, error))
    }
    #[cfg(not(unix))]
    {
        let _ = (file, mode);
        Ok(())
    }
}

fn resolve_write_target(path: &Path) -> Result<PathBuf, ConfigError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::canonicalize(path)
            .map_err(|error| ConfigError::io(IoOperation::ResolveSymlink, error)),
        Ok(_) => Ok(path.to_path_buf()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(error) => Err(ConfigError::io(IoOperation::Metadata, error)),
    }
}

fn default_true() -> bool {
    true
}

fn default_shell() -> String {
    DEFAULT_SHELL.to_owned()
}

fn default_git() -> String {
    DEFAULT_GIT.to_owned()
}

fn default_tmux() -> String {
    DEFAULT_TMUX.to_owned()
}

fn default_herdr() -> String {
    DEFAULT_HERDR.to_owned()
}

fn default_tmux_socket() -> String {
    DEFAULT_TMUX_SOCKET.to_owned()
}

fn default_color_scheme() -> String {
    "light".to_owned()
}

fn default_font_family() -> String {
    DEFAULT_FONT_FAMILY.to_owned()
}

fn default_font_size() -> u8 {
    13
}

fn default_line_height() -> f64 {
    1.2
}

fn default_sidebar_density() -> String {
    "compact".to_owned()
}

fn default_timeout_ms() -> u32 {
    2_000
}

fn default_workspace_kinds() -> Vec<WorkspaceKind> {
    vec![WorkspaceKind::Directory]
}

fn default_exclude_names() -> Vec<String> {
    DEFAULT_EXCLUDE_NAMES.iter().map(|name| (*name).to_owned()).collect()
}

fn default_workspace_sources() -> Vec<WorkspaceSource> {
    vec![
        WorkspaceSource::Command(CommandSource {
            id: "daily".to_owned(),
            command: vec!["workspace_path".to_owned(), "-d".to_owned()],
            timeout_ms: default_timeout_ms(),
        }),
        WorkspaceSource::Filesystem(FilesystemSource {
            id: "dev-git".to_owned(),
            path: "~/dev".to_owned(),
            min_depth: 1,
            max_depth: Some(4),
            kinds: vec![WorkspaceKind::GitRepository, WorkspaceKind::GitWorktree],
            include_hidden: false,
            exclude_names: default_exclude_names(),
        }),
        WorkspaceSource::Filesystem(FilesystemSource {
            id: "work".to_owned(),
            path: "~/workspace/work".to_owned(),
            min_depth: 1,
            max_depth: Some(1),
            kinds: vec![WorkspaceKind::Directory],
            include_hidden: false,
            exclude_names: default_exclude_names(),
        }),
        WorkspaceSource::Filesystem(FilesystemSource {
            id: "home-git".to_owned(),
            path: "~".to_owned(),
            min_depth: 1,
            max_depth: Some(2),
            kinds: vec![WorkspaceKind::GitRepository, WorkspaceKind::GitWorktree],
            include_hidden: false,
            exclude_names: default_exclude_names(),
        }),
    ]
}

fn default_agent_profiles() -> Vec<AgentProfile> {
    vec![
        AgentProfile {
            id: "codex".to_owned(),
            display_name: "Codex".to_owned(),
            kind: AgentProfileKind::Codex,
            args: Vec::new(),
            env: BTreeMap::new(),
        },
        AgentProfile {
            id: "claude".to_owned(),
            display_name: "Claude".to_owned(),
            kind: AgentProfileKind::Claude,
            args: Vec::new(),
            env: BTreeMap::new(),
        },
    ]
}

impl crate::ports::ConfigStore for ConfigStore {
    fn load(
        &self,
        _cancel: crate::ports::CancellationToken,
    ) -> crate::ports::PortFuture<crate::ports::ConfigSnapshot> {
        let result = ConfigStore::load(self).map(|loaded| crate::ports::ConfigSnapshot {
            config: loaded.config().clone(),
            revision: loaded.revision(),
        });
        Box::pin(async move { result.map_err(|error| map_port_error(&error)) })
    }

    fn save(
        &self,
        snapshot: crate::ports::ConfigSnapshot,
        _cancel: crate::ports::CancellationToken,
    ) -> crate::ports::PortFuture<()> {
        let result = ConfigStore::save(self, snapshot.revision, snapshot.config)
            .map(|_| ())
            .map_err(|error| map_port_error(&error));
        Box::pin(async move { result })
    }
}

fn map_port_error(error: &ConfigError) -> crate::ports::PortError {
    let code = match error {
        ConfigError::Conflict { .. } => crate::ports::PortErrorCode::Conflict,
        ConfigError::UnsupportedVersion { .. } => crate::ports::PortErrorCode::Incompatible,
        _ => crate::ports::PortErrorCode::Failed,
    };
    crate::ports::PortError::new(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicUsize;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn drive<T>(mut future: crate::ports::PortFuture<T>) -> Result<T, crate::ports::PortError> {
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(result) => result,
            std::task::Poll::Pending => panic!("config port future unexpectedly pending"),
        }
    }

    fn temp_dir() -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
        let path = std::env::temp_dir().join(format!("devhub-config-test-{nonce}"));
        fs::create_dir_all(&path).expect("temp dir");
        path
    }

    fn config_path() -> (PathBuf, PathBuf) {
        let dir = temp_dir();
        let path = dir.join("config.toml");
        (dir, path)
    }

    fn minimal_toml() -> &'static str {
        "version = 1\n"
    }

    #[test]
    fn missing_file_creates_full_default_atomically() {
        let (dir, path) = config_path();
        let store = ConfigStore::new(&path);
        let loaded = store.load().expect("default loads");
        assert_eq!(loaded.config.version, CONFIG_SCHEMA_VERSION);
        assert_eq!(loaded.config.runtimes.tmux_socket_name, DEFAULT_TMUX_SOCKET);
        assert_eq!(loaded.config.workspace_sources.len(), 4);
        assert_eq!(loaded.config.agent_profiles.len(), 2);
        let raw = fs::read_to_string(&path).expect("default exists");
        assert!(raw.contains("version = 1"));
        assert!(raw.contains("dev-git"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn explicit_empty_collections_override_defaults_through_save_and_reload() {
        let raw = "version = 1\nworkspace_sources = []\nagent_profiles = []\n";
        let parsed = Config::parse(raw).expect("explicit empty collections are valid");
        assert!(parsed.workspace_sources.is_empty());
        assert!(parsed.agent_profiles.is_empty());

        let (dir, path) = config_path();
        fs::write(&path, raw).expect("input");
        let store = ConfigStore::new(&path);
        let loaded = store.load().expect("load empty collections");
        assert!(loaded.config.workspace_sources.is_empty());
        assert!(loaded.config.agent_profiles.is_empty());

        let saved = store.save(loaded.revision(), loaded.config.clone()).expect("save");
        assert!(saved.config.workspace_sources.is_empty());
        assert!(saved.config.agent_profiles.is_empty());
        let reloaded = store.reload().expect("reload");
        assert!(matches!(reloaded, ReloadOutcome::Unchanged { .. }));
        let current = store.current().expect("current").expect("active");
        assert!(current.config.workspace_sources.is_empty());
        assert!(current.config.agent_profiles.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn valid_roundtrip_keeps_comments_and_normalizes_defaults() {
        let (dir, path) = config_path();
        let raw =
            "# keep this\nversion = 1\n\n[appearance]\n# keep this too\nterminal_font_size = 14\n";
        fs::write(&path, raw).expect("write input");
        let store = ConfigStore::new(&path);
        let loaded = store.load().expect("valid config");
        assert_eq!(loaded.config.appearance.terminal_font_size, 14);
        let mut edited = loaded.config.clone();
        edited.appearance.terminal_font_size = 15;
        let saved = store.save(loaded.revision(), edited).expect("save");
        let output = fs::read_to_string(&path).expect("read output");
        assert!(output.contains("# keep this"));
        assert!(output.contains("# keep this too"));
        assert!(output.contains("terminal_font_size = 15"));
        assert_eq!(saved.config.appearance.terminal_font_size, 15);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn identity_arrays_deep_merge_comments_and_follow_explicit_order() {
        let (dir, path) = config_path();
        let raw = r#"version = 1

[[workspace_sources]]
# first source comment
id = "first"
type = "filesystem"
path = "~/first" # path comment
exclude_names = [".git"] # exclusions comment

[[workspace_sources]]
# second source comment
id = "second"
type = "filesystem"
path = "~/second"

[[agent_profiles]]
# profile comment
id = "codex"
display_name = "Codex"
kind = "codex"
args = ["--model", "safe"]

[agent_profiles.env]
# env comment
SAFE_VALUE = "opaque-secret"
"#;
        fs::write(&path, raw).expect("write input");
        let store = ConfigStore::new(&path);
        let loaded = store.load().expect("load");
        let mut edited = loaded.config.clone();
        edited.workspace_sources.reverse();
        if let WorkspaceSource::Filesystem(source) = &mut edited.workspace_sources[1] {
            source.path = "~/changed".to_owned();
        }
        let profile = edited.agent_profiles.first_mut().expect("profile");
        profile.args = vec!["--model".to_owned(), "changed".to_owned()];
        store.save(loaded.revision(), edited).expect("save");
        let output = fs::read_to_string(&path).expect("read output");
        assert!(output.contains("# first source comment"));
        assert!(output.contains("# second source comment"));
        assert!(output.contains("# path comment"));
        assert!(output.contains("# exclusions comment"));
        assert!(output.contains("# profile comment"));
        assert!(output.contains("# env comment"));
        assert!(
            output.find("id = \"second\"").expect("second")
                < output.find("id = \"first\"").expect("first")
        );
        assert!(output.contains("path = \"~/changed\""));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn authoritative_merge_removes_deleted_values_and_switches_source_shape() {
        let (dir, path) = config_path();
        let raw = r#"version = 1

[[workspace_sources]]
id = "switch"
type = "filesystem"
path = "~/removed-secret-root"
min_depth = 1
max_depth = 4
kinds = ["directory"]

[[workspace_sources]]
id = "remove"
type = "filesystem"
path = "~/removed-source"

[[workspace_sources]]
id = "keep"
type = "filesystem"
path = "~/keep"
min_depth = 1
max_depth = 4
kinds = ["directory"]

[[agent_profiles]]
id = "codex"
display_name = "Codex"
kind = "codex"

[agent_profiles.env]
REMOVE_SECRET = "private-secret"
KEEP_ME = "keep-value"

[[agent_profiles]]
id = "claude"
display_name = "Claude"
kind = "claude"

[agent_profiles.env]
CLEAR_SECRET = "clear-secret"
"#;
        fs::write(&path, raw).expect("write input");
        let store = ConfigStore::new(&path);
        let loaded = store.load().expect("load");

        let mut switch = WorkspaceSource::Command(CommandSource {
            id: "switch".to_owned(),
            command: vec!["workspace_path".to_owned()],
            timeout_ms: 2_000,
        });
        let mut keep = match loaded.config.workspace_sources[2].clone() {
            WorkspaceSource::Filesystem(source) => source,
            WorkspaceSource::Command(_) => panic!("expected filesystem source"),
        };
        keep.max_depth = None;
        let added = WorkspaceSource::Command(CommandSource {
            id: "added".to_owned(),
            command: vec!["workspace_path".to_owned(), "-d".to_owned()],
            timeout_ms: 2_000,
        });
        if let WorkspaceSource::Command(source) = &mut switch {
            source.command.push("--safe".to_owned());
        }

        let mut edited = loaded.config.clone();
        edited.workspace_sources = vec![added, WorkspaceSource::Filesystem(keep), switch];
        edited.agent_profiles[0].env.remove("REMOVE_SECRET");
        edited.agent_profiles[1].env.clear();
        let saved = store.save(loaded.revision(), edited.clone()).expect("save");
        let output = fs::read_to_string(&path).expect("read output");
        let reparsed = Config::parse(&output).expect("saved output strict-reparses");

        assert_eq!(reparsed, edited);
        assert!(output.contains("KEEP_ME = \"keep-value\""));
        assert!(output.contains("path = \"~/keep\""));
        for removed in [
            "private-secret",
            "clear-secret",
            "REMOVE_SECRET",
            "CLEAR_SECRET",
            "~/removed-secret-root",
            "~/removed-source",
            "max_depth = 4",
            "id = \"remove\"",
        ] {
            assert!(!output.contains(removed), "removed value survived: {removed}");
        }
        assert!(
            output.find("id = \"added\"").expect("added")
                < output.find("id = \"keep\"").expect("keep")
        );
        assert!(
            output.find("id = \"keep\"").expect("keep")
                < output.find("id = \"switch\"").expect("switch")
        );
        assert_eq!(saved.config, reparsed);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_profiles_paths_globs_and_duplicates_are_rejected() {
        let invalids = [
            "version = 1\n[[agent_profiles]]\nid = \"Codex\"\ndisplay_name = \"x\"\nkind = \"codex\"\n",
            "version = 1\n[[workspace_sources]]\nid = \"x\"\ntype = \"filesystem\"\npath = \"relative/root\"\n",
            "version = 1\n[[workspace_sources]]\nid = \"x\"\ntype = \"filesystem\"\npath = \"~/dev\"\nexclude_names = [\"*.tmp\"]\n",
            "version = 1\n[[workspace_sources]]\nid = \"x\"\ntype = \"command\"\npath = \"~/dev\"\ncommand = [\"workspace_path\"]\n",
            "version = 1\n[[agent_profiles]]\nid = \"x\"\ndisplay_name = \"x\"\nkind = \"codex\"\n[agent_profiles.env]\nBAD-KEY = \"secret\"\n",
            "version = 1\n[[agent_profiles]]\nid = \"x\"\ndisplay_name = \"x\"\nkind = \"codex\"\n[[agent_profiles]]\nid = \"x\"\ndisplay_name = \"y\"\nkind = \"claude\"\n",
        ];
        for raw in invalids {
            assert!(Config::parse(raw).is_err(), "invalid input accepted: {raw}");
        }
    }

    #[test]
    fn symlink_writes_replace_target_and_keep_link() {
        let (dir, path) = config_path();
        let target = dir.join("dotfiles-config.toml");
        fs::write(&target, minimal_toml()).expect("target");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &path).expect("link");
        #[cfg(unix)]
        {
            let store = ConfigStore::new(&path);
            let loaded = store.load().expect("load link");
            let mut edited = loaded.config.clone();
            edited.general.import_login_environment = false;
            store.save(loaded.revision(), edited).expect("save link");
            assert!(fs::symlink_metadata(&path).expect("metadata").file_type().is_symlink());
            assert!(fs::read_to_string(&target)
                .expect("target output")
                .contains("import_login_environment = false"));
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn external_edit_conflict_and_last_known_good_are_transactional() {
        let (dir, path) = config_path();
        fs::write(&path, minimal_toml()).expect("input");
        let store = ConfigStore::new(&path);
        let loaded = store.load().expect("load");
        fs::write(&path, "version = 2\n").expect("external edit");
        let error = store.save(loaded.revision(), Config::default()).expect_err("conflict");
        assert!(matches!(error, ConfigError::Conflict { .. }));
        let reload = store.reload().expect_err("newer version rejected");
        assert_eq!(reload.code(), ValidationCode::UnsupportedVersion);
        assert_eq!(
            store.current().expect("state").expect("last good").revision(),
            loaded.revision()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn unknown_and_newer_versions_are_rejected_without_content_leaks() {
        let unknown = "version = 1\n[runtimes]\ntmux = \"tmux\"\nfuture_key = \"super-secret\"\n";
        let error = Config::parse(unknown).expect_err("unknown key");
        assert_eq!(error.code(), ValidationCode::UnknownKey);
        assert!(!error.to_string().contains("super-secret"));
        let newer = Config::parse("version = 99\n").expect_err("new version");
        assert_eq!(newer.code(), ValidationCode::UnsupportedVersion);
        assert!(!newer.to_string().contains("99"));
    }

    #[test]
    fn watcher_delivers_valid_external_change_and_redacts_invalid_change() {
        let (dir, path) = config_path();
        fs::write(&path, minimal_toml()).expect("input");
        let store = ConfigStore::new(&path);
        store.load().expect("load");
        let notifications = Arc::new(AtomicUsize::new(0));
        let notifications_thread = Arc::clone(&notifications);
        let watcher = store.watch(Duration::from_millis(10), move |event| {
            if event.is_ok() || event.is_err() {
                notifications_thread.fetch_add(1, Ordering::Relaxed);
            }
        });
        fs::write(&path, "version = 1\n[appearance]\ncolor_scheme = \"dark\"\n")
            .expect("external invalid");
        thread::sleep(Duration::from_millis(40));
        watcher.stop();
        assert!(notifications.load(Ordering::Relaxed) >= 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn runtime_view_keeps_configured_resolved_and_effective_distinct() {
        let config = Config::default();
        let mut effective = config.runtimes.clone();
        effective.tmux_socket_name = "old".to_owned();
        let resolved = ResolvedRuntimeConfig {
            shell: ResolvedRuntime::AbsolutePath(PathBuf::from("/opt/devhub/zsh")),
            git: ResolvedRuntime::CommandName("git".to_owned()),
            tmux: ResolvedRuntime::CommandName("tmux".to_owned()),
            herdr: ResolvedRuntime::AbsolutePath(PathBuf::from("/opt/devhub/herdr")),
        };
        let view = config.runtime_view(resolved.clone(), effective);
        assert_eq!(view.tmux_socket.configured, "devhub");
        assert_eq!(view.tmux_socket.effective, "old");
        assert!(view.tmux_socket.pending);
        assert_eq!(view.resolved, resolved);
    }

    #[test]
    fn debug_output_redacts_paths_commands_arguments_and_environment_values() {
        let mut config = Config::default();
        config.runtimes.shell = "/Users/private/secret-shell".to_owned();
        config.workspace_sources = vec![WorkspaceSource::Command(CommandSource {
            id: "secret".to_owned(),
            command: vec!["workspace_path".to_owned(), "private-command-argument".to_owned()],
            timeout_ms: 2_000,
        })];
        config.agent_profiles = vec![AgentProfile {
            id: "codex".to_owned(),
            display_name: "private-display-name".to_owned(),
            kind: AgentProfileKind::Codex,
            args: vec!["private-agent-argument".to_owned()],
            env: BTreeMap::from([("TOKEN".to_owned(), "private-secret-value".to_owned())]),
        }];
        let debug = format!("{config:?}{:?}{:?}", config.runtimes, config.agent_profiles[0]);
        for secret in [
            "/Users/private/secret-shell",
            "private-command-argument",
            "private-display-name",
            "private-agent-argument",
            "private-secret-value",
        ] {
            assert!(!debug.contains(secret), "debug leaked {secret}: {debug}");
        }
        let store_debug = format!("{:?}", ConfigStore::new("/Users/private/config.toml"));
        assert!(!store_debug.contains("/Users/private/config.toml"));
    }

    #[test]
    fn port_roundtrip_uses_full_config_and_rejects_stale_revision() {
        let (dir, path) = config_path();
        let store = ConfigStore::new(&path);
        let cancel = crate::ports::CancellationToken::new(crate::OperationId::for_test(
            "00000000-0000-4000-8000-000000000001",
        ));
        let port: &dyn crate::ports::ConfigStore = &store;
        let snapshot = drive(port.load(cancel.clone())).expect("port load");
        assert_eq!(snapshot.config.appearance.terminal_font_size, 13);
        assert_eq!(snapshot.schema_version(), CONFIG_SCHEMA_VERSION);

        let mut edited = snapshot.config.clone();
        edited.appearance.terminal_font_size = 16;
        drive(port.save(
            crate::ports::ConfigSnapshot::new(edited.clone(), snapshot.revision),
            cancel.clone(),
        ))
        .expect("port save");
        let reloaded = drive(port.load(cancel.clone())).expect("port reload");
        assert_eq!(reloaded.config, edited);

        let mut externally_edited = edited;
        externally_edited.appearance.terminal_font_size = 17;
        let _ = store.save(reloaded.revision, externally_edited).expect("external save");
        let stale = drive(port.save(
            crate::ports::ConfigSnapshot::new(reloaded.config.clone(), reloaded.revision),
            cancel,
        ))
        .expect_err("stale port revision");
        assert_eq!(stale.code(), crate::ports::PortErrorCode::Conflict);
        let _ = fs::remove_dir_all(dir);
    }
}
