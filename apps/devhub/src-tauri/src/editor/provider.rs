//! Provider-neutral executable discovery and capability probing.
//!
//! `EditorHost` owns one lifecycle regardless of which local Web Workbench is
//! selected.  This module is the only place that knows how an executable is
//! discovered and which CLI shape it supports.  The bundled OpenVSCode build
//! remains a pinned fallback; a user-installed official VS Code is the
//! preferred `Auto` candidate and is never downloaded or redistributed by
//! DevHub.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use super::error::{EditorError, EditorErrorCode, EditorResult};
use super::paths::{EditorProviderKind, PinnedExecutable};

const OFFICIAL_CLI_ENV: &str = "DEVHUB_VSCODE_CLI";
const OPENVSCODE_READINESS_TIMEOUT: Duration = Duration::from_secs(8);
const OFFICIAL_VSCODE_PROVISIONING_TIMEOUT: Duration = Duration::from_secs(120);
const REQUIRED_HELP_FLAGS: [&str; 4] =
    ["--connection-token-file", "--server-data-dir", "--disable-telemetry", "--default-folder"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EditorProviderPreference {
    #[default]
    Auto,
    OfficialVscode,
    OpenVscode,
}

impl EditorProviderPreference {
    /// Read only the provider selector.  Executable paths and consent are
    /// supplied separately so this value cannot smuggle a command line into
    /// the lifecycle seam.
    pub fn from_environment() -> Self {
        match std::env::var("DEVHUB_EDITOR_PROVIDER").ok().as_deref() {
            Some("official-vscode") => Self::OfficialVscode,
            Some("openvscode") => Self::OpenVscode,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfficialVscodeCapabilities {
    pub connection_token_file: bool,
    pub server_data_dir: bool,
    pub disable_telemetry: bool,
    pub default_folder: bool,
}

impl OfficialVscodeCapabilities {
    fn from_help(help: &str) -> Option<Self> {
        let [connection_token_file, server_data_dir, disable_telemetry, default_folder] =
            REQUIRED_HELP_FLAGS.map(|flag| help.contains(flag));
        let capabilities =
            Self { connection_token_file, server_data_dir, disable_telemetry, default_folder };
        capabilities.supported().then_some(capabilities)
    }

    pub const fn supported(self) -> bool {
        self.connection_token_file
            && self.server_data_dir
            && self.disable_telemetry
            && self.default_folder
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfficialVscodeExecutable {
    path: PathBuf,
    pub version: String,
    pub commit: String,
    pub architecture: String,
    pub capabilities: OfficialVscodeCapabilities,
}

impl OfficialVscodeExecutable {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn resolve(explicit_path: Option<&Path>) -> EditorResult<Self> {
        if let Some(path) = explicit_path {
            return Self::from_path(path.to_path_buf());
        }
        for path in discovery_candidates() {
            if fs::metadata(&path).is_ok() {
                return Self::from_path(path);
            }
        }
        Err(EditorError::new(EditorErrorCode::OfficialVscodeUnavailable))
    }

    pub fn from_path(path: PathBuf) -> EditorResult<Self> {
        let metadata = fs::metadata(&path)
            .map_err(|_| EditorError::new(EditorErrorCode::OfficialVscodeUnavailable))?;
        if !metadata.is_file() || !is_executable(&metadata) {
            return Err(EditorError::new(EditorErrorCode::OfficialVscodeUnavailable));
        }
        let path = fs::canonicalize(path)
            .map_err(|_| EditorError::new(EditorErrorCode::OfficialVscodeUnavailable))?;
        let version_output = Command::new(&path)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .map_err(|_| EditorError::new(EditorErrorCode::OfficialVscodeUnavailable))?;
        if !version_output.status.success() {
            return Err(EditorError::new(EditorErrorCode::OfficialVscodeUnavailable));
        }
        let version_text = String::from_utf8(version_output.stdout)
            .map_err(|_| EditorError::new(EditorErrorCode::OfficialVscodeUnavailable))?;
        let mut lines = version_text.lines().filter(|line| !line.trim().is_empty());
        let version = lines
            .next()
            .map(str::trim)
            .filter(|value| is_semver(value))
            .ok_or_else(|| EditorError::new(EditorErrorCode::ProviderCapabilityMismatch))?
            .to_owned();
        let commit = lines
            .next()
            .map(str::trim)
            .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| EditorError::new(EditorErrorCode::ProviderCapabilityMismatch))?
            .to_owned();
        let architecture = lines
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 32)
            .ok_or_else(|| EditorError::new(EditorErrorCode::ProviderCapabilityMismatch))?
            .to_owned();

        let help_output = Command::new(&path)
            .args(["serve-web", "--help"])
            .stdin(Stdio::null())
            .output()
            .map_err(|_| EditorError::new(EditorErrorCode::OfficialVscodeUnavailable))?;
        let help = format!(
            "{}\n{}",
            String::from_utf8_lossy(&help_output.stdout),
            String::from_utf8_lossy(&help_output.stderr)
        );
        let capabilities = OfficialVscodeCapabilities::from_help(&help)
            .ok_or_else(|| EditorError::new(EditorErrorCode::ProviderCapabilityMismatch))?;
        Ok(Self { path, version, commit, architecture, capabilities })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorExecutable {
    OfficialVscode(OfficialVscodeExecutable),
    OpenVscode(PinnedExecutable),
}

impl EditorExecutable {
    pub fn resolve(
        preference: EditorProviderPreference,
        resource_dir: Option<&Path>,
        official_path: Option<&Path>,
    ) -> EditorResult<Self> {
        match preference {
            EditorProviderPreference::OfficialVscode => {
                OfficialVscodeExecutable::resolve(official_path).map(Self::OfficialVscode)
            }
            EditorProviderPreference::OpenVscode => {
                PinnedExecutable::resolve(resource_dir).map(Self::OpenVscode)
            }
            EditorProviderPreference::Auto => OfficialVscodeExecutable::resolve(official_path)
                .map(Self::OfficialVscode)
                .or_else(|error| {
                    if error.code() == EditorErrorCode::OfficialVscodeUnavailable {
                        PinnedExecutable::resolve(resource_dir).map(Self::OpenVscode)
                    } else {
                        Err(error)
                    }
                }),
        }
    }

    pub fn provider(&self) -> EditorProviderKind {
        match self {
            Self::OfficialVscode(_) => EditorProviderKind::OfficialVscode,
            Self::OpenVscode(_) => EditorProviderKind::OpenVscode,
        }
    }

    pub fn path(&self) -> &Path {
        match self {
            Self::OfficialVscode(executable) => executable.path(),
            Self::OpenVscode(executable) => executable.path(),
        }
    }

    pub fn is_official(&self) -> bool {
        matches!(self, Self::OfficialVscode(_))
    }

    pub fn official(&self) -> Option<&OfficialVscodeExecutable> {
        match self {
            Self::OfficialVscode(executable) => Some(executable),
            Self::OpenVscode(_) => None,
        }
    }

    /// Provider-owned startup budget. Official VS Code may provision the
    /// matching Server commit on its first launch; OpenVSCode is already
    /// bundled and keeps the short readiness bound.
    pub const fn readiness_timeout(&self) -> Duration {
        match self {
            Self::OfficialVscode(_) => OFFICIAL_VSCODE_PROVISIONING_TIMEOUT,
            Self::OpenVscode(_) => OPENVSCODE_READINESS_TIMEOUT,
        }
    }
}

fn discovery_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os(OFFICIAL_CLI_ENV) {
        candidates.push(PathBuf::from(path));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("code")));
    }
    candidates.extend([
        // The official VS Code shell command is commonly installed here.
        // GUI launches do not reliably inherit the user's shell PATH, so
        // keep this canonical CLI location explicit.
        PathBuf::from("/usr/local/bin/code"),
        PathBuf::from("/opt/homebrew/bin/code"),
        PathBuf::from("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
        PathBuf::from(
            "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
        ),
    ]);
    candidates
}

#[cfg(unix)]
fn is_executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &fs::Metadata) -> bool {
    true
}

fn is_semver(value: &str) -> bool {
    let mut components = value.split('.');
    let Some(major) = components.next() else { return false };
    let Some(minor) = components.next() else { return false };
    let Some(patch) = components.next() else { return false };
    components.next().is_none()
        && [major, minor, patch].into_iter().all(|component| {
            !component.is_empty() && component.chars().all(|ch| ch.is_ascii_digit())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake_cli(root: &Path, good: bool) -> PathBuf {
        let path = root.join("code");
        let help = if good {
            "serve-web --connection-token-file --server-data-dir --disable-telemetry --default-folder"
        } else {
            "serve-web --server-data-dir"
        };
        fs::write(
            &path,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '1.134.0\\n110a328ea54b42367b803ec53ee0bf52ef26b419\\narm64\\n'; else printf '%s\\n' '{help}'; fi\n"
            ),
        )
        .expect("fake cli");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("mode");
        path
    }

    #[test]
    fn official_probe_records_version_commit_arch_and_capabilities() {
        let root =
            std::env::temp_dir().join(format!("devhub-provider-test-{}", std::process::id()));
        fs::create_dir_all(&root).expect("temp");
        let executable = OfficialVscodeExecutable::from_path(fake_cli(&root, true)).expect("probe");
        assert_eq!(executable.version, "1.134.0");
        assert_eq!(executable.commit, "110a328ea54b42367b803ec53ee0bf52ef26b419");
        assert_eq!(executable.architecture, "arm64");
        assert!(executable.capabilities.supported());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn official_probe_fails_closed_when_capability_is_missing() {
        let root =
            std::env::temp_dir().join(format!("devhub-provider-test-bad-{}", std::process::id()));
        fs::create_dir_all(&root).expect("temp");
        let error = OfficialVscodeExecutable::from_path(fake_cli(&root, false))
            .expect_err("missing capability");
        assert_eq!(error.code(), EditorErrorCode::ProviderCapabilityMismatch);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn official_provider_owns_a_longer_first_provisioning_budget() {
        let root =
            std::env::temp_dir().join(format!("devhub-provider-timeout-{}", std::process::id()));
        fs::create_dir_all(&root).expect("temp");
        let executable = OfficialVscodeExecutable::from_path(fake_cli(&root, true)).expect("probe");
        assert_eq!(
            EditorExecutable::OfficialVscode(executable).readiness_timeout(),
            Duration::from_secs(120)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn gui_discovery_includes_macos_homebrew_and_app_bundle_locations() {
        let candidates = discovery_candidates();
        assert!(candidates.contains(&PathBuf::from("/usr/local/bin/code")));
        assert!(candidates.contains(&PathBuf::from("/opt/homebrew/bin/code")));
        assert!(candidates.contains(&PathBuf::from(
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
        )));
    }
}
