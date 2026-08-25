//! Deep native EditorHost module.
//!
//! The public surface is intentionally small. Filesystem, process, registry,
//! URL, and WebView details remain behind this module so App Shell callers do
//! not learn provider identities or lifecycle coupling.

mod bridge;
mod bridge_transport;
mod error;
mod host;
mod paths;
mod port;
mod process;
mod provider;
mod readiness;
mod registry;
mod token;
mod url;
mod webview;

pub use bridge_transport::{
    BridgeEvent, BridgeEventSink, BridgeRequest, BridgeRequestDisposition, BridgeRequestHandle,
    BridgeRequestResult, BridgeSurfaceId,
};
pub use error::{EditorError, EditorErrorCode, EditorResult};
pub use host::{EditorHost, EditorHostConfig, EditorSurfaceKey, EditorSurfaceSnapshot};
pub use provider::{EditorExecutable, OfficialVscodeCapabilities, OfficialVscodeExecutable};
pub use url::{ExternalUrl, NavigationDecision, NavigationRequest};
pub use webview::{EditorBounds, NativeFocusIdentity};
pub use webview::{NavigationRouter, WryWebViewHost};
