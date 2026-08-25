//! Verification and installation seam for the bundled Bridge VSIX.
//!
//! The selected editor executable is not modified. The host installs the exact
//! app-owned VSIX into the app-owned extensions directory before starting the
//! long-lived server. Tests inject a no-op installer so process and WebView
//! lifecycle tests never depend on a bundle being present.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use flate2::read::DeflateDecoder;
use sha2::{Digest, Sha256};

use super::error::{EditorError, EditorErrorCode, EditorResult};
use super::paths::EditorPaths;
use super::provider::EditorExecutable;

const MAX_VSIX_BYTES: u64 = 32 * 1024 * 1024;
const PACKAGE_ENTRY: &str = "extension/package.json";
const MAIN_ENTRY: &str = "extension/extension.js";
const EXPECTED_BRIDGE_ID: &str = "devhub.devhub-bridge";
const EXPECTED_BRIDGE_VERSION: &str = "0.1.0";
const EXPECTED_BRIDGE_MAIN: &str = "./extension.js";
// The reproducible VSIX emitted by extensions/devhub-bridge is the release
// artifact, not an arbitrary file whose name happens to end in `.vsix`.
const EXPECTED_BRIDGE_VSIX_SHA256: &str =
    "8cd65bed3ac2b999d128781dde37541cc46e3968e724094b1ef27ea71aac552c";
const EXPECTED_BRIDGE_MANIFEST_SHA256: &str =
    "1dd072c27b940bc2f7574c48f1fbda09a8ddec9d891431f684015624044662eb";
const MAX_MANIFEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgePackage {
    path: PathBuf,
}

impl BridgePackage {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn resolve(resource_dir: Option<&Path>) -> EditorResult<Self> {
        let resource_dir =
            resource_dir.ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        let candidates = [
            resource_dir.join("devhub-bridge.vsix"),
            resource_dir.join("extensions/devhub-bridge.vsix"),
            resource_dir.join("extensions/devhub-bridge/build/devhub-bridge-0.1.0.vsix"),
            resource_dir.join("devhub-bridge/build/devhub-bridge-0.1.0.vsix"),
        ];
        candidates
            .into_iter()
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))
            .and_then(Self::from_path)
    }

    pub fn from_path(path: PathBuf) -> EditorResult<Self> {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("vsix")
            || metadata.len() == 0
            || metadata.len() > MAX_VSIX_BYTES
        {
            return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
        }
        let bytes =
            fs::read(&path).map_err(|_| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        let digest = Sha256::digest(&bytes);
        let digest = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        if digest != EXPECTED_BRIDGE_VSIX_SHA256 {
            return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
        }
        let entries = zip_entries(&bytes)
            .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        let manifest = entries
            .get(PACKAGE_ENTRY)
            .and_then(|entry| read_zip_entry(&bytes, entry))
            .ok_or_else(|| EditorError::new(EditorErrorCode::BridgeUnavailable))?;
        let manifest_digest = Sha256::digest(&manifest);
        let manifest_digest =
            manifest_digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        if manifest_digest != EXPECTED_BRIDGE_MANIFEST_SHA256
            || !manifest_matches(&manifest)
            || !entries.contains_key(MAIN_ENTRY)
        {
            return Err(EditorError::new(EditorErrorCode::BridgeUnavailable));
        }
        Ok(Self { path })
    }
}

/// Read the bounded ZIP central directory without treating arbitrary payload
/// bytes as archive entries.  VSIX is ZIP-based, and OpenVSCode performs the
/// actual extraction; this parser only establishes that the exact bundled
/// manifest and extension main entries exist before invoking that installer.
#[derive(Debug, Clone)]
struct ZipEntry {
    method: u16,
    compressed_offset: usize,
    compressed_size: usize,
    uncompressed_size: usize,
}

fn zip_entries(bytes: &[u8]) -> Option<std::collections::BTreeMap<String, ZipEntry>> {
    const EOCD_LEN: usize = 22;
    const CENTRAL_HEADER_LEN: usize = 46;
    const EOCD_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
    const CENTRAL_SIGNATURE: &[u8; 4] = b"PK\x01\x02";

    let eocd = bytes.windows(EOCD_SIGNATURE.len()).rposition(|window| window == EOCD_SIGNATURE)?;
    if bytes.len().saturating_sub(eocd) < EOCD_LEN {
        return None;
    }
    let disk = read_u16(bytes, eocd + 4)?;
    let central_disk = read_u16(bytes, eocd + 6)?;
    let entries_on_disk = read_u16(bytes, eocd + 8)?;
    let entries = read_u16(bytes, eocd + 10)?;
    let central_size = usize::try_from(read_u32(bytes, eocd + 12)?).ok()?;
    let central_offset = usize::try_from(read_u32(bytes, eocd + 16)?).ok()?;
    if disk != 0
        || central_disk != 0
        || entries_on_disk != entries
        || entries == u16::MAX
        || central_size == u32::MAX as usize
        || central_offset == u32::MAX as usize
        || central_offset.checked_add(central_size)? > bytes.len()
    {
        return None;
    }

    let mut names = std::collections::BTreeMap::new();
    let mut cursor = central_offset;
    for _ in 0..entries {
        if bytes.get(cursor..cursor + CENTRAL_HEADER_LEN)?[..4] != *CENTRAL_SIGNATURE {
            return None;
        }
        let flags = read_u16(bytes, cursor + 8)?;
        let method = read_u16(bytes, cursor + 10)?;
        let compressed_size = usize::try_from(read_u32(bytes, cursor + 20)?).ok()?;
        let uncompressed_size = usize::try_from(read_u32(bytes, cursor + 24)?).ok()?;
        let name_len = usize::from(read_u16(bytes, cursor + 28)?);
        let extra_len = usize::from(read_u16(bytes, cursor + 30)?);
        let comment_len = usize::from(read_u16(bytes, cursor + 32)?);
        let name_start = cursor.checked_add(CENTRAL_HEADER_LEN)?;
        let name_end = name_start.checked_add(name_len)?;
        let record_end = name_end.checked_add(extra_len)?.checked_add(comment_len)?;
        if record_end > central_offset.checked_add(central_size)? || flags & 1 != 0 {
            return None;
        }
        let name = std::str::from_utf8(bytes.get(name_start..name_end)?).ok()?;
        if name.is_empty()
            || name.starts_with('/')
            || name.contains('\\')
            || name.split('/').any(|component| component == "..")
            || names.contains_key(name)
        {
            return None;
        }
        let local_offset = usize::try_from(read_u32(bytes, cursor + 42)?).ok()?;
        if bytes.get(local_offset..local_offset + 30)?[..4] != *b"PK\x03\x04" {
            return None;
        }
        let local_name_len = usize::from(read_u16(bytes, local_offset + 26)?);
        let local_extra_len = usize::from(read_u16(bytes, local_offset + 28)?);
        let compressed_offset = local_offset
            .checked_add(30)?
            .checked_add(local_name_len)?
            .checked_add(local_extra_len)?;
        let compressed_end = compressed_offset.checked_add(compressed_size)?;
        if compressed_end > bytes.len() {
            return None;
        }
        names.insert(
            name.to_owned(),
            ZipEntry { method, compressed_offset, compressed_size, uncompressed_size },
        );
        cursor = record_end;
    }
    if cursor != central_offset.checked_add(central_size)? {
        return None;
    }
    Some(names)
}

fn read_zip_entry(bytes: &[u8], entry: &ZipEntry) -> Option<Vec<u8>> {
    if entry.uncompressed_size > MAX_MANIFEST_BYTES
        || entry.compressed_offset.checked_add(entry.compressed_size)? > bytes.len()
    {
        return None;
    }
    let compressed =
        &bytes[entry.compressed_offset..entry.compressed_offset + entry.compressed_size];
    let mut output = Vec::with_capacity(entry.uncompressed_size);
    match entry.method {
        0 => output.extend_from_slice(compressed),
        8 => {
            DeflateDecoder::new(Cursor::new(compressed)).read_to_end(&mut output).ok()?;
        }
        _ => return None,
    }
    (output.len() == entry.uncompressed_size).then_some(output)
}

fn manifest_matches(bytes: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return false;
    };
    let Some(object) = value.as_object() else { return false };
    let name = object.get("name").and_then(serde_json::Value::as_str);
    let publisher = object.get("publisher").and_then(serde_json::Value::as_str);
    let version = object.get("version").and_then(serde_json::Value::as_str);
    let main = object.get("main").and_then(serde_json::Value::as_str);
    name == Some("devhub-bridge")
        && publisher == Some("devhub")
        && version == Some(EXPECTED_BRIDGE_VERSION)
        && main == Some(EXPECTED_BRIDGE_MAIN)
        && publisher.zip(name).map(|(publisher, name)| format!("{publisher}.{name}"))
            == Some(EXPECTED_BRIDGE_ID.to_owned())
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(offset..offset + 4)?.try_into().ok()?))
}

pub trait BridgeInstaller: Send + Sync {
    fn install(
        &self,
        package: &BridgePackage,
        executable: &EditorExecutable,
        paths: &EditorPaths,
    ) -> EditorResult<()>;
}

#[cfg(test)]
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopBridgeInstaller;

#[cfg(test)]
impl BridgeInstaller for NoopBridgeInstaller {
    fn install(
        &self,
        _package: &BridgePackage,
        _executable: &EditorExecutable,
        _paths: &EditorPaths,
    ) -> EditorResult<()> {
        Ok(())
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemBridgeInstaller;

impl BridgeInstaller for SystemBridgeInstaller {
    fn install(
        &self,
        package: &BridgePackage,
        executable: &EditorExecutable,
        paths: &EditorPaths,
    ) -> EditorResult<()> {
        let mut command = Command::new(executable.path());
        command
            .arg("--install-extension")
            .arg(package.path())
            .arg("--force")
            .arg("--extensions-dir")
            .arg(paths.extensions());
        if !executable.is_official() {
            command
                .arg("--user-data-dir")
                .arg(paths.user_data())
                .arg("--server-data-dir")
                .arg(paths.server_data());
        }
        if executable.is_official() {
            command.env("VSCODE_CLI_DATA_DIR", paths.cli_data());
        }
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child =
            command.spawn().map_err(|_| EditorError::new(EditorErrorCode::BridgeInstallFailed))?;
        let pid = child.id();
        let mut cleanup = crate::runtime::ChildCleanup::new(pid);
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    cleanup.mark_reaped();
                    break Some(status);
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Ok(None) => {
                    cleanup.terminate(&mut child);
                    break None;
                }
                Err(_) => {
                    cleanup.terminate(&mut child);
                    break None;
                }
            }
        };
        if status.is_some_and(|status| status.success()) {
            Ok(())
        } else {
            Err(EditorError::new(EditorErrorCode::BridgeInstallFailed))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rejects_non_zip_or_missing_required_entries() {
        let path =
            std::env::temp_dir().join(format!("devhub-bridge-test-{}.vsix", std::process::id()));
        let mut file = fs::File::create(&path).expect("file");
        file.write_all(b"not a zip").expect("write");
        drop(file);
        assert!(BridgePackage::from_path(path.clone()).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn accepts_the_reproducible_bridge_package_shape() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../extensions/devhub-bridge/build/devhub-bridge-0.1.0.vsix");
        if path.is_file() {
            let package = BridgePackage::from_path(path).expect("built Bridge VSIX");
            assert!(package.path().ends_with("devhub-bridge-0.1.0.vsix"));
        }
    }
}
