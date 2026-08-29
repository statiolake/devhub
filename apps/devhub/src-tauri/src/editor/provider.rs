//! The VS Code Server the Editor runs against.
//!
//! DevHub ships its own rather than driving the user's installed VS Code. The
//! bundled build is VSCodium — Microsoft's `vscode` sources built without the
//! proprietary product configuration, so it is MIT, carries no telemetry, and
//! resolves extensions against Open VSX. `scripts/provision-editor-server.sh`
//! stages it; nothing here downloads anything.
//!
//! The version matters more than it looks. The Workbench is supplied by
//! monaco-vscode-api and generated from one VS Code release; the server has to
//! be that release, because the protocol between them is only promised to
//! match within one. The commit recorded in `product.json` is the identity the
//! client checks, and the provisioning script restates it for exactly that
//! reason.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::error::{EditorError, EditorErrorCode, EditorResult};

/// Where the staged server sits under the app's resource directory.
const BUNDLED_SERVER_DIRECTORY: &str = "editor-server";
const SERVER_BINARY: &str = "bin/codium-server";
/// Unpacking extensions and starting an extension host on a cold machine is
/// slower than the steady state by a wide margin, and this is the whole budget
/// before a start is called failed.
const SERVER_STARTUP_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledServerExecutable {
    path: PathBuf,
    /// The VS Code release this server was built from, as its own product
    /// configuration records it.
    pub version: String,
    /// The identity the Workbench checks against its own. Not a build stamp:
    /// a mismatch here is a protocol mismatch, and the connection is refused.
    pub commit: String,
}

pub type EditorExecutable = BundledServerExecutable;

impl BundledServerExecutable {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub const fn readiness_timeout(&self) -> Duration {
        SERVER_STARTUP_TIMEOUT
    }

    /// Locate the staged server. `explicit` overrides the resource directory,
    /// which is how tests point at a fixture.
    pub fn resolve(explicit: Option<&Path>, resource_dir: Option<&Path>) -> EditorResult<Self> {
        let binary = match explicit {
            Some(path) => path.to_path_buf(),
            None => resource_dir
                .ok_or_else(|| EditorError::new(EditorErrorCode::OfficialVscodeUnavailable))?
                .join(BUNDLED_SERVER_DIRECTORY)
                .join(SERVER_BINARY),
        };
        Self::from_path(binary)
    }

    pub fn from_path(path: PathBuf) -> EditorResult<Self> {
        let metadata = fs::metadata(&path)
            .map_err(|_| EditorError::new(EditorErrorCode::OfficialVscodeUnavailable))?;
        if !metadata.is_file() || !is_executable(&metadata) {
            return Err(EditorError::new(EditorErrorCode::OfficialVscodeUnavailable));
        }
        let path = fs::canonicalize(path)
            .map_err(|_| EditorError::new(EditorErrorCode::OfficialVscodeUnavailable))?;
        // The identity is read from the staged tree, not from running the
        // binary: `--version` on a server costs a process start, and the
        // answer is already on disk beside it.
        let root = path
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| EditorError::new(EditorErrorCode::OfficialVscodeUnavailable))?;
        let product = fs::read_to_string(root.join("product.json"))
            .map_err(|_| EditorError::new(EditorErrorCode::ProviderCapabilityMismatch))?;
        let product: serde_json::Value = serde_json::from_str(&product)
            .map_err(|_| EditorError::new(EditorErrorCode::ProviderCapabilityMismatch))?;
        let version = product["version"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 32)
            .ok_or_else(|| EditorError::new(EditorErrorCode::ProviderCapabilityMismatch))?
            .to_owned();
        let commit = product["commit"]
            .as_str()
            .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| EditorError::new(EditorErrorCode::ProviderCapabilityMismatch))?
            .to_owned();
        Ok(Self { path, version, commit })
    }
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A staged server that is only a shape: an executable and the product
    /// configuration beside it.
    pub(crate) fn fake_server(root: &Path, commit: &str) -> PathBuf {
        let server = root.join(BUNDLED_SERVER_DIRECTORY);
        let binary = server.join(SERVER_BINARY);
        fs::create_dir_all(binary.parent().expect("bin")).expect("server directories");
        fs::write(&binary, "#!/bin/sh\nexit 0\n").expect("server binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))
                .expect("executable bit");
        }
        fs::write(
            server.join("product.json"),
            format!("{{\"version\":\"1.121.03429\",\"commit\":\"{commit}\"}}"),
        )
        .expect("product.json");
        binary
    }

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "devhub-provider-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("test root");
        root
    }

    #[test]
    fn the_staged_server_is_identified_by_the_product_beside_it() {
        let root = test_root("staged");
        let commit = "987c9597516278c9fcf10d963a0592ce1384ab93";
        fake_server(&root, commit);
        let executable = BundledServerExecutable::resolve(None, Some(&root)).expect("resolve");
        assert_eq!(executable.commit, commit);
        assert_eq!(executable.version, "1.121.03429");
        assert!(executable.path().ends_with("bin/codium-server"));
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn a_server_without_a_usable_commit_is_refused() {
        // The commit is what the Workbench checks before it will talk to the
        // server at all, so a staged tree that cannot state one is not a
        // provider — it is a failure waiting to happen at connection time.
        let root = test_root("no-commit");
        fake_server(&root, "987c9597516278c9fcf10d963a0592ce1384ab93");
        fs::write(
            root.join(BUNDLED_SERVER_DIRECTORY).join("product.json"),
            "{\"version\":\"1.121.03429\",\"commit\":\"not-a-commit\"}",
        )
        .expect("product.json");
        assert_eq!(
            BundledServerExecutable::resolve(None, Some(&root)).expect_err("refused").code(),
            EditorErrorCode::ProviderCapabilityMismatch
        );
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn a_missing_staged_server_is_reported_rather_than_searched_for() {
        // There is nowhere else to look. The server is shipped with the app,
        // and its absence is a broken install, not a machine without VS Code.
        let root = test_root("missing");
        assert_eq!(
            BundledServerExecutable::resolve(None, Some(&root)).expect_err("missing").code(),
            EditorErrorCode::OfficialVscodeUnavailable
        );
        assert_eq!(
            BundledServerExecutable::resolve(None, None).expect_err("no resources").code(),
            EditorErrorCode::OfficialVscodeUnavailable
        );
        fs::remove_dir_all(&root).expect("cleanup");
    }
}
