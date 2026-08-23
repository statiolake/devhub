//! Authenticated, loopback-only OpenVSCode URLs.

use std::fmt;
use std::path::{Path, PathBuf};

use super::error::{EditorError, EditorErrorCode, EditorResult};
use super::paths::LOOPBACK_HOST;
use super::token::SecretToken;

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

    pub fn prefix(self) -> String {
        format!("http://{}/", self.authority())
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

pub fn folderless_url(origin: EditorOrigin, token: &SecretToken) -> AuthenticatedUrl {
    AuthenticatedUrl(format!("{}?ew=true&tkn={}", origin.prefix(), token.hex()))
}

pub fn folder_url(
    origin: EditorOrigin,
    token: &SecretToken,
    root: &Path,
) -> EditorResult<AuthenticatedUrl> {
    let root =
        root.to_str().ok_or_else(|| EditorError::new(EditorErrorCode::InvalidWorkspaceRoot))?;
    if !root.starts_with('/') || root.contains('\0') {
        return Err(EditorError::new(EditorErrorCode::InvalidWorkspaceRoot));
    }
    Ok(AuthenticatedUrl(format!(
        "{}?folder={}&tkn={}",
        origin.prefix(),
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

impl fmt::Display for ExternalUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted-external-url>")
    }
}

impl ExternalUrl {
    #[allow(dead_code)]
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// Classify a navigation relative to the URL that established one native
/// surface. A Workbench folder query is an ownership transition, not an
/// ordinary same-origin navigation: the host must route it explicitly so a
/// Global surface can never silently become a Workspace surface.
pub fn navigation_decision(
    origin: EditorOrigin,
    surface_url: &AuthenticatedUrl,
    candidate: &str,
) -> NavigationDecision {
    if candidate.contains('\0') {
        return NavigationDecision::Reject;
    }
    let prefix = origin.prefix();
    if candidate.starts_with(&prefix) && candidate[prefix.len()..].starts_with("//") {
        return NavigationDecision::Reject;
    }
    if !candidate.starts_with(&prefix) {
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
/// OpenVSCode query, including `tkn`, never crosses the WebView router seam.
pub fn navigation_request(origin: EditorOrigin, candidate: &str) -> Option<NavigationRequest> {
    if candidate.starts_with("http://") || candidate.starts_with("https://") {
        if !candidate.starts_with(&origin.prefix()) {
            return sanitize_external(candidate).map(|url| NavigationRequest::External { url });
        }
        let query = candidate.split_once('?').map(|(_, query)| query).unwrap_or_default();
        let folder = query_value(query, "folder")?;
        let decoded = percent_decode(folder)?;
        if !decoded.starts_with('/') || decoded.contains('\0') {
            return None;
        }
        return Some(NavigationRequest::Workspace { absolute_path: PathBuf::from(decoded) });
    }
    None
}

fn sanitize_external(candidate: &str) -> Option<ExternalUrl> {
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
        let origin = EditorOrigin::new(54945).expect("origin");
        let global = folderless_url(origin, &token);
        assert!(global.as_str().starts_with("http://127.0.0.1:54945/?ew=true&tkn=abab"));
        let folder = folder_url(origin, &token, &PathBuf::from("/Users/statiolake/dev hub"))
            .expect("folder");
        assert!(folder.as_str().contains("folder=%2FUsers%2Fstatiolake%2Fdev%20hub"));
        assert!(!format!("{global:?}").contains("abab"));
    }

    #[test]
    fn navigation_is_surface_aware_and_same_origin_only() {
        let origin = EditorOrigin::new(54945).expect("origin");
        let token = SecretToken::from_bytes_for_test([0xabu8; TOKEN_BYTES]);
        let global = folderless_url(origin, &token);
        assert_eq!(
            navigation_decision(origin, &global, "http://127.0.0.1:54945/static/app.js"),
            NavigationDecision::AllowSameSurface
        );
        let folder_candidate =
            format!("http://127.0.0.1:54945/?folder=%2Fworkspace&tkn={}", token.hex());
        assert_eq!(
            navigation_decision(origin, &global, &folder_candidate),
            NavigationDecision::RouteWorkspace
        );
        assert_eq!(
            navigation_decision(origin, &global, "http://127.0.0.1:54946/"),
            NavigationDecision::OpenExternal
        );
        assert_eq!(
            navigation_decision(origin, &global, "https://example.invalid/"),
            NavigationDecision::OpenExternal
        );
        assert_eq!(
            navigation_decision(origin, &global, "javascript:alert(1)"),
            NavigationDecision::Reject
        );
    }

    #[test]
    fn workspace_to_workspace_navigation_is_routed() {
        let origin = EditorOrigin::new(54945).expect("origin");
        let token = SecretToken::from_bytes_for_test([0xabu8; TOKEN_BYTES]);
        let workspace = folder_url(origin, &token, Path::new("/workspace-a")).expect("workspace");
        let folder_candidate =
            format!("http://127.0.0.1:54945/?folder=%2Fworkspace-b&tkn={}", token.hex());
        assert_eq!(
            navigation_decision(origin, &workspace, &folder_candidate),
            NavigationDecision::RouteWorkspace
        );
    }

    #[test]
    fn navigation_request_strips_provider_query_and_token() {
        let origin = EditorOrigin::new(54945).expect("origin");
        let request = navigation_request(
            origin,
            "http://127.0.0.1:54945/?folder=%2Fworkspace-a&tkn=super-secret",
        )
        .expect("request");
        assert_eq!(
            request,
            NavigationRequest::Workspace { absolute_path: PathBuf::from("/workspace-a") }
        );
        assert!(!format!("{request:?}").contains("super-secret"));

        let request =
            navigation_request(origin, "https://example.invalid/editor?tkn=super-secret#fragment")
                .expect("external request");
        let NavigationRequest::External { url } = request else {
            panic!("expected external request")
        };
        assert_eq!(url.as_str(), "https://example.invalid/editor");
        assert!(!format!("{url:?}").contains("super-secret"));
    }
}
