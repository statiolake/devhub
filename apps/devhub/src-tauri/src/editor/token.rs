//! Ephemeral owner-only OpenVSCode connection tokens.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use super::error::{EditorError, EditorErrorCode, EditorResult};

pub const TOKEN_BYTES: usize = 32;

/// The token is intentionally not printable.  It is only borrowed by the
/// process launcher and URL builder while the server is alive.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretToken([u8; TOKEN_BYTES]);

impl fmt::Debug for SecretToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted-token>")
    }
}

impl SecretToken {
    #[cfg(test)]
    pub(super) const fn from_bytes_for_test(bytes: [u8; TOKEN_BYTES]) -> Self {
        Self(bytes)
    }

    pub fn issue(path: impl AsRef<Path>) -> EditorResult<Self> {
        let path = path.as_ref();
        let parent =
            path.parent().ok_or_else(|| EditorError::new(EditorErrorCode::TokenUnavailable))?;
        secure_parent(path)?;
        fs::create_dir_all(parent).map_err(EditorError::from)?;
        secure_parent(path)?;
        reject_symlink(path)?;

        let bytes = random_bytes()?;

        // Rename is atomic and replaces a stale token without ever exposing a
        // partially written value to the child process.
        let temporary = temporary_path(path)?;
        reject_symlink(&temporary)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|error| {
            EditorError::new(if error.kind() == std::io::ErrorKind::PermissionDenied {
                EditorErrorCode::PermissionDenied
            } else {
                EditorErrorCode::TokenUnavailable
            })
        })?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&temporary);
            return Err(EditorError::new(
                if error.kind() == std::io::ErrorKind::PermissionDenied {
                    EditorErrorCode::PermissionDenied
                } else {
                    EditorErrorCode::TokenUnavailable
                },
            ));
        }
        drop(file);
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::remove_file(&temporary);
            return Err(EditorError::new(
                if error.kind() == std::io::ErrorKind::PermissionDenied {
                    EditorErrorCode::PermissionDenied
                } else {
                    EditorErrorCode::TokenUnavailable
                },
            ));
        }
        harden_file(path)?;
        Ok(Self(bytes))
    }

    /// Issues a bearer secret for an in-memory trust boundary. Unlike the
    /// OpenVSCode connection token, this value is never written to disk.
    pub(crate) fn issue_ephemeral() -> EditorResult<Self> {
        Ok(Self(random_bytes()?))
    }

    #[cfg(test)]
    pub fn from_file(path: impl AsRef<Path>) -> EditorResult<Self> {
        let path = path.as_ref();
        reject_symlink(path)?;
        harden_file(path)?;
        let mut bytes = [0_u8; TOKEN_BYTES];
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits());
        }
        let mut file =
            options.open(path).map_err(|_| EditorError::new(EditorErrorCode::TokenUnavailable))?;
        file.read_exact(&mut bytes)
            .map_err(|_| EditorError::new(EditorErrorCode::TokenUnavailable))?;
        let mut extra = [0_u8; 1];
        if file.read(&mut extra).map_err(|_| EditorError::new(EditorErrorCode::TokenUnavailable))?
            != 0
        {
            return Err(EditorError::new(EditorErrorCode::TokenUnavailable));
        }
        Ok(Self(bytes))
    }

    pub(crate) fn hex(&self) -> String {
        let mut output = String::with_capacity(TOKEN_BYTES * 2);
        for byte in self.0 {
            output.push_str(&format!("{byte:02x}"));
        }
        output
    }
}

fn random_bytes() -> EditorResult<[u8; TOKEN_BYTES]> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut bytes))
        .map_err(|_| EditorError::new(EditorErrorCode::TokenUnavailable))?;
    Ok(bytes)
}

fn temporary_path(path: &Path) -> EditorResult<PathBuf> {
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("token");
    let mut nonce = [0_u8; 8];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut nonce))
        .map_err(|_| EditorError::new(EditorErrorCode::TokenUnavailable))?;
    Ok(path.with_file_name(format!(".{name}.{}.tmp", hex_nonce(nonce))))
}

fn hex_nonce(bytes: [u8; 8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn reject_symlink(path: &Path) -> EditorResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(EditorError::new(EditorErrorCode::PermissionDenied))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(EditorError::new(EditorErrorCode::TokenUnavailable)),
    }
}

fn harden_file(path: &Path) -> EditorResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| EditorError::new(EditorErrorCode::TokenUnavailable))?;
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

fn secure_parent(path: &Path) -> EditorResult<()> {
    let Some(parent) = path.parent() else {
        return Err(EditorError::new(EditorErrorCode::TokenUnavailable));
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

    fn temp_path() -> PathBuf {
        let root = fs::canonicalize(std::env::temp_dir()).expect("canonical temp directory").join(
            format!(
                "devhub-editor-token-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
        );
        fs::create_dir_all(&root).expect("temp root");
        root.join("connection-token")
    }

    #[test]
    fn issue_is_random_and_owner_only() {
        let first_path = temp_path();
        let second_path = temp_path();
        let first = SecretToken::issue(&first_path).expect("first token");
        let second = SecretToken::issue(&second_path).expect("second token");
        assert_ne!(first, second);
        assert_eq!(fs::metadata(&first_path).expect("metadata").len(), 32);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(first_path).expect("metadata").permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn debug_and_log_safe_views_never_include_secret() {
        let path = temp_path();
        let token = SecretToken::issue(&path).expect("token");
        let debug = format!("{token:?}");
        assert!(!debug.contains(&token.hex()));
        assert!(debug.contains("redacted"));
    }
}
