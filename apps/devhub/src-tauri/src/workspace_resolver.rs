use std::path::PathBuf;

use devhub_app_core::{
    CancellationToken, DisplayPath, PortError, PortErrorCode, PortFuture, RequestedPath,
    ResolvedWorkspacePath, WorkspacePathResolver, WorkspaceRoot,
};

/// Native filesystem resolver used by the macOS shell boundary. The core port
/// remains pure; this adapter is the only layer allowed to consult the
/// filesystem before constructing domain identity values.
#[derive(Clone, Debug)]
pub(crate) struct MacWorkspacePathResolver {
    home: PathBuf,
}

impl MacWorkspacePathResolver {
    pub(crate) fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into() }
    }

    fn resolve_path(&self, requested: &RequestedPath) -> Result<ResolvedWorkspacePath, PortError> {
        let raw = requested.as_str();
        let expanded = if raw == "~" {
            self.home.clone()
        } else if let Some(rest) = raw.strip_prefix("~/") {
            self.home.join(rest)
        } else {
            PathBuf::from(raw)
        };
        let absolute = if expanded.is_absolute() {
            expanded
        } else {
            std::env::current_dir()
                .map_err(|_| PortError::new(PortErrorCode::Unavailable))?
                .join(expanded)
        };
        let canonical = std::fs::canonicalize(&absolute)
            .map_err(|_| PortError::new(PortErrorCode::Unavailable))?;
        if !canonical.is_dir() {
            return Err(PortError::new(PortErrorCode::Failed));
        }
        let root = WorkspaceRoot::new(canonical.clone())
            .map_err(|_| PortError::new(PortErrorCode::Failed))?;
        // Keep the user-facing selected path distinct from the canonical
        // duplicate-prevention root, but construct both only after the
        // existing-directory and symlink checks above have succeeded.
        let selected_path =
            DisplayPath::new(absolute).map_err(|_| PortError::new(PortErrorCode::Failed))?;
        Ok(ResolvedWorkspacePath { root, selected_path })
    }
}

impl WorkspacePathResolver for MacWorkspacePathResolver {
    fn resolve(
        &self,
        path: RequestedPath,
        _cancel: CancellationToken,
    ) -> PortFuture<ResolvedWorkspacePath> {
        let resolver = self.clone();
        Box::pin(async move { resolver.resolve_path(&path) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn resolver_requires_existing_directory_and_returns_os_canonical_identity() {
        let base = std::env::temp_dir().join(format!("devhub-resolver-{}", std::process::id()));
        let nested = base.join("nested");
        fs::create_dir_all(&nested).expect("create test directory");
        let result = MacWorkspacePathResolver::new("/")
            .resolve_path(&RequestedPath::new(nested.to_string_lossy().to_string()).expect("path"))
            .expect("directory resolves");
        assert_eq!(result.root.as_path(), fs::canonicalize(&nested).unwrap());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&nested, base.join("alias")).expect("create symlink");
            let symlinked = MacWorkspacePathResolver::new("/")
                .resolve_path(
                    &RequestedPath::new(base.join("alias").to_string_lossy().to_string())
                        .expect("symlink path"),
                )
                .expect("symlinked directory resolves");
            assert_eq!(symlinked.root.as_path(), fs::canonicalize(&nested).unwrap());
            assert_eq!(symlinked.selected_path.as_path(), base.join("alias"));
        }
        assert!(MacWorkspacePathResolver::new("/")
            .resolve_path(
                &RequestedPath::new(base.join("missing").to_string_lossy().to_string())
                    .expect("path")
            )
            .is_err());
        fs::remove_dir_all(&base).expect("remove test directory");
    }
}
