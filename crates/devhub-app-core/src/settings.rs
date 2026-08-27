//! Rust-owned Settings Window contract.
//!
//! The Settings webview receives an immutable projection of the validated
//! user configuration.  It never receives a TOML document or a provider
//! object and it can only save by presenting the content revision it read.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::config::{
    AgentProfile, AgentProfileKind, AppearanceConfig, Config, ConfigError, ContentRevision,
    GeneralConfig, ResolvedRuntime, ResolvedRuntimeConfig, RuntimeConfig, RuntimeView,
    TerminalPalette, TerminalThemeConfig, ValidationCode, WorkspaceKind, WorkspaceSource,
};
use crate::state::{
    CleanupSessionStatus, RecreationSessionStatus, SocketTargetPreflightState,
    SocketTransitionState, TmuxState,
};

pub const SETTINGS_SCHEMA_VERSION: u16 = 1;
pub const SETTINGS_REVISION_HEX_LENGTH: usize = 64;
/// Maximum sequence that can cross the JavaScript safe-integer boundary.
pub const SETTINGS_SEQUENCE_MAX: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsSnapshotWire {
    #[schemars(range(min = SETTINGS_SCHEMA_VERSION, max = SETTINGS_SCHEMA_VERSION))]
    pub schema_version: u16,
    #[schemars(range(min = 1, max = SETTINGS_SEQUENCE_MAX))]
    pub sequence: u64,
    #[schemars(regex(pattern = "^[0-9a-f]{64}$"))]
    pub revision: String,
    pub config: SettingsConfigWire,
    pub runtime: SettingsRuntimeWire,
    pub diagnostic: Option<SettingsDiagnosticWire>,
    pub diagnostics: SettingsDiagnosticsWire,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsDiagnosticsWire {
    #[schemars(regex(
        pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    ))]
    pub session_id: String,
    #[schemars(regex(pattern = "^~/Library/Logs/DevHub$"))]
    pub log_directory: String,
    pub log_level: SettingsLogLevelWire,
    pub previous_exit: SettingsPreviousExitWire,
    pub health: SettingsRuntimeHealthValueWire,
    #[schemars(length(max = 16))]
    pub recent_codes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsLogLevelWire {
    Info,
    Debug,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsPreviousExitWire {
    Clean,
    Unclean,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsConfigWire {
    pub version: u16,
    pub general: SettingsGeneralWire,
    pub runtimes: SettingsRuntimeConfigWire,
    pub appearance: SettingsAppearanceWire,
    pub workspace_sources: Vec<SettingsWorkspaceSourceWire>,
    pub agent_profiles: Vec<SettingsAgentProfileWire>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsGeneralWire {
    pub import_login_environment: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsRuntimeConfigWire {
    pub shell: String,
    pub git: String,
    pub tmux: String,
    pub herdr: String,
    pub tmux_socket_name: String,
    pub tmux_args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsAppearanceWire {
    pub color_scheme: String,
    pub terminal_font_family: String,
    pub terminal_font_size: u8,
    pub terminal_line_height: f64,
    pub sidebar_density: String,
    /// Carried verbatim rather than edited here. `into_config` rebuilds the
    /// whole `AppearanceConfig`, so a field the Settings surface does not
    /// round-trip is a field every save silently resets.
    pub terminal_margin: u8,
    pub terminal_theme: SettingsTerminalThemeWire,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsTerminalThemeWire {
    pub light: SettingsTerminalPaletteWire,
    pub dark: SettingsTerminalPaletteWire,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsTerminalPaletteWire {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub cursor_text: String,
    pub selection_background: String,
    pub selection_foreground: String,
    #[schemars(length(min = 16, max = 16))]
    pub ansi: Vec<String>,
}

impl From<&TerminalPalette> for SettingsTerminalPaletteWire {
    fn from(palette: &TerminalPalette) -> Self {
        Self {
            background: palette.background.clone(),
            foreground: palette.foreground.clone(),
            cursor: palette.cursor.clone(),
            cursor_text: palette.cursor_text.clone(),
            selection_background: palette.selection_background.clone(),
            selection_foreground: palette.selection_foreground.clone(),
            ansi: palette.ansi.clone(),
        }
    }
}

impl From<SettingsTerminalPaletteWire> for TerminalPalette {
    fn from(wire: SettingsTerminalPaletteWire) -> Self {
        Self {
            background: wire.background,
            foreground: wire.foreground,
            cursor: wire.cursor,
            cursor_text: wire.cursor_text,
            selection_background: wire.selection_background,
            selection_foreground: wire.selection_foreground,
            ansi: wire.ansi,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum SettingsWorkspaceSourceWire {
    #[serde(rename = "filesystem")]
    Filesystem {
        id: String,
        path: String,
        #[serde(rename = "minDepth")]
        min_depth: u8,
        #[serde(rename = "maxDepth")]
        max_depth: Option<u8>,
        kinds: Vec<SettingsWorkspaceKindWire>,
        #[serde(rename = "includeHidden")]
        include_hidden: bool,
        #[serde(rename = "excludeNames")]
        exclude_names: Vec<String>,
    },
    #[serde(rename = "command")]
    Command {
        id: String,
        command: Vec<String>,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsWorkspaceKindWire {
    Directory,
    GitRepository,
    GitWorktree,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsAgentProfileWire {
    pub id: String,
    pub display_name: String,
    pub kind: SettingsAgentProfileKindWire,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SettingsAgentProfileKindWire {
    Codex,
    Claude,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsRuntimeWire {
    pub configured: SettingsRuntimeConfigWire,
    pub resolved: SettingsResolvedRuntimeConfigWire,
    pub effective: SettingsRuntimeConfigWire,
    pub health: SettingsRuntimeHealthWire,
    pub socket_change: SettingsSocketChangeWire,
    pub restart_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsResolvedRuntimeConfigWire {
    pub shell: SettingsResolvedRuntimeWire,
    pub git: SettingsResolvedRuntimeWire,
    pub tmux: SettingsResolvedRuntimeWire,
    pub herdr: SettingsResolvedRuntimeWire,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum SettingsResolvedRuntimeWire {
    #[serde(rename = "absolute_path")]
    AbsolutePath { value: String },
    #[serde(rename = "command_name")]
    CommandName { value: String },
    #[serde(rename = "unavailable")]
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsRuntimeHealthValueWire {
    Starting,
    Healthy,
    Degraded,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsRuntimeHealthWire {
    pub shell: SettingsRuntimeHealthValueWire,
    pub git: SettingsRuntimeHealthValueWire,
    pub tmux: SettingsRuntimeHealthValueWire,
    pub herdr: SettingsRuntimeHealthValueWire,
    pub inspection_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsSocketChangeWire {
    pub state: SettingsSocketTransitionWire,
    pub configured_socket_name: String,
    pub effective_socket_name: String,
    pub requested_socket_name: Option<String>,
    pub target_preflight: SettingsSocketPreflightWire,
    pub scratch_session_count: u32,
    pub workspace_session_count: u32,
    pub completed_session_count: u32,
    pub failed_session_count: u32,
    pub conflict_session_count: u32,
    pub confirmation_required: bool,
    pub adapter_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsSocketTransitionWire {
    Stable,
    Pending,
    CleaningOld,
    OldCleaned,
    RecreationPending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsSocketPreflightWire {
    NotChecked,
    TargetAbsent,
    TargetDevhubEmpty,
    WrongMarker,
    MarkedSessions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsDiagnosticCodeWire {
    Io,
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
    StateUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsDiagnosticWire {
    pub code: SettingsDiagnosticCodeWire,
    pub path: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsErrorCodeWire {
    InvalidConfig,
    ExternalEditConflict,
    StaleSocketChange,
    InvalidFile,
    RuntimeUnavailable,
    NativeUnavailable,
    PermissionDenied,
    NativeBusy,
    NativeTimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsErrorWire {
    pub code: SettingsErrorCodeWire,
    pub diagnostic: Option<SettingsDiagnosticWire>,
    pub current_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsSaveRequestWire {
    #[schemars(range(min = SETTINGS_SCHEMA_VERSION, max = SETTINGS_SCHEMA_VERSION))]
    pub schema_version: u16,
    #[schemars(regex(pattern = "^[0-9a-f]{64}$"))]
    pub revision: String,
    pub config: SettingsConfigWire,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsCommandRequestWire {
    #[schemars(range(min = SETTINGS_SCHEMA_VERSION, max = SETTINGS_SCHEMA_VERSION))]
    pub schema_version: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsSocketChangeRequestWire {
    #[schemars(range(min = SETTINGS_SCHEMA_VERSION, max = SETTINGS_SCHEMA_VERSION))]
    pub schema_version: u16,
    #[schemars(regex(pattern = "^[0-9a-f]{64}$"))]
    pub revision: String,
    #[schemars(range(min = 1, max = SETTINGS_SEQUENCE_MAX))]
    pub sequence: u64,
    pub confirmed: bool,
    /// True only when the user is explicitly retrying a previously failed or
    /// persisted transition. This keeps the first destructive confirmation
    /// distinguishable from a later retry at the diagnostics seam.
    pub retry: bool,
}

impl From<&Config> for SettingsConfigWire {
    fn from(config: &Config) -> Self {
        Self {
            version: config.version,
            general: SettingsGeneralWire::from(&config.general),
            runtimes: SettingsRuntimeConfigWire::from(&config.runtimes),
            appearance: SettingsAppearanceWire::from(&config.appearance),
            workspace_sources: config
                .workspace_sources
                .iter()
                .map(SettingsWorkspaceSourceWire::from)
                .collect(),
            agent_profiles: config
                .agent_profiles
                .iter()
                .map(SettingsAgentProfileWire::from)
                .collect(),
        }
    }
}

impl SettingsConfigWire {
    pub fn into_config(self) -> Result<Config, SettingsErrorWire> {
        let config = Config {
            version: self.version,
            general: GeneralConfig {
                import_login_environment: self.general.import_login_environment,
            },
            runtimes: RuntimeConfig {
                shell: self.runtimes.shell,
                git: self.runtimes.git,
                tmux: self.runtimes.tmux,
                herdr: self.runtimes.herdr,
                tmux_socket_name: self.runtimes.tmux_socket_name,
                tmux_args: self.runtimes.tmux_args,
            },
            appearance: AppearanceConfig {
                color_scheme: self.appearance.color_scheme,
                terminal_font_family: self.appearance.terminal_font_family,
                terminal_font_size: self.appearance.terminal_font_size,
                terminal_line_height: self.appearance.terminal_line_height,
                sidebar_density: self.appearance.sidebar_density,
                terminal_margin: self.appearance.terminal_margin,
                terminal_theme: TerminalThemeConfig {
                    light: self.appearance.terminal_theme.light.into(),
                    dark: self.appearance.terminal_theme.dark.into(),
                },
            },
            workspace_sources: self
                .workspace_sources
                .into_iter()
                .map(SettingsWorkspaceSourceWire::into_config)
                .collect::<Result<_, _>>()?,
            agent_profiles: self
                .agent_profiles
                .into_iter()
                .map(SettingsAgentProfileWire::into_config)
                .collect::<Result<_, _>>()?,
        };
        config.validate().map_err(SettingsErrorWire::from_config)?;
        Ok(config)
    }
}

impl From<&GeneralConfig> for SettingsGeneralWire {
    fn from(config: &GeneralConfig) -> Self {
        Self { import_login_environment: config.import_login_environment }
    }
}

impl From<&RuntimeConfig> for SettingsRuntimeConfigWire {
    fn from(config: &RuntimeConfig) -> Self {
        Self {
            shell: config.shell.clone(),
            git: config.git.clone(),
            tmux: config.tmux.clone(),
            herdr: config.herdr.clone(),
            tmux_socket_name: config.tmux_socket_name.clone(),
            tmux_args: config.tmux_args.clone(),
        }
    }
}

impl From<&AppearanceConfig> for SettingsAppearanceWire {
    fn from(config: &AppearanceConfig) -> Self {
        Self {
            color_scheme: config.color_scheme.clone(),
            terminal_font_family: config.terminal_font_family.clone(),
            terminal_font_size: config.terminal_font_size,
            terminal_line_height: config.terminal_line_height,
            sidebar_density: config.sidebar_density.clone(),
            terminal_margin: config.terminal_margin,
            terminal_theme: SettingsTerminalThemeWire {
                light: (&config.terminal_theme.light).into(),
                dark: (&config.terminal_theme.dark).into(),
            },
        }
    }
}

impl From<&WorkspaceSource> for SettingsWorkspaceSourceWire {
    fn from(source: &WorkspaceSource) -> Self {
        match source {
            WorkspaceSource::Filesystem(source) => Self::Filesystem {
                id: source.id.clone(),
                path: source.path.clone(),
                min_depth: source.min_depth,
                max_depth: source.max_depth,
                kinds: source.kinds.iter().copied().map(Into::into).collect(),
                include_hidden: source.include_hidden,
                exclude_names: source.exclude_names.clone(),
            },
            WorkspaceSource::Command(source) => Self::Command {
                id: source.id.clone(),
                command: source.command.clone(),
                timeout_ms: source.timeout_ms,
            },
        }
    }
}

impl SettingsWorkspaceSourceWire {
    fn into_config(self) -> Result<WorkspaceSource, SettingsErrorWire> {
        Ok(match self {
            Self::Filesystem {
                id,
                path,
                min_depth,
                max_depth,
                kinds,
                include_hidden,
                exclude_names,
            } => WorkspaceSource::Filesystem(crate::config::FilesystemSource {
                id,
                path,
                min_depth,
                max_depth,
                kinds: kinds.into_iter().map(Into::into).collect(),
                include_hidden,
                exclude_names,
            }),
            Self::Command { id, command, timeout_ms } => {
                WorkspaceSource::Command(crate::config::CommandSource { id, command, timeout_ms })
            }
        })
    }
}

impl From<WorkspaceKind> for SettingsWorkspaceKindWire {
    fn from(kind: WorkspaceKind) -> Self {
        match kind {
            WorkspaceKind::Directory => Self::Directory,
            WorkspaceKind::GitRepository => Self::GitRepository,
            WorkspaceKind::GitWorktree => Self::GitWorktree,
        }
    }
}

impl From<SettingsWorkspaceKindWire> for WorkspaceKind {
    fn from(kind: SettingsWorkspaceKindWire) -> Self {
        match kind {
            SettingsWorkspaceKindWire::Directory => Self::Directory,
            SettingsWorkspaceKindWire::GitRepository => Self::GitRepository,
            SettingsWorkspaceKindWire::GitWorktree => Self::GitWorktree,
        }
    }
}

impl From<&AgentProfile> for SettingsAgentProfileWire {
    fn from(profile: &AgentProfile) -> Self {
        Self {
            id: profile.id.clone(),
            display_name: profile.display_name.clone(),
            kind: profile.kind.into(),
            args: profile.args.clone(),
            env: profile.env.clone(),
        }
    }
}

impl SettingsAgentProfileWire {
    fn into_config(self) -> Result<AgentProfile, SettingsErrorWire> {
        Ok(AgentProfile {
            id: self.id,
            display_name: self.display_name,
            kind: self.kind.into(),
            args: self.args,
            env: self.env,
        })
    }
}

impl From<AgentProfileKind> for SettingsAgentProfileKindWire {
    fn from(kind: AgentProfileKind) -> Self {
        match kind {
            AgentProfileKind::Codex => Self::Codex,
            AgentProfileKind::Claude => Self::Claude,
        }
    }
}

impl From<SettingsAgentProfileKindWire> for AgentProfileKind {
    fn from(kind: SettingsAgentProfileKindWire) -> Self {
        match kind {
            SettingsAgentProfileKindWire::Codex => Self::Codex,
            SettingsAgentProfileKindWire::Claude => Self::Claude,
        }
    }
}

impl SettingsSnapshotWire {
    pub fn from_config(
        config: &Config,
        revision: ContentRevision,
        sequence: u64,
        runtime: SettingsRuntimeWire,
        diagnostic: Option<SettingsDiagnosticWire>,
        diagnostics: SettingsDiagnosticsWire,
    ) -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            sequence,
            revision: revision.to_string(),
            config: SettingsConfigWire::from(config),
            runtime,
            diagnostic,
            diagnostics,
        }
    }

    pub fn from_loaded(
        loaded: &crate::config::LoadedConfig,
        sequence: u64,
        runtime: SettingsRuntimeWire,
        diagnostic: Option<SettingsDiagnosticWire>,
        diagnostics: SettingsDiagnosticsWire,
    ) -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            sequence,
            revision: loaded.revision().to_string(),
            config: SettingsConfigWire::from(loaded.config()),
            runtime,
            diagnostic,
            diagnostics,
        }
    }

    pub fn validate(&self) -> Result<(), SettingsErrorWire> {
        if self.schema_version != SETTINGS_SCHEMA_VERSION {
            return Err(SettingsErrorWire::invalid_config());
        }
        if self.sequence == 0 || self.sequence > SETTINGS_SEQUENCE_MAX {
            return Err(SettingsErrorWire::invalid_config());
        }
        let _ = parse_revision(&self.revision).ok_or_else(SettingsErrorWire::invalid_config)?;
        if !is_diagnostic_session_id(&self.diagnostics.session_id)
            || self.diagnostics.log_directory != "~/Library/Logs/DevHub"
            || self.diagnostics.recent_codes.len() > 16
            || self.diagnostics.recent_codes.iter().any(|code| {
                code.is_empty()
                    || code.len() > 64
                    || !code.chars().all(|character| {
                        character.is_ascii_lowercase()
                            || character.is_ascii_digit()
                            || character == '_'
                    })
            })
        {
            return Err(SettingsErrorWire::invalid_config());
        }
        self.config.clone().into_config().map(|_| ())
    }
}

fn is_diagnostic_session_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|&index| bytes[index] == b'-')
        && bytes.iter().enumerate().all(|(index, &byte)| {
            if [8, 13, 18, 23].contains(&index) {
                return true;
            }
            byte.is_ascii_hexdigit()
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8'..=b'9' | b'a'..=b'b')
}

impl SettingsSaveRequestWire {
    pub fn validate(&self) -> Result<(), SettingsErrorWire> {
        if self.schema_version != SETTINGS_SCHEMA_VERSION
            || parse_revision(&self.revision).is_none()
        {
            return Err(SettingsErrorWire::invalid_config());
        }
        self.config.clone().into_config().map(|_| ())
    }
}

impl SettingsCommandRequestWire {
    pub fn validate(&self) -> Result<(), SettingsErrorWire> {
        (self.schema_version == SETTINGS_SCHEMA_VERSION)
            .then_some(())
            .ok_or_else(SettingsErrorWire::invalid_config)
    }
}

impl SettingsSocketChangeRequestWire {
    pub fn validate(&self) -> Result<(), SettingsErrorWire> {
        if self.schema_version != SETTINGS_SCHEMA_VERSION
            || parse_revision(&self.revision).is_none()
            || self.sequence == 0
            || self.sequence > SETTINGS_SEQUENCE_MAX
        {
            return Err(SettingsErrorWire::invalid_config());
        }
        Ok(())
    }
}

impl SettingsRuntimeWire {
    pub fn from_runtime_view(
        view: &RuntimeView,
        transition: &TmuxState,
        health: SettingsRuntimeHealthWire,
        adapter_available: bool,
    ) -> Self {
        let configured = SettingsRuntimeConfigWire::from(&view.configured);
        let effective = SettingsRuntimeConfigWire::from(&view.effective);
        let restart_required = configured.shell != effective.shell
            || configured.git != effective.git
            || configured.tmux != effective.tmux
            || configured.herdr != effective.herdr
            || configured.tmux_args != effective.tmux_args
            || view.configured_import_login_environment != view.effective_import_login_environment;
        Self {
            configured,
            resolved: SettingsResolvedRuntimeConfigWire::from(&view.resolved),
            effective,
            health,
            socket_change: SettingsSocketChangeWire::from_state(
                &view.configured.tmux_socket_name,
                &transition.effective_socket_name,
                &transition.transition,
                adapter_available,
            ),
            restart_required,
        }
    }
}

impl From<&ResolvedRuntimeConfig> for SettingsResolvedRuntimeConfigWire {
    fn from(config: &ResolvedRuntimeConfig) -> Self {
        Self {
            shell: (&config.shell).into(),
            git: (&config.git).into(),
            tmux: (&config.tmux).into(),
            herdr: (&config.herdr).into(),
        }
    }
}

impl From<&ResolvedRuntime> for SettingsResolvedRuntimeWire {
    fn from(runtime: &ResolvedRuntime) -> Self {
        match runtime {
            ResolvedRuntime::AbsolutePath(path) => {
                Self::AbsolutePath { value: path.to_string_lossy().into_owned() }
            }
            ResolvedRuntime::CommandName(value) => Self::CommandName { value: value.clone() },
        }
    }
}

impl SettingsSocketChangeWire {
    fn from_state(
        configured: &str,
        effective: &str,
        transition: &SocketTransitionState,
        adapter_available: bool,
    ) -> Self {
        let mut output = Self {
            state: SettingsSocketTransitionWire::Stable,
            configured_socket_name: configured.to_owned(),
            effective_socket_name: effective.to_owned(),
            requested_socket_name: None,
            target_preflight: SettingsSocketPreflightWire::NotChecked,
            scratch_session_count: 0,
            workspace_session_count: 0,
            completed_session_count: 0,
            failed_session_count: 0,
            conflict_session_count: 0,
            confirmation_required: false,
            adapter_available,
        };
        match transition {
            SocketTransitionState::Stable => {}
            SocketTransitionState::Pending {
                requested_socket_name,
                preflight,
                verified_old_sessions,
                ..
            } => {
                output.state = SettingsSocketTransitionWire::Pending;
                output.requested_socket_name = Some(requested_socket_name.clone());
                output.target_preflight = (*preflight).into();
                // Before the old socket inventory is verified, do not claim
                // that the confirmation counts are exact. Once present, the
                // persisted inventory is the destructive set and may include
                // orphaned sessions beyond the recreation set.
                if let Some(sessions) = verified_old_sessions {
                    set_required_counts(&mut output, sessions);
                } else {
                    set_required_counts(&mut output, &[]);
                }
                output.confirmation_required = adapter_available
                    && matches!(
                        preflight,
                        SocketTargetPreflightState::TargetAbsent
                            | SocketTargetPreflightState::TargetDevhubEmpty
                    )
                    && verified_old_sessions.is_some();
            }
            SocketTransitionState::CleaningOld {
                requested_socket_name,
                target_preflight,
                sessions,
                ..
            } => {
                output.state = SettingsSocketTransitionWire::CleaningOld;
                output.requested_socket_name = Some(requested_socket_name.clone());
                output.target_preflight = (*target_preflight).into();
                set_cleanup_counts(&mut output, sessions);
            }
            SocketTransitionState::OldCleaned { new_socket_name, required, .. } => {
                output.state = SettingsSocketTransitionWire::OldCleaned;
                output.requested_socket_name = Some(new_socket_name.clone());
                set_required_counts(&mut output, required.sessions());
                output.completed_session_count =
                    output.scratch_session_count + output.workspace_session_count;
            }
            SocketTransitionState::RecreationPending {
                effective_socket_name, sessions, ..
            } => {
                output.state = SettingsSocketTransitionWire::RecreationPending;
                output.requested_socket_name = Some(effective_socket_name.clone());
                set_recreation_counts(&mut output, sessions);
            }
        }
        output
    }
}

fn set_required_counts(
    output: &mut SettingsSocketChangeWire,
    sessions: &[crate::state::OwnedSessionRecord],
) {
    output.scratch_session_count = sessions
        .iter()
        .filter(|session| matches!(session, crate::state::OwnedSessionRecord::Scratch { .. }))
        .count() as u32;
    output.workspace_session_count = sessions.len() as u32 - output.scratch_session_count;
}

fn set_cleanup_counts(
    output: &mut SettingsSocketChangeWire,
    sessions: &[crate::state::CleanupSessionRecord],
) {
    set_required_counts(
        output,
        &sessions.iter().map(|record| record.session.clone()).collect::<Vec<_>>(),
    );
    output.completed_session_count =
        sessions.iter().filter(|record| record.status == CleanupSessionStatus::Completed).count()
            as u32;
    output.failed_session_count =
        sessions.iter().filter(|record| record.status == CleanupSessionStatus::Failed).count()
            as u32;
    output.conflict_session_count =
        sessions.iter().filter(|record| record.status == CleanupSessionStatus::Conflict).count()
            as u32;
}

fn set_recreation_counts(
    output: &mut SettingsSocketChangeWire,
    sessions: &[crate::state::RecreationSessionRecord],
) {
    set_required_counts(
        output,
        &sessions.iter().map(|record| record.session.clone()).collect::<Vec<_>>(),
    );
    output.completed_session_count = sessions
        .iter()
        .filter(|record| record.status == RecreationSessionStatus::Completed)
        .count() as u32;
    output.failed_session_count =
        sessions.iter().filter(|record| record.status == RecreationSessionStatus::Failed).count()
            as u32;
}

impl From<SocketTargetPreflightState> for SettingsSocketPreflightWire {
    fn from(value: SocketTargetPreflightState) -> Self {
        match value {
            SocketTargetPreflightState::NotChecked => Self::NotChecked,
            SocketTargetPreflightState::TargetAbsent => Self::TargetAbsent,
            SocketTargetPreflightState::TargetDevhubEmpty => Self::TargetDevhubEmpty,
            SocketTargetPreflightState::WrongMarker => Self::WrongMarker,
            SocketTargetPreflightState::MarkedSessions => Self::MarkedSessions,
        }
    }
}

impl SettingsRuntimeHealthWire {
    pub const fn unavailable() -> Self {
        Self {
            shell: SettingsRuntimeHealthValueWire::Unavailable,
            git: SettingsRuntimeHealthValueWire::Unavailable,
            tmux: SettingsRuntimeHealthValueWire::Unavailable,
            herdr: SettingsRuntimeHealthValueWire::Unavailable,
            inspection_available: false,
        }
    }
}

impl From<ValidationCode> for SettingsDiagnosticCodeWire {
    fn from(code: ValidationCode) -> Self {
        match code {
            ValidationCode::Io => Self::Io,
            ValidationCode::StateUnavailable => Self::StateUnavailable,
            ValidationCode::InvalidUtf8 => Self::InvalidUtf8,
            ValidationCode::Parse => Self::Parse,
            ValidationCode::MissingRequiredField => Self::MissingRequiredField,
            ValidationCode::UnknownKey => Self::UnknownKey,
            ValidationCode::InvalidType => Self::InvalidType,
            ValidationCode::UnsupportedVersion => Self::UnsupportedVersion,
            ValidationCode::InvalidString => Self::InvalidString,
            ValidationCode::InvalidId => Self::InvalidId,
            ValidationCode::DuplicateIdentity => Self::DuplicateIdentity,
            ValidationCode::InvalidRuntime => Self::InvalidRuntime,
            ValidationCode::InvalidSocketName => Self::InvalidSocketName,
            ValidationCode::ForbiddenTmuxArgument => Self::ForbiddenTmuxArgument,
            ValidationCode::InvalidAppearance => Self::InvalidAppearance,
            ValidationCode::InvalidWorkspacePath => Self::InvalidWorkspacePath,
            ValidationCode::InvalidWorkspaceDepth => Self::InvalidWorkspaceDepth,
            ValidationCode::InvalidWorkspaceKind => Self::InvalidWorkspaceKind,
            ValidationCode::InvalidExclusion => Self::InvalidExclusion,
            ValidationCode::InvalidCommand => Self::InvalidCommand,
            ValidationCode::InvalidTimeout => Self::InvalidTimeout,
            ValidationCode::InvalidProfile => Self::InvalidProfile,
            ValidationCode::InvalidProfileKind => Self::InvalidProfileKind,
            ValidationCode::InvalidEnvironmentKey => Self::InvalidEnvironmentKey,
            ValidationCode::Conflict => Self::Conflict,
            ValidationCode::Serialization => Self::Serialization,
        }
    }
}

impl From<&crate::config::ConfigDiagnostic> for SettingsDiagnosticWire {
    fn from(diagnostic: &crate::config::ConfigDiagnostic) -> Self {
        let location = diagnostic.location();
        Self {
            code: diagnostic.code().into(),
            path: diagnostic.path().map(str::to_owned),
            line: location.map(|location| location.line as u32),
            column: location.map(|location| location.column as u32),
        }
    }
}

impl SettingsErrorWire {
    pub const fn invalid_config() -> Self {
        Self {
            code: SettingsErrorCodeWire::InvalidConfig,
            diagnostic: None,
            current_revision: None,
        }
    }

    pub const fn runtime_unavailable() -> Self {
        Self {
            code: SettingsErrorCodeWire::RuntimeUnavailable,
            diagnostic: None,
            current_revision: None,
        }
    }

    pub const fn stale_socket_change() -> Self {
        Self {
            code: SettingsErrorCodeWire::StaleSocketChange,
            diagnostic: None,
            current_revision: None,
        }
    }

    pub const fn native_unavailable() -> Self {
        Self {
            code: SettingsErrorCodeWire::NativeUnavailable,
            diagnostic: None,
            current_revision: None,
        }
    }

    pub const fn invalid_file() -> Self {
        Self { code: SettingsErrorCodeWire::InvalidFile, diagnostic: None, current_revision: None }
    }

    pub const fn permission_denied() -> Self {
        Self {
            code: SettingsErrorCodeWire::PermissionDenied,
            diagnostic: None,
            current_revision: None,
        }
    }

    pub const fn native_busy() -> Self {
        Self { code: SettingsErrorCodeWire::NativeBusy, diagnostic: None, current_revision: None }
    }

    pub const fn native_timed_out() -> Self {
        Self {
            code: SettingsErrorCodeWire::NativeTimedOut,
            diagnostic: None,
            current_revision: None,
        }
    }

    pub fn from_config(error: ConfigError) -> Self {
        let diagnostic = error.diagnostic();
        Self {
            code: match error {
                ConfigError::Conflict { .. } => SettingsErrorCodeWire::ExternalEditConflict,
                ConfigError::Io { .. } | ConfigError::StateUnavailable => {
                    SettingsErrorCodeWire::InvalidFile
                }
                _ => SettingsErrorCodeWire::InvalidConfig,
            },
            diagnostic: Some((&diagnostic).into()),
            current_revision: match error {
                ConfigError::Conflict { actual: Some(actual), .. } => Some(actual.to_string()),
                _ => None,
            },
        }
    }

    pub fn with_diagnostic(mut self, diagnostic: SettingsDiagnosticWire) -> Self {
        self.diagnostic = Some(diagnostic);
        self
    }
}

pub fn parse_revision(raw: &str) -> Option<ContentRevision> {
    ContentRevision::from_hex(raw)
}

pub fn classify_runtime(config: &RuntimeConfig) -> ResolvedRuntimeConfig {
    fn classify(value: &str) -> ResolvedRuntime {
        if value.starts_with('/') {
            ResolvedRuntime::AbsolutePath(value.into())
        } else {
            ResolvedRuntime::CommandName(value.to_owned())
        }
    }
    ResolvedRuntimeConfig {
        shell: classify(&config.shell),
        git: classify(&config.git),
        tmux: classify(&config.tmux),
        herdr: classify(&config.herdr),
    }
}

pub fn runtime_view_for_config(config: &Config, effective_socket_name: &str) -> RuntimeView {
    let mut effective = config.runtimes.clone();
    effective.tmux_socket_name = effective_socket_name.to_owned();
    config.runtime_view(
        classify_runtime(&config.runtimes),
        effective,
        config.general.import_login_environment,
    )
}

pub fn settings_diagnostic_from_error(error: &ConfigError) -> SettingsDiagnosticWire {
    let diagnostic = error.diagnostic();
    (&diagnostic).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ConfigStore, ReloadOutcome};
    use std::path::PathBuf;

    #[test]
    fn settings_config_round_trips_the_complete_default_schema() {
        let config = Config::default();
        let wire = SettingsConfigWire::from(&config);
        let decoded = wire.clone().into_config().expect("default wire is valid");
        assert_eq!(decoded, config);
        assert_eq!(wire.runtimes.tmux_socket_name, "devhub");
        assert!(wire.agent_profiles.iter().all(|profile| profile.env.is_empty()));
    }

    #[test]
    fn settings_revision_is_hex_and_runtime_socket_state_is_explicit() {
        let store = ConfigStore::new(PathBuf::from("/tmp/devhub-settings-test.toml"));
        let _ = store;
        let revision = ContentRevision::from_hex(&"00".repeat(32)).expect("hex revision");
        assert_eq!(revision.to_string().len(), SETTINGS_REVISION_HEX_LENGTH);
        let tmux = TmuxState::default();
        let config = Config::default();
        let view = runtime_view_for_config(&config, &tmux.effective_socket_name);
        let runtime = SettingsRuntimeWire::from_runtime_view(
            &view,
            &tmux,
            SettingsRuntimeHealthWire::unavailable(),
            false,
        );
        assert_eq!(runtime.socket_change.state, SettingsSocketTransitionWire::Stable);
        assert!(!runtime.socket_change.adapter_available);
        assert!(matches!(store.current(), Ok(None)));
        assert!(matches!(ReloadOutcome::Unchanged { revision }, ReloadOutcome::Unchanged { .. }));
    }

    #[test]
    fn shared_settings_fixtures_are_strictly_owned_by_rust() {
        for value in serde_json::from_str::<Vec<serde_json::Value>>(include_str!(
            "../../../contracts/settings/valid.json"
        ))
        .expect("valid Settings fixture array")
        {
            if value.get("runtime").is_some() {
                let snapshot: SettingsSnapshotWire =
                    serde_json::from_value(value).expect("valid Settings snapshot");
                snapshot.validate().expect("valid Settings snapshot constraints");
            } else if value.get("workspaceSources").is_some() {
                let config: SettingsConfigWire =
                    serde_json::from_value(value).expect("valid Settings config");
                config.into_config().expect("valid Settings config constraints");
            } else if value.get("confirmed").is_some() {
                let request: SettingsSocketChangeRequestWire =
                    serde_json::from_value(value).expect("valid socket request");
                request.validate().expect("valid socket request constraints");
            } else if value.get("revision").is_some() {
                let request: SettingsSaveRequestWire =
                    serde_json::from_value(value).expect("valid save request");
                request.validate().expect("valid save request constraints");
            } else if value.get("code").is_some() {
                serde_json::from_value::<SettingsErrorWire>(value).expect("valid Settings error");
            } else {
                let request: SettingsCommandRequestWire =
                    serde_json::from_value(value).expect("valid command request");
                request.validate().expect("valid command request constraints");
            }
        }
    }

    #[test]
    fn shared_invalid_settings_fixtures_are_rejected() {
        for value in serde_json::from_str::<Vec<serde_json::Value>>(include_str!(
            "../../../contracts/settings/invalid.json"
        ))
        .expect("invalid Settings fixture array")
        {
            let rejected = if value.get("runtime").is_some() {
                serde_json::from_value::<SettingsSnapshotWire>(value.clone())
                    .and_then(|snapshot| {
                        snapshot.validate().map_err(|error| {
                            serde_json::Error::io(std::io::Error::other(format!("{error:?}")))
                        })
                    })
                    .is_err()
            } else if value.get("workspaceSources").is_some() {
                serde_json::from_value::<SettingsConfigWire>(value.clone())
                    .and_then(|config| {
                        config.into_config().map(|_| ()).map_err(|error| {
                            serde_json::Error::io(std::io::Error::other(format!("{error:?}")))
                        })
                    })
                    .is_err()
            } else if value.get("revision").is_some() {
                serde_json::from_value::<SettingsSaveRequestWire>(value.clone())
                    .and_then(|request| {
                        request.validate().map_err(|error| {
                            serde_json::Error::io(std::io::Error::other(format!("{error:?}")))
                        })
                    })
                    .is_err()
            } else {
                serde_json::from_value::<SettingsCommandRequestWire>(value.clone())
                    .and_then(|request| {
                        request.validate().map_err(|error| {
                            serde_json::Error::io(std::io::Error::other(format!("{error:?}")))
                        })
                    })
                    .is_err()
            };
            assert!(rejected, "invalid Settings fixture was accepted: {value}");
        }
    }
}
