//! Application-owned paths and the pinned OpenVSCode executable identity.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::error::{EditorError, EditorErrorCode, EditorResult};

pub const OPENVSCODE_VERSION: &str = "1.109.5";
pub const OPENVSCODE_TAG: &str = "openvscode-server-v1.109.5";
pub const OPENVSCODE_COMMIT: &str = "4ffe2270acdf711bbefecc3e8c79f4b3631640e5";
pub const LOOPBACK_HOST: &str = "127.0.0.1";
pub const WEBKIT_DATA_STORE_ID: [u8; 16] = *b"DEVHUB-WB-STORE1";

const OPENVSCODE_ROOT: &str = "OpenVSCode";

/// Every path used by the provider is owned by DevHub.  The token and port
/// files are deliberately siblings of the provider data so a future runtime
/// migration can move the complete OpenVSCode profile as one unit.
#[derive(Clone)]
pub struct EditorPaths {
    root: PathBuf,
    server_data: PathBuf,
    user_data: PathBuf,
    extensions: PathBuf,
    logs: PathBuf,
    webkit_data: PathBuf,
    token: PathBuf,
    port: PathBuf,
}

impl EditorPaths {
    pub fn for_home(home: impl AsRef<Path>) -> Self {
        let root = home.as_ref().join("Library/Application Support/DevHub").join(OPENVSCODE_ROOT);
        Self {
            server_data: root.join("server-data"),
            user_data: root.join("user-data"),
            extensions: root.join("extensions"),
            logs: home.as_ref().join("Library/Logs/DevHub"),
            webkit_data: root.join("webkit-data"),
            token: root.join("connection-token"),
            port: root.join("port"),
            root,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn server_data(&self) -> &Path {
        &self.server_data
    }

    pub fn user_data(&self) -> &Path {
        &self.user_data
    }

    pub fn extensions(&self) -> &Path {
        &self.extensions
    }

    pub fn logs(&self) -> &Path {
        &self.logs
    }

    pub fn webkit_data(&self) -> &Path {
        &self.webkit_data
    }

    pub fn token_file(&self) -> &Path {
        &self.token
    }

    pub fn port_file(&self) -> &Path {
        &self.port
    }

    /// Create and harden all provider directories. Existing directories are
    /// retained, but a symlink or non-directory is rejected rather than
    /// followed into user-controlled storage.
    pub fn ensure_directories(&self) -> EditorResult<()> {
        let app_data = self
            .root
            .parent()
            .ok_or_else(|| EditorError::new(EditorErrorCode::PermissionDenied))?;
        for path in [
            app_data,
            &self.root,
            &self.server_data,
            &self.user_data,
            &self.extensions,
            &self.logs,
            &self.webkit_data,
        ] {
            ensure_directory(path)?;
        }
        Ok(())
    }

    /// Remove only the ephemeral authentication material after a verified
    /// shutdown. Durable provider data and the stable port are never removed.
    pub fn remove_ephemeral_token(&self) -> EditorResult<()> {
        match fs::symlink_metadata(&self.token) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                Err(EditorError::new(EditorErrorCode::PermissionDenied))
            }
            Ok(_) => {
                harden_file(&self.token)?;
                fs::remove_file(&self.token).map_err(EditorError::from)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

fn ensure_directory(path: &Path) -> EditorResult<()> {
    if !path.is_absolute() {
        return Err(EditorError::new(EditorErrorCode::PermissionDenied));
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(EditorError::new(EditorErrorCode::PermissionDenied));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(EditorError::from)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    harden_directory(path)
}

fn harden_file(path: &Path) -> EditorResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(EditorError::from)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(EditorError::new(EditorErrorCode::PermissionDenied));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != nix::unistd::geteuid().as_raw() {
            return Err(EditorError::new(EditorErrorCode::PermissionDenied));
        }
        if metadata.permissions().mode() & 0o777 != 0o600 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(EditorError::from)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn harden_directory(path: &Path) -> EditorResult<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = fs::metadata(path).map_err(EditorError::from)?;
    if metadata.uid() != nix::unistd::geteuid().as_raw() {
        return Err(EditorError::new(EditorErrorCode::PermissionDenied));
    }
    let mut permissions = metadata.permissions();
    if permissions.mode() & 0o077 != 0 {
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).map_err(EditorError::from)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_directory(_path: &Path) -> EditorResult<()> {
    Ok(())
}

/// Identity carried by the host so an executable cannot be silently swapped
/// for a different OpenVSCode build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedExecutable {
    path: PathBuf,
    pub version: &'static str,
    pub tag: &'static str,
    pub commit: &'static str,
    development_override: bool,
}

impl PinnedExecutable {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn resolve(resource_dir: Option<&Path>) -> EditorResult<Self> {
        #[cfg(debug_assertions)]
        if let Some(path) = std::env::var_os("DEVHUB_OPENVSCODE_EXECUTABLE") {
            return Self::from_path(PathBuf::from(path), true);
        }

        let resource_dir =
            resource_dir.ok_or_else(|| EditorError::new(EditorErrorCode::ExecutableUnavailable))?;
        let resource_dir = fs::canonicalize(resource_dir)
            .map_err(|_| EditorError::new(EditorErrorCode::ExecutableUnavailable))?;
        let candidates = [
            resource_dir.join("openvscode-server/bin/openvscode-server"),
            resource_dir.join("openvscode/vscode-reh-web-darwin-arm64/bin/openvscode-server"),
            resource_dir.join("vscode-reh-web-darwin-arm64/bin/openvscode-server"),
        ];
        candidates
            .into_iter()
            .find_map(|path| {
                let metadata = fs::symlink_metadata(&path).ok()?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return None;
                }
                let canonical = fs::canonicalize(&path).ok()?;
                canonical.starts_with(&resource_dir).then_some(canonical)
            })
            .ok_or_else(|| EditorError::new(EditorErrorCode::ExecutableUnavailable))
            .and_then(|path| Self::from_path(path, false))
    }

    pub fn from_path(path: PathBuf, development_override: bool) -> EditorResult<Self> {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| EditorError::new(EditorErrorCode::ExecutableUnavailable))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(EditorError::new(EditorErrorCode::ExecutableIdentityMismatch));
        }
        if path.file_name().and_then(|name| name.to_str()) != Some("openvscode-server") {
            return Err(EditorError::new(EditorErrorCode::ExecutableIdentityMismatch));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(EditorError::new(EditorErrorCode::ExecutableUnavailable));
            }
        }
        let canonical_path = fs::canonicalize(&path)
            .map_err(|_| EditorError::new(EditorErrorCode::ExecutableIdentityMismatch))?;
        let executable = Self {
            path: canonical_path,
            version: OPENVSCODE_VERSION,
            tag: OPENVSCODE_TAG,
            commit: OPENVSCODE_COMMIT,
            development_override,
        };
        executable.verify_product_metadata()?;
        Ok(executable)
    }

    fn verify_product_metadata(&self) -> EditorResult<()> {
        let root = self
            .path
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| EditorError::new(EditorErrorCode::ExecutableIdentityMismatch))?;
        for runtime_file in [root.join("node"), root.join("out/server-main.js")] {
            let metadata = fs::symlink_metadata(&runtime_file)
                .map_err(|_| EditorError::new(EditorErrorCode::ExecutableIdentityMismatch))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(EditorError::new(EditorErrorCode::ExecutableIdentityMismatch));
            }
        }
        let product = root.join("product.json");
        let product_metadata = fs::symlink_metadata(&product)
            .map_err(|_| EditorError::new(EditorErrorCode::ExecutableIdentityMismatch))?;
        if product_metadata.file_type().is_symlink()
            || !product_metadata.is_file()
            || product_metadata.len() > 64 * 1024
        {
            return Err(EditorError::new(EditorErrorCode::ExecutableIdentityMismatch));
        }
        let bytes = fs::read(product)
            .map_err(|_| EditorError::new(EditorErrorCode::ExecutableIdentityMismatch))?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| EditorError::new(EditorErrorCode::ExecutableIdentityMismatch))?;
        let commit = value.get("commit").and_then(serde_json::Value::as_str);
        let version = value.get("version").and_then(serde_json::Value::as_str);
        if commit != Some(self.commit) || version != Some(self.version) {
            return Err(EditorError::new(EditorErrorCode::ExecutableIdentityMismatch));
        }
        Ok(())
    }
}

/// Closed lifecycle vocabulary accepted by the app-owned log. Paths, URLs,
/// tokens, command lines, and provider output have no representation here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleEvent {
    RuntimePrepared,
    ServerStarted { pid: u32 },
    ServerReady,
    ServerRestarted { attempt: u8 },
    ServerStopped,
    WebViewsCreated { count: u16 },
    WebViewsDestroyed { count: u16 },
    WorkspaceClosed,
}

impl LifecycleEvent {
    fn line(self) -> String {
        match self {
            Self::RuntimePrepared => "event=runtime_prepared".to_owned(),
            Self::ServerStarted { pid } => format!("event=server_started pid={pid}"),
            Self::ServerReady => "event=server_ready".to_owned(),
            Self::ServerRestarted { attempt } => {
                format!("event=server_restarted attempt={attempt}")
            }
            Self::ServerStopped => "event=server_stopped".to_owned(),
            Self::WebViewsCreated { count } => format!("event=webviews_created count={count}"),
            Self::WebViewsDestroyed { count } => format!("event=webviews_destroyed count={count}"),
            Self::WorkspaceClosed => "event=workspace_closed".to_owned(),
        }
    }
}

pub fn append_lifecycle_log(paths: &EditorPaths, event: LifecycleEvent) -> EditorResult<()> {
    paths.ensure_directories()?;
    let path = paths.logs().join("editor-host.log");
    match fs::symlink_metadata(&path) {
        Ok(_) => harden_file(&path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use nix::fcntl::OFlag;
        use std::os::unix::fs::OpenOptionsExt;
        options.create(true).append(true).mode(0o600);
        options.custom_flags(OFlag::O_NOFOLLOW.bits());
    }
    let mut file = options.open(path.clone()).map_err(EditorError::from)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(EditorError::from)?;
    }
    writeln!(file, "{}", event.line()).map_err(EditorError::from)
}
