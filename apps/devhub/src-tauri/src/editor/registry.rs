//! Rust-owned mapping from canonical Workspace roots to stable editor IDs.
//!
//! The Bridge extension runs once per Workbench context, while one OpenVSCode
//! process serves every child WebView. This registry is the narrow native
//! lookup seam that lets a Bridge hello resolve the exact Workspace identity
//! without putting provider IDs or content into the core snapshot.

use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use devhub_app_core::bridge::Uuid;
use serde::{Deserialize, Serialize};

use super::error::{EditorError, EditorErrorCode, EditorResult};

const REGISTRY_VERSION: u8 = 1;
const MAX_REGISTRY_BYTES: u64 = 64 * 1024;
const MAX_REGISTRY_ENTRIES: usize = 128;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRegistryEntry {
    pub workspace_id: Option<String>,
    pub canonical_root: Option<String>,
    pub surface_id: String,
}

impl fmt::Debug for SurfaceRegistryEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SurfaceRegistryEntry")
            .field("workspace_id", &self.workspace_id)
            .field("canonical_root", &"<redacted>")
            .field("surface_id", &self.surface_id)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryDocument {
    version: u8,
    surfaces: Vec<SurfaceRegistryEntry>,
}

/// The registry owns its file and serializes every update through a temp-file
/// plus rename. No token or URL query is ever persisted here.
#[derive(Clone)]
pub struct SurfaceRegistry {
    path: PathBuf,
    document: RegistryDocument,
}

impl SurfaceRegistry {
    pub fn open(path: impl Into<PathBuf>) -> EditorResult<Self> {
        let path = path.into();
        reject_symlink(&path)?;
        secure_parent(&path)?;
        let (document, needs_initial_commit) = match fs::symlink_metadata(&path) {
            Ok(_) => {
                harden_file(&path)?;
                let bytes = fs::read(&path).map_err(|_| EditorError::new(EditorErrorCode::Io))?;
                if bytes.len() as u64 > MAX_REGISTRY_BYTES {
                    return Err(EditorError::new(EditorErrorCode::Io));
                }
                let document: RegistryDocument = serde_json::from_slice(&bytes)
                    .map_err(|_| EditorError::new(EditorErrorCode::Io))?;
                validate_document(&document)?;
                (document, false)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (RegistryDocument { version: REGISTRY_VERSION, surfaces: Vec::new() }, true)
            }
            Err(_) => return Err(EditorError::new(EditorErrorCode::Io)),
        };
        let registry = Self { path, document };
        if needs_initial_commit {
            registry.commit()?;
        }
        Ok(registry)
    }

    pub fn global(&mut self) -> EditorResult<SurfaceRegistryEntry> {
        if let Some(entry) = self
            .document
            .surfaces
            .iter()
            .find(|entry| entry.workspace_id.is_none() && entry.canonical_root.is_none())
        {
            return Ok(entry.clone());
        }
        let entry = SurfaceRegistryEntry {
            workspace_id: None,
            canonical_root: None,
            surface_id: new_uuid()?,
        };
        self.document.surfaces.push(entry.clone());
        if let Err(error) = self.commit() {
            self.document.surfaces.pop();
            return Err(error);
        }
        Ok(entry)
    }

    pub fn workspace(
        &mut self,
        workspace_id: impl Into<String>,
        root: impl AsRef<Path>,
    ) -> EditorResult<SurfaceRegistryEntry> {
        let workspace_id = workspace_id.into();
        validate_uuid(&workspace_id)?;
        let root = fs::canonicalize(root.as_ref())
            .map_err(|_| EditorError::new(EditorErrorCode::InvalidWorkspaceRoot))?;
        if !fs::metadata(&root).is_ok_and(|metadata| metadata.is_dir()) {
            return Err(EditorError::new(EditorErrorCode::InvalidWorkspaceRoot));
        }
        let root = root
            .to_str()
            .ok_or_else(|| EditorError::new(EditorErrorCode::InvalidWorkspaceRoot))?
            .to_owned();

        if let Some(entry) = self
            .document
            .surfaces
            .iter()
            .find(|entry| entry.workspace_id.as_deref() == Some(&workspace_id))
        {
            if entry.canonical_root.as_deref() != Some(&root) {
                return Err(EditorError::new(EditorErrorCode::LifecycleConflict));
            }
            return Ok(entry.clone());
        }
        if self.document.surfaces.iter().any(|entry| entry.canonical_root.as_deref() == Some(&root))
        {
            return Err(EditorError::new(EditorErrorCode::LifecycleConflict));
        }
        let entry = SurfaceRegistryEntry {
            workspace_id: Some(workspace_id),
            canonical_root: Some(root.clone()),
            surface_id: new_uuid()?,
        };
        self.document.surfaces.push(entry.clone());
        if let Err(error) = self.commit() {
            self.document.surfaces.pop();
            return Err(error);
        }
        Ok(entry)
    }

    pub fn remove_workspace(&mut self, workspace_id: &str) -> EditorResult<bool> {
        let Some(index) = self
            .document
            .surfaces
            .iter()
            .position(|entry| entry.workspace_id.as_deref() == Some(workspace_id))
        else {
            return Ok(false);
        };
        let entry = self.document.surfaces.remove(index);
        if let Err(error) = self.commit() {
            self.document.surfaces.insert(index, entry);
            return Err(error);
        }
        Ok(true)
    }

    pub(crate) fn core_surface_ids(&self) -> EditorResult<Vec<Uuid>> {
        self.document
            .surfaces
            .iter()
            .map(|entry| {
                Uuid::parse(entry.surface_id.clone())
                    .map_err(|_| EditorError::new(EditorErrorCode::InvalidSurface))
            })
            .collect()
    }

    #[cfg(test)]
    pub fn entries(&self) -> impl Iterator<Item = &SurfaceRegistryEntry> {
        self.document.surfaces.iter()
    }

    fn commit(&self) -> EditorResult<()> {
        let parent = self.path.parent().ok_or_else(|| EditorError::new(EditorErrorCode::Io))?;
        secure_parent(&self.path)?;
        fs::create_dir_all(parent).map_err(EditorError::from)?;
        let temporary = temporary_path(parent)?;
        reject_symlink(&temporary)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let bytes = serde_json::to_vec(&self.document)
            .map_err(|_| EditorError::new(EditorErrorCode::Io))?;
        if bytes.len() as u64 > MAX_REGISTRY_BYTES {
            return Err(EditorError::new(EditorErrorCode::Io));
        }
        let mut file = options.open(&temporary).map_err(EditorError::from)?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        drop(file);
        if let Err(error) = fs::rename(&temporary, &self.path) {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        harden_file(&self.path)
    }
}

fn validate_document(document: &RegistryDocument) -> EditorResult<()> {
    if document.version != REGISTRY_VERSION {
        return Err(EditorError::new(EditorErrorCode::Io));
    }
    if document.surfaces.len() > MAX_REGISTRY_ENTRIES {
        return Err(EditorError::new(EditorErrorCode::Io));
    }
    let mut surface_ids = BTreeSet::new();
    let mut global_count = 0_usize;
    for entry in &document.surfaces {
        validate_uuid(&entry.surface_id)?;
        if !surface_ids.insert(entry.surface_id.as_str()) {
            return Err(EditorError::new(EditorErrorCode::LifecycleConflict));
        }
        match (&entry.workspace_id, &entry.canonical_root) {
            (None, None) => global_count = global_count.saturating_add(1),
            (Some(workspace_id), Some(root))
                if root.len() <= 4096 && is_normalized_absolute_path(root) =>
            {
                validate_uuid(workspace_id)?;
            }
            _ => return Err(EditorError::new(EditorErrorCode::Io)),
        }
    }
    if global_count > 1 {
        return Err(EditorError::new(EditorErrorCode::LifecycleConflict));
    }
    Ok(())
}

fn validate_uuid(value: &str) -> EditorResult<()> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || matches!(*byte, b'a'..=b'f')
            }
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b');
    if !valid {
        return Err(EditorError::new(EditorErrorCode::InvalidSurface));
    }
    Ok(())
}

fn is_normalized_absolute_path(value: &str) -> bool {
    let path = Path::new(value);
    if !path.is_absolute() {
        return false;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir => normalized.push(Path::new("/")),
            std::path::Component::Normal(value) => normalized.push(value),
            _ => return false,
        }
    }
    normalized == path
}

fn temporary_path(parent: &Path) -> EditorResult<PathBuf> {
    let mut nonce = [0_u8; 8];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut nonce))
        .map_err(|_| EditorError::new(EditorErrorCode::Io))?;
    let suffix = nonce.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    Ok(parent.join(format!(".surface-registry.{suffix}.tmp")))
}

fn secure_parent(path: &Path) -> EditorResult<()> {
    let Some(parent) = path.parent() else {
        return Err(EditorError::new(EditorErrorCode::PermissionDenied));
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

fn new_uuid() -> EditorResult<String> {
    let mut bytes = [0_u8; 16];
    if File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes)).is_err() {
        return Err(EditorError::new(EditorErrorCode::Io));
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        u32::from_be_bytes(bytes[0..4].try_into().unwrap_or_default()),
        u16::from_be_bytes(bytes[4..6].try_into().unwrap_or_default()),
        u16::from_be_bytes(bytes[6..8].try_into().unwrap_or_default()),
        u16::from_be_bytes(bytes[8..10].try_into().unwrap_or_default()),
        u64::from_be_bytes([
            0, 0, bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ])
    ))
}

fn reject_symlink(path: &Path) -> EditorResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(EditorError::new(EditorErrorCode::PermissionDenied))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(EditorError::new(EditorErrorCode::Io)),
    }
}

fn harden_file(path: &Path) -> EditorResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| EditorError::new(EditorErrorCode::Io))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let root = fs::canonicalize(std::env::temp_dir()).expect("canonical temp directory").join(
            format!(
                "devhub-editor-registry-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
        );
        fs::create_dir_all(&root).expect("temp root");
        root
    }

    #[test]
    fn registry_is_atomic_owner_only_and_preserves_surface_ids() {
        let root = temp_root();
        let path = root.join("surface-registry.json");
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let mut registry = SurfaceRegistry::open(&path).expect("open");
        let global = registry.global().expect("global");
        let first = registry
            .workspace("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", &workspace)
            .expect("workspace");
        drop(registry);
        let mut restored = SurfaceRegistry::open(&path).expect("restore");
        assert_eq!(restored.global().expect("global").surface_id, global.surface_id);
        assert_eq!(
            restored
                .workspace("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", &workspace)
                .expect("workspace")
                .surface_id,
            first.surface_id
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(path).expect("metadata").permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn registry_rejects_identity_and_root_collisions() {
        let root = temp_root();
        let first_root = root.join("first");
        let second_root = root.join("second");
        fs::create_dir(&first_root).expect("first");
        fs::create_dir(&second_root).expect("second");
        let mut registry = SurfaceRegistry::open(root.join("registry.json")).expect("registry");
        registry
            .workspace("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", &first_root)
            .expect("first entry");
        assert_eq!(
            registry
                .workspace("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", &second_root)
                .expect_err("identity collision")
                .code(),
            EditorErrorCode::LifecycleConflict
        );
        assert_eq!(
            registry
                .workspace("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", &first_root)
                .expect_err("root collision")
                .code(),
            EditorErrorCode::LifecycleConflict
        );
    }

    #[test]
    fn shared_wire_fixture_is_exactly_compatible_with_rust_registry() {
        let root = temp_root();
        let path = root.join("surface-registry.json");
        fs::write(&path, include_str!("fixtures/surface-registry.v1.json")).expect("fixture");
        let registry = SurfaceRegistry::open(&path).expect("fixture registry");
        assert_eq!(registry.entries().count(), 2);
        assert!(registry.entries().next().expect("global").workspace_id.is_none());
        drop(registry);
        let bytes = fs::read(&path).expect("wire");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("wire json");
        assert!(value["surfaces"].is_array());
        assert_eq!(value["surfaces"][0]["workspace_id"], serde_json::Value::Null);
        assert_eq!(value["surfaces"][1]["workspace_id"], "22222222-2222-4222-8222-222222222222");
    }
}
