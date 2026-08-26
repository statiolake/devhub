//! Errors emitted by the native EditorHost.
//!
//! The code is the actionable classification; `detail` carries what actually
//! went wrong for the local user who has to fix it.

use std::fmt;

/// A deliberately small error algebra for the EditorHost seam.  Paths and
/// process arguments stay in the implementation; callers receive only an
/// actionable, content-free code and summary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorErrorCode {
    InvalidSurface,
    InvalidWorkspaceRoot,
    InvalidPort,
    PortConflict,
    PermissionDenied,
    TokenUnavailable,
    ExecutableUnavailable,
    ExecutableIdentityMismatch,
    OfficialVscodeUnavailable,
    ProviderCapabilityMismatch,
    BridgeUnavailable,
    BridgeInstallFailed,
    ProcessUnavailable,
    ProcessIdentityMismatch,
    ProcessExited,
    ReadinessTimeout,
    WebViewUnavailable,
    NavigationDenied,
    LifecycleConflict,
    Io,
}

impl EditorErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidSurface => "invalid_surface",
            Self::InvalidWorkspaceRoot => "invalid_workspace_root",
            Self::InvalidPort => "invalid_port",
            Self::PortConflict => "port_conflict",
            Self::PermissionDenied => "permission_denied",
            Self::TokenUnavailable => "token_unavailable",
            Self::ExecutableUnavailable => "executable_unavailable",
            Self::ExecutableIdentityMismatch => "executable_identity_mismatch",
            Self::OfficialVscodeUnavailable => "official_vscode_unavailable",
            Self::ProviderCapabilityMismatch => "provider_capability_mismatch",
            Self::BridgeUnavailable => "bridge_unavailable",
            Self::BridgeInstallFailed => "bridge_install_failed",
            Self::ProcessUnavailable => "process_unavailable",
            Self::ProcessIdentityMismatch => "process_identity_mismatch",
            Self::ProcessExited => "process_exited",
            Self::ReadinessTimeout => "readiness_timeout",
            Self::WebViewUnavailable => "webview_unavailable",
            Self::NavigationDenied => "navigation_denied",
            Self::LifecycleConflict => "lifecycle_conflict",
            Self::Io => "io",
        }
    }
}

/// The EditorHost never includes URLs, tokens, editor contents, command lines,
/// or full paths in this value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorError {
    code: EditorErrorCode,
    summary: String,
    detail: Option<String>,
}

impl EditorError {
    pub fn new(code: EditorErrorCode) -> Self {
        Self::from_code(code)
    }

    pub fn from_code(code: EditorErrorCode) -> Self {
        Self { code, summary: summary_for(code).to_owned(), detail: None }
    }

    /// Record the concrete cause: the provider's message, the port that was
    /// taken, the path that could not be read.
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        self.detail = (!detail.is_empty()).then_some(detail);
        self
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }

    pub const fn code(&self) -> EditorErrorCode {
        self.code
    }

    pub fn summary(&self) -> &str {
        &self.summary
    }
}

const fn summary_for(code: EditorErrorCode) -> &'static str {
    match code {
        EditorErrorCode::InvalidSurface => "The editor surface identity is invalid.",
        EditorErrorCode::InvalidWorkspaceRoot => "The editor workspace root is unavailable.",
        EditorErrorCode::InvalidPort => "The editor provider port configuration is invalid.",
        EditorErrorCode::PortConflict => "The stable editor provider port is occupied.",
        EditorErrorCode::PermissionDenied => "DevHub cannot access its editor runtime files.",
        EditorErrorCode::TokenUnavailable => {
            "DevHub cannot create its editor authentication token."
        }
        EditorErrorCode::ExecutableUnavailable => {
            "The selected editor provider executable is unavailable."
        }
        EditorErrorCode::ExecutableIdentityMismatch => {
            "The editor provider executable identity is not accepted."
        }
        EditorErrorCode::OfficialVscodeUnavailable => {
            "DevHub looks for the `code` command on your PATH and in the usual application locations. Install Visual Studio Code, or open its Command Palette and run \"Shell Command: Install 'code' command in PATH\", then retry."
        }
        EditorErrorCode::ProviderCapabilityMismatch => {
            "The selected editor provider does not support DevHub's required Web Workbench contract."
        }
        EditorErrorCode::BridgeUnavailable => "The bundled DevHub Bridge extension is unavailable.",
        EditorErrorCode::BridgeInstallFailed => {
            "The DevHub Bridge extension could not be installed."
        }
        EditorErrorCode::ProcessUnavailable => "The editor provider process is unavailable.",
        EditorErrorCode::ProcessIdentityMismatch => {
            "The editor provider process identity could not be verified."
        }
        EditorErrorCode::ProcessExited => "The editor provider process exited unexpectedly.",
        EditorErrorCode::ReadinessTimeout => {
            "The editor provider did not become ready within the restart budget."
        }
        EditorErrorCode::WebViewUnavailable => "The editor WebView is unavailable.",
        EditorErrorCode::NavigationDenied => "Editor navigation was denied.",
        EditorErrorCode::LifecycleConflict => {
            "The editor lifecycle operation conflicts with current state."
        }
        EditorErrorCode::Io => "The editor provider runtime operation failed.",
    }
}

impl fmt::Display for EditorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.summary)
    }
}

impl std::error::Error for EditorError {}

impl From<std::io::Error> for EditorError {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::PermissionDenied => EditorErrorCode::PermissionDenied,
            std::io::ErrorKind::AddrInUse => EditorErrorCode::PortConflict,
            _ => EditorErrorCode::Io,
        };
        // Error messages are intentionally not copied: OS messages can carry
        // paths or command output and therefore violate the diagnostics rule.
        Self::new(code)
    }
}

pub type EditorResult<T> = Result<T, EditorError>;
