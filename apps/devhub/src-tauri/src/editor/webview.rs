//! WebView adapter seam. Production uses the raw WRY child-view API; tests
//! use an in-memory adapter and never construct a native window.

use super::error::EditorResult;
use super::proxy::EditorProxy;
use super::url::{AuthenticatedUrl, NavigationRequest};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

#[path = "wry_webview.rs"]
mod wry_webview;

pub use wry_webview::WryWebViewHost;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl EditorBounds {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    pub fn is_valid(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width >= 1.0
            && self.height >= 1.0
    }
}

#[derive(Clone)]
pub struct WebViewSpec {
    pub label: String,
    pub url: AuthenticatedUrl,
    /// Serves the Editor origin. Shared with every other surface, because
    /// they are all one origin and one session.
    pub(crate) proxy: Arc<EditorProxy>,
    pub bounds: EditorBounds,
    pub data_directory: PathBuf,
    pub data_store_identifier: [u8; 16],
    pub focused: bool,
}

/// Main-thread native ownership proof for one concrete WRY child view. The
/// pointers are process-local and never cross the App Shell wire.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeFocusIdentity {
    pub responder_root: usize,
    pub window: usize,
    pub window_number: isize,
}

impl std::fmt::Debug for WebViewSpec {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebViewSpec")
            .field("label", &self.label)
            .field("url", &"<redacted>")
            .field("bounds", &self.bounds)
            .field("data_directory", &"<redacted>")
            .field("data_store_identifier", &self.data_store_identifier)
            .field("focused", &self.focused)
            .finish()
    }
}

pub trait EditorWebView: Send {
    fn hide(&self) -> EditorResult<()>;
    fn show(&self) -> EditorResult<()>;
    fn set_bounds(&self, bounds: EditorBounds) -> EditorResult<()>;
    fn focus(&self) -> EditorResult<()>;
    fn close(&self) -> EditorResult<()>;

    /// Transient native responder identity used only by host keyboard focus
    /// routing. Provider-free test adapters intentionally return `None`.
    fn native_focus_identity(&self) -> Option<NativeFocusIdentity> {
        None
    }

    /// Deadline-aware close used by process quit. Test/in-memory adapters can
    /// use the ordinary close path; native WRY adapters override this to
    /// bound the main-thread dispatch itself.
    fn close_until(&self, _deadline: Instant) -> EditorResult<()> {
        self.close()
    }
}

pub trait WebViewHost: Send + Sync {
    fn create(&self, spec: &WebViewSpec) -> EditorResult<Box<dyn EditorWebView>>;
}

/// Narrow side-effect seam for navigation that leaves the current surface.
/// The App Shell supplies this router explicitly; the child WebView never
/// receives a Tauri IPC capability or an unrestricted external opener.
pub trait NavigationRouter: Send + Sync {
    fn route_workspace(&self, surface: &str, request: &NavigationRequest) -> EditorResult<()>;
    fn open_external(&self, request: &NavigationRequest) -> EditorResult<()>;
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    pub(crate) struct FakeWebViewHost {
        pub(crate) created: Arc<Mutex<Vec<WebViewSpec>>>,
        pub(crate) actions: Arc<Mutex<Vec<String>>>,
    }

    struct FakeWebView {
        label: String,
        actions: Arc<Mutex<Vec<String>>>,
    }

    impl EditorWebView for FakeWebView {
        fn hide(&self) -> EditorResult<()> {
            self.actions.lock().expect("actions").push(format!("hide:{}", self.label));
            Ok(())
        }

        fn show(&self) -> EditorResult<()> {
            self.actions.lock().expect("actions").push(format!("show:{}", self.label));
            Ok(())
        }

        fn set_bounds(&self, _bounds: EditorBounds) -> EditorResult<()> {
            self.actions.lock().expect("actions").push(format!("bounds:{}", self.label));
            Ok(())
        }

        fn focus(&self) -> EditorResult<()> {
            self.actions.lock().expect("actions").push(format!("focus:{}", self.label));
            Ok(())
        }

        fn close(&self) -> EditorResult<()> {
            self.actions.lock().expect("actions").push(format!("close:{}", self.label));
            Ok(())
        }
    }

    impl WebViewHost for FakeWebViewHost {
        fn create(&self, spec: &WebViewSpec) -> EditorResult<Box<dyn EditorWebView>> {
            self.created.lock().expect("created").push(spec.clone());
            Ok(Box::new(FakeWebView { label: spec.label.clone(), actions: self.actions.clone() }))
        }
    }

    #[test]
    fn production_host_uses_raw_wry_without_tauri_bootstrap_hooks() {
        let source = include_str!("wry_webview.rs");
        let manager_child_method = ["add", "_child"].concat();
        let initialization_method = ["initialization", "_script"].concat();
        let tauri_builder = ["tauri", "::", "WebviewBuilder"].concat();
        assert!(source.contains("wry::WebViewBuilder"));
        assert!(source.contains("build_as_child"));
        assert!(source.contains("impl Drop for RawWryEditorWebView"));
        assert!(!source.contains("TauriWebViewHost"));
        assert!(!source.contains(&manager_child_method));
        assert!(!source.contains(&initialization_method));
        assert!(!source.contains("initialization"));
        assert!(!source.contains(&tauri_builder));
        assert!(!source.contains("__TAURI_INTERNALS__"));
        assert!(!source.contains("with_ipc_handler"));
    }

    #[test]
    fn vendored_wry_only_installs_ipc_for_explicit_handlers() {
        let mac = include_str!("../../vendor/wry/src/wkwebview/mod.rs");
        let gtk = include_str!("../../vendor/wry/src/webkitgtk/mod.rs");
        let windows = include_str!("../../vendor/wry/src/webview2/mod.rs");
        assert!(mac.contains("let has_ipc_handler = attributes.ipc_handler.is_some();"));
        assert!(mac.contains("if has_ipc_handler"));
        assert!(gtk.contains("if attributes.ipc_handler.is_none()"));
        assert!(gtk.contains("if has_ipc_handler"));
        assert!(windows.contains("if attributes.ipc_handler.is_none()"));
        assert!(!source_contains_editor_global_api(mac));
        assert!(!source_contains_editor_global_api(gtk));
        assert!(!source_contains_editor_global_api(windows));
    }

    #[test]
    fn vendored_wry_preserves_native_command_responder_paths() {
        let child = include_str!("../../vendor/wry/src/wkwebview/class/wry_web_view.rs");
        let parent = include_str!("../../vendor/wry/src/wkwebview/class/wry_web_view_parent.rs");
        assert!(child.contains("performKeyEquivalent"));
        assert!(child.contains("super(self), performKeyEquivalent: event"));
        assert!(parent.contains("super(self), keyDown: event"));
        assert!(parent.contains("if !handled"));
        assert!(!child.contains("KeyboardEvent"));
        assert!(!parent.contains("eval"));
    }

    fn source_contains_editor_global_api(source: &str) -> bool {
        source.contains("__TAURI_INTERNALS__") || source.contains("isTauri")
    }
}
