//! The two addresses the Editor still deals in.
//!
//! One is where its server is listening, which nothing outside this module is
//! allowed to assemble by hand. The other is a destination the Workbench has
//! decided belongs outside the app, on its way to the operating system.

use std::fmt;

use super::error::{EditorError, EditorErrorCode, EditorResult};
use super::paths::LOOPBACK_HOST;

/// The loopback authority the VS Code Server is listening on.
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

/// An external destination, after everything that is nobody's business has
/// been removed.
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

/// Narrow a candidate to a destination the operating system may be handed.
///
/// What arrives is text from a frame, so anything that is not a plain
/// `http`/`https` address with an authority and no credentials is refused,
/// and the query and fragment are dropped: what reaches the OS opener is the
/// smallest thing that still names the page.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_origin_is_never_a_privileged_port() {
        assert!(EditorOrigin::new(80).is_err());
        let origin = EditorOrigin::new(54_946).expect("origin");
        assert_eq!(origin.authority(), format!("{LOOPBACK_HOST}:54946"));
    }

    #[test]
    fn an_external_destination_keeps_only_what_names_the_page() {
        // The redaction is for logs. The opener needs the real thing, and the
        // absence of `Display` is what keeps the two from being confused.
        let url = external_url("https://example.invalid/docs?token=super-secret#here")
            .expect("a web address");
        assert_eq!(url.as_str(), "https://example.invalid/docs");
        assert_eq!(format!("{url:?}"), "<redacted-external-url>");
        assert!(!format!("{url:?}").contains("super-secret"));
    }

    #[test]
    fn nothing_but_a_plain_web_address_reaches_the_operating_system() {
        for candidate in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "devhub://editor/",
            "https://",
            "https://user:pass@example.invalid/",
            "https://exa\\mple.invalid/",
            "https://example.invalid/\na",
            "https://example.invalid/ a",
            "not a url",
            "",
        ] {
            assert!(external_url(candidate).is_none(), "should be refused: {candidate:?}");
        }
        // A destination longer than any real one is refused rather than
        // truncated: a truncated address names a different page.
        assert!(external_url(&format!("https://example.invalid/{}", "a".repeat(5_000))).is_none());
    }
}
