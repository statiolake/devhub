//! Stable loopback port selection and conflict handling.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use super::error::{EditorError, EditorErrorCode, EditorResult};

pub const MIN_EDITOR_PORT: u16 = 1024;

pub trait PortAllocator: Send + Sync {
    fn choose(&self) -> EditorResult<u16>;
    fn is_available(&self, port: u16) -> bool;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemPortAllocator;

impl PortAllocator for SystemPortAllocator {
    fn choose(&self) -> EditorResult<u16> {
        TcpListener::bind((super::paths::LOOPBACK_HOST, 0))
            .and_then(|listener| listener.local_addr())
            .map(|address| address.port())
            .map_err(EditorError::from)
    }

    fn is_available(&self, port: u16) -> bool {
        TcpListener::bind((super::paths::LOOPBACK_HOST, port)).is_ok()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StablePort {
    port: u16,
    persisted: bool,
}

impl StablePort {
    pub fn load_or_select(
        path: impl AsRef<Path>,
        allocator: &dyn PortAllocator,
    ) -> EditorResult<Self> {
        let path = path.as_ref();
        reject_symlink(path)?;
        match fs::symlink_metadata(path) {
            Ok(_) => {
                harden_file(path)?;
                let value = fs::read_to_string(path)
                    .map_err(|_| EditorError::new(EditorErrorCode::InvalidPort))?;
                let port = parse_port(&value)?;
                Ok(Self { port, persisted: true })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let port = allocator.choose()?;
                validate_port(port)?;
                write_port(path, port)?;
                Ok(Self { port, persisted: false })
            }
            Err(_) => Err(EditorError::new(EditorErrorCode::InvalidPort)),
        }
    }

    pub const fn port(self) -> u16 {
        self.port
    }

    #[cfg(test)]
    pub const fn persisted(self) -> bool {
        self.persisted
    }

    /// A persisted port is an origin identity. Occupancy is a visible
    /// conflict, never a reason to select a replacement port.
    pub fn ensure_available(self, allocator: &dyn PortAllocator) -> EditorResult<()> {
        if allocator.is_available(self.port) {
            Ok(())
        } else {
            Err(EditorError::new(EditorErrorCode::PortConflict))
        }
    }
}

fn parse_port(value: &str) -> EditorResult<u16> {
    let value = value.strip_suffix('\n').unwrap_or(value);
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(EditorError::new(EditorErrorCode::InvalidPort));
    }
    let port = value.parse::<u16>().map_err(|_| EditorError::new(EditorErrorCode::InvalidPort))?;
    validate_port(port)?;
    Ok(port)
}

fn validate_port(port: u16) -> EditorResult<()> {
    if port < MIN_EDITOR_PORT {
        return Err(EditorError::new(EditorErrorCode::InvalidPort));
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> EditorResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(EditorError::new(EditorErrorCode::PermissionDenied))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(EditorError::new(EditorErrorCode::InvalidPort)),
    }
}

fn write_port(path: &Path, port: u16) -> EditorResult<()> {
    let parent = path.parent().ok_or_else(|| EditorError::new(EditorErrorCode::InvalidPort))?;
    secure_parent(path)?;
    fs::create_dir_all(parent).map_err(EditorError::from)?;
    secure_parent(path)?;
    let temporary = temporary_path(path)?;
    reject_symlink(&temporary)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(EditorError::from)?;
    if let Err(error) = writeln!(file, "{port}").and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    drop(file);
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    harden_file(path)
}

fn temporary_path(path: &Path) -> EditorResult<PathBuf> {
    let mut nonce = [0_u8; 8];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut nonce))
        .map_err(|_| EditorError::new(EditorErrorCode::InvalidPort))?;
    let suffix = nonce.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    Ok(PathBuf::from(format!("{}.{}.tmp", path.display(), suffix)))
}

fn harden_file(path: &Path) -> EditorResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(EditorError::from)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(EditorError::new(EditorErrorCode::PermissionDenied));
    }
    if metadata.len() > 16 {
        return Err(EditorError::new(EditorErrorCode::InvalidPort));
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

fn secure_parent(path: &Path) -> EditorResult<()> {
    let Some(parent) = path.parent() else {
        return Err(EditorError::new(EditorErrorCode::InvalidPort));
    };
    let mut current = PathBuf::new();
    for component in parent.components() {
        current.push(component.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() {
                return Err(EditorError::new(EditorErrorCode::PermissionDenied));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct FakeAllocator {
        selected: u16,
        available: bool,
    }

    impl PortAllocator for FakeAllocator {
        fn choose(&self) -> EditorResult<u16> {
            Ok(self.selected)
        }

        fn is_available(&self, _port: u16) -> bool {
            self.available
        }
    }

    fn temp_path() -> PathBuf {
        let root = fs::canonicalize(std::env::temp_dir()).expect("canonical temp directory").join(
            format!(
                "devhub-editor-port-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
        );
        fs::create_dir_all(&root).expect("temp root");
        root.join("port")
    }

    #[test]
    fn first_selection_is_persisted_and_relaunch_keeps_origin_port() {
        let path = temp_path();
        let allocator = FakeAllocator { selected: 54945, available: true };
        let first = StablePort::load_or_select(&path, &allocator).expect("first port");
        assert_eq!(first.port(), 54945);
        assert!(!first.persisted());
        let relaunch =
            StablePort::load_or_select(&path, &FakeAllocator { selected: 54946, available: true })
                .expect("relaunch port");
        assert_eq!(relaunch.port(), 54945);
        assert!(relaunch.persisted());
    }

    #[test]
    fn occupied_stable_port_is_visible_conflict_without_reselection() {
        let path = temp_path();
        let port =
            StablePort::load_or_select(&path, &FakeAllocator { selected: 54945, available: true })
                .expect("port");
        let error = port
            .ensure_available(&FakeAllocator { selected: 54946, available: false })
            .expect_err("occupied port");
        assert_eq!(error.code(), EditorErrorCode::PortConflict);
        assert_eq!(fs::read_to_string(path).expect("stable file").trim(), "54945");
    }
}
