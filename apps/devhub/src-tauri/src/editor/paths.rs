//! Application-owned paths and provider identity.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::error::{EditorError, EditorErrorCode, EditorResult};

pub const LOOPBACK_HOST: &str = "127.0.0.1";

/// Every path used by the provider is owned by DevHub. The token and port
/// files are deliberately siblings of the provider data so a future runtime
/// migration can move a complete provider profile as one unit.
#[derive(Clone)]
pub struct EditorPaths {
    root: PathBuf,
    server_data: PathBuf,
    cli_data: PathBuf,
    extensions: PathBuf,
    logs: PathBuf,
    token: PathBuf,
    server_pid: PathBuf,
}

impl EditorPaths {
    pub fn new(home: impl AsRef<Path>) -> Self {
        let root =
            home.as_ref().join("Library/Application Support/DevHub").join("VisualStudioCode");
        Self {
            // `code serve-web` loads workspace extensions from this official
            // server-data-owned directory. It is still DevHub-owned and does
            // not reuse the user's consumer VS Code profile.
            extensions: root.join("server-data/extensions"),
            server_data: root.join("server-data"),
            cli_data: root.join("cli-data"),
            logs: home.as_ref().join("Library/Logs/DevHub"),
            token: root.join("connection-token"),
            server_pid: root.join("server-pid"),
            root,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn server_data(&self) -> &Path {
        &self.server_data
    }

    pub fn cli_data(&self) -> &Path {
        &self.cli_data
    }

    pub fn extensions(&self) -> &Path {
        &self.extensions
    }

    pub fn logs(&self) -> &Path {
        &self.logs
    }

    pub fn token_file(&self) -> &Path {
        &self.token
    }

    /// Where the running server's process group is recorded.
    ///
    /// A run that is killed outright leaves its server listening on the stable
    /// origin, and the next launch has no `Child` handle to stop it with. This
    /// is what lets that launch recognise its own leftovers instead of
    /// reporting the origin as taken by a stranger.
    pub fn server_pid_file(&self) -> &Path {
        &self.server_pid
    }

    /// Create and harden all provider directories. Existing directories are
    /// retained, but a symlink or non-directory is rejected rather than
    /// followed into user-controlled storage.
    pub fn ensure_directories(&self) -> EditorResult<()> {
        let app_data = self
            .root
            .parent()
            .ok_or_else(|| EditorError::new(EditorErrorCode::PermissionDenied))?;
        for path in
            [app_data, &self.root, &self.server_data, &self.cli_data, &self.extensions, &self.logs]
        {
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

/// What the previous run left behind: which process group its server ran in,
/// and which origin that server was holding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerPidRecord {
    pub pid: u32,
    pub port: u16,
}

/// Record the running server so a later launch can recognise it as its own.
///
/// Written best-effort: a run whose record never lands still works, it just
/// cannot reclaim its own origin if it is killed outright.
pub fn record_server_pid(paths: &EditorPaths, pid: u32, port: u16) {
    let path = paths.server_pid_file();
    if reject_symlink(path).is_err() {
        return;
    }
    let _ = fs::remove_file(path);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(path) {
        let _ = writeln!(file, "pid={pid} port={port}");
    }
}

pub fn read_server_pid(paths: &EditorPaths) -> Option<ServerPidRecord> {
    let path = paths.server_pid_file();
    reject_symlink(path).ok()?;
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 64 {
        return None;
    }
    let value = fs::read_to_string(path).ok()?;
    let mut pid = None;
    let mut port = None;
    for field in value.split_whitespace() {
        match field.split_once('=') {
            Some(("pid", raw)) => pid = raw.parse::<u32>().ok(),
            Some(("port", raw)) => port = raw.parse::<u16>().ok(),
            _ => return None,
        }
    }
    Some(ServerPidRecord { pid: pid?, port: port? })
}

pub fn clear_server_pid(paths: &EditorPaths) {
    let path = paths.server_pid_file();
    if reject_symlink(path).is_ok() {
        let _ = fs::remove_file(path);
    }
}

fn reject_symlink(path: &Path) -> EditorResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(EditorError::new(EditorErrorCode::PermissionDenied))
        }
        _ => Ok(()),
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

/// Closed lifecycle vocabulary accepted by the app-owned log. Paths, URLs,
/// tokens, command lines, and provider output have no representation here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleEvent {
    RuntimePrepared,
    ServerStarted { pid: u32 },
    ServerReady,
    ServerRestarted { attempt: u8 },
    ServerStopped,
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
