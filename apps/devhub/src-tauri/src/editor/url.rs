//! Authenticated, loopback-only VS Code Server URLs.

use std::fmt;
use std::path::{Path, PathBuf};

use super::error::{EditorError, EditorErrorCode, EditorResult};
use super::paths::LOOPBACK_HOST;
use super::token::SecretToken;

/// The origin every Editor surface is served from.
///
/// A custom scheme rather than the loopback authority the server listens on,
/// because the browser keys storage by origin and the server's port is not
/// ours to keep: IndexedDB is where VS Code Web puts user settings and its
/// Settings Sync session, and a port that moves takes all of it. This one
/// never moves. Requests to it are proxied to whatever port the server bound.
pub const EDITOR_SCHEME: &str = "devhub";
pub const EDITOR_PAGE_PREFIX: &str = "devhub://editor/";

/// The loopback authority the VS Code Server is listening on. Upstream only:
/// nothing the WebView is navigated to is addressed here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EditorOrigin {
    port: u16,
}

impl EditorOrigin {
    pub fn new(port: u16) -> EditorResult<Self> {
        if port < 1024 {
            return Err(EditorError::new(EditorErrorCode::InvalidPort));
        }
        Ok(Self { port })
    }

    pub const fn port(self) -> u16 {
        self.port
    }

    pub fn authority(self) -> String {
        format!("{LOOPBACK_HOST}:{}", self.port)
    }
}

/// URL value with a redacted `Debug` representation. Callers that need to
/// navigate a WebView borrow it only inside the adapter.
#[derive(Clone, PartialEq, Eq)]
pub struct AuthenticatedUrl(String);

impl fmt::Debug for AuthenticatedUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted-editor-url>")
    }
}

impl AuthenticatedUrl {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    pub fn redacted(&self) -> String {
        self.0
            .split_once('?')
            .map_or_else(|| self.0.clone(), |(base, _)| format!("{base}?<redacted>"))
    }
}

pub fn folderless_url(token: &SecretToken) -> AuthenticatedUrl {
    AuthenticatedUrl(format!("{EDITOR_PAGE_PREFIX}?ew=true&tkn={}", token.hex()))
}

pub fn folder_url(token: &SecretToken, root: &Path) -> EditorResult<AuthenticatedUrl> {
    let root =
        root.to_str().ok_or_else(|| EditorError::new(EditorErrorCode::InvalidWorkspaceRoot))?;
    if !root.starts_with('/') || root.contains('\0') {
        return Err(EditorError::new(EditorErrorCode::InvalidWorkspaceRoot));
    }
    Ok(AuthenticatedUrl(format!(
        "{EDITOR_PAGE_PREFIX}?folder={}&tkn={}",
        percent_encode(root),
        token.hex()
    )))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    AllowSameSurface,
    RouteWorkspace,
    OpenExternal,
    Reject,
}

#[derive(Clone, PartialEq, Eq)]
pub enum NavigationRequest {
    Workspace { absolute_path: PathBuf },
    External { url: ExternalUrl },
}

impl fmt::Debug for NavigationRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Workspace { .. } => formatter.write_str("Workspace(<redacted>)"),
            Self::External { .. } => formatter.write_str("External(<redacted>)"),
        }
    }
}

/// An external destination after provider credentials and query state have
/// been removed.  The inner URL remains adapter-only: diagnostics and public
/// formatting never expose it, while the trusted App Shell adapter can borrow
/// the value for its OS opener.
#[derive(Clone, PartialEq, Eq)]
pub struct ExternalUrl(String);

impl fmt::Debug for ExternalUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted-external-url>")
    }
}

impl ExternalUrl {
    /// The destination itself, for the one caller that has to hand it to the
    /// operating system.
    ///
    /// There is deliberately no `Display`. The redacted `Debug` above is the
    /// only formatting this type has, so `to_string()` does not compile and
    /// cannot quietly produce the placeholder where the URL was meant — which
    /// is exactly what the external opener used to do, handing macOS a
    /// relative path named after the redaction.
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// Classify a navigation relative to the URL that established one native
/// surface. A Workbench folder query is an ownership transition, not an
/// ordinary same-origin navigation: the host must route it explicitly so a
/// Global surface can never silently become a Workspace surface.
pub fn navigation_decision(surface_url: &AuthenticatedUrl, candidate: &str) -> NavigationDecision {
    if candidate.contains('\0') {
        return NavigationDecision::Reject;
    }
    let prefix = EDITOR_PAGE_PREFIX;
    if candidate.starts_with(prefix) && candidate[prefix.len()..].starts_with("//") {
        return NavigationDecision::Reject;
    }
    if !candidate.starts_with(prefix) {
        return if candidate.starts_with("http://") || candidate.starts_with("https://") {
            NavigationDecision::OpenExternal
        } else {
            NavigationDecision::Reject
        };
    }

    let current_query =
        surface_url.as_str().split_once('?').map(|(_, query)| query).unwrap_or_default();
    let candidate_query = candidate.split_once('?').map(|(_, query)| query).unwrap_or_default();
    if let Some(candidate_token) = query_value(candidate_query, "tkn") {
        if query_value(current_query, "tkn") != Some(candidate_token) {
            return NavigationDecision::Reject;
        }
    }
    let current_folder = query_value(current_query, "folder");
    let candidate_folder = query_value(candidate_query, "folder");
    if candidate_folder.is_some() && current_folder != candidate_folder {
        return NavigationDecision::RouteWorkspace;
    }
    let current_global = query_value(current_query, "ew") == Some("true");
    let candidate_ew = query_value(candidate_query, "ew");
    let candidate_global = candidate_ew == Some("true");
    if candidate_ew.is_some() && current_global != candidate_global {
        return NavigationDecision::RouteWorkspace;
    }
    NavigationDecision::AllowSameSurface
}

/// Convert a classified transition into a sanitized request. The raw
/// VS Code Server query, including `tkn`, never crosses the WebView router seam.
pub fn navigation_request(candidate: &str) -> Option<NavigationRequest> {
    if candidate.starts_with(EDITOR_PAGE_PREFIX) {
        let query = candidate.split_once('?').map(|(_, query)| query).unwrap_or_default();
        let folder = query_value(query, "folder")?;
        let decoded = percent_decode(folder)?;
        if !decoded.starts_with('/') || decoded.contains('\0') {
            return None;
        }
        return Some(NavigationRequest::Workspace { absolute_path: PathBuf::from(decoded) });
    }
    if candidate.starts_with("http://") || candidate.starts_with("https://") {
        return external_url(candidate).map(|url| NavigationRequest::External { url });
    }
    None
}

/// Narrow a candidate to a destination the operating system may be handed.
///
/// Anything that is not a plain `http`/`https` address with an authority and
/// no credentials is refused, and the query and fragment are dropped: what
/// reaches the OS opener is the smallest thing that still names the page.
pub fn external_url(candidate: &str) -> Option<ExternalUrl> {
    if candidate.len() > 4096
        || candidate.bytes().any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return None;
    }
    let scheme_end = candidate.find("://")?;
    if !matches!(&candidate[..scheme_end], "http" | "https") {
        return None;
    }
    let authority_start = scheme_end + 3;
    let authority_end = candidate[authority_start..]
        .find(['/', '?', '#'])
        .map_or(candidate.len(), |offset| authority_start + offset);
    let authority = &candidate[authority_start..authority_end];
    if authority.is_empty() || authority.contains('@') || authority.contains('\\') {
        return None;
    }
    let query_or_fragment = candidate[authority_end..]
        .find(['?', '#'])
        .map_or(candidate.len(), |offset| authority_end + offset);
    Some(ExternalUrl(candidate[..query_or_fragment].to_owned()))
}

fn query_value<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|part| {
        let (candidate_key, value) = part.split_once('=')?;
        (candidate_key == key).then_some(value)
    })
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(char::from(b"0123456789ABCDEF"[(byte >> 4) as usize]));
            encoded.push(char::from(b"0123456789ABCDEF"[(byte & 0x0f) as usize]));
        }
    }
    encoded
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes.get(index + 1).copied().and_then(hex_value)?;
            let low = bytes.get(index + 2).copied().and_then(hex_value)?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::super::token::TOKEN_BYTES;
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn urls_are_authenticated_and_folder_paths_are_encoded() {
        let token = SecretToken::from_bytes_for_test([0xabu8; TOKEN_BYTES]);
        let global = folderless_url(&token);
        assert!(global.as_str().starts_with("devhub://editor/?ew=true&tkn=abab"));
        let folder =
            folder_url(&token, &PathBuf::from("/Users/statiolake/dev hub")).expect("folder");
        assert!(folder.as_str().contains("folder=%2FUsers%2Fstatiolake%2Fdev%20hub"));
        assert!(!format!("{global:?}").contains("abab"));
    }

    #[test]
    fn navigation_is_surface_aware_and_same_origin_only() {
        let token = SecretToken::from_bytes_for_test([0xabu8; TOKEN_BYTES]);
        let global = folderless_url(&token);
        assert_eq!(
            navigation_decision(&global, "devhub://editor/static/app.js"),
            NavigationDecision::AllowSameSurface
        );
        let folder_candidate = format!("devhub://editor/?folder=%2Fworkspace&tkn={}", token.hex());
        assert_eq!(
            navigation_decision(&global, &folder_candidate),
            NavigationDecision::RouteWorkspace
        );
        assert_eq!(
            navigation_decision(&global, "http://127.0.0.1:54946/"),
            NavigationDecision::OpenExternal
        );
        assert_eq!(
            navigation_decision(&global, "https://example.invalid/"),
            NavigationDecision::OpenExternal
        );
        assert_eq!(navigation_decision(&global, "javascript:alert(1)"), NavigationDecision::Reject);
    }

    #[test]
    fn workspace_to_workspace_navigation_is_routed() {
        let token = SecretToken::from_bytes_for_test([0xabu8; TOKEN_BYTES]);
        let workspace = folder_url(&token, Path::new("/workspace-a")).expect("workspace");
        let folder_candidate =
            format!("devhub://editor/?folder=%2Fworkspace-b&tkn={}", token.hex());
        assert_eq!(
            navigation_decision(&workspace, &folder_candidate),
            NavigationDecision::RouteWorkspace
        );
    }

    #[test]
    fn an_external_destination_is_readable_only_where_it_is_used() {
        // The redaction is for logs. The opener needs the real thing, and the
        // absence of `Display` is what keeps the two from being confused.
        let NavigationRequest::External { url } =
            navigation_request("https://example.invalid/docs?token=super-secret").expect("request")
        else {
            panic!("an external destination");
        };
        assert_eq!(url.as_str(), "https://example.invalid/docs");
        assert_eq!(format!("{url:?}"), "<redacted-external-url>");
    }

    #[test]
    fn navigation_request_strips_provider_query_and_token() {
        let request = navigation_request("devhub://editor/?folder=%2Fworkspace-a&tkn=super-secret")
            .expect("request");
        assert_eq!(
            request,
            NavigationRequest::Workspace { absolute_path: PathBuf::from("/workspace-a") }
        );
        assert!(!format!("{request:?}").contains("super-secret"));

        let request =
            navigation_request("https://example.invalid/editor?tkn=super-secret#fragment")
                .expect("external request");
        let NavigationRequest::External { url } = request else {
            panic!("expected external request")
        };
        assert_eq!(url.as_str(), "https://example.invalid/editor");
        assert!(!format!("{url:?}").contains("super-secret"));
    }
}
