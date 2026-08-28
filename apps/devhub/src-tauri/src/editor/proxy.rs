//! The Editor origin's transport.
//!
//! Surfaces are served from a fixed custom scheme so the browser's per-origin
//! storage survives a server that binds a different port every run. Nothing
//! here knows anything about VS Code: a request that arrives on the scheme is
//! replayed against the loopback server and its response is handed back as it
//! came. The one piece of state is the session cookie the server issues in
//! exchange for the connection token, which later requests have to carry.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use super::paths::LOOPBACK_HOST;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(2_000);
const IO_TIMEOUT: Duration = Duration::from_millis(30_000);
/// The Workbench bundle alone is around 18 MB, and an extension host payload
/// can be larger. This is a ceiling against a runaway response, not a budget.
const MAX_BODY: usize = 256 * 1024 * 1024;
/// The server answers the token in the query string with a cookie and a
/// redirect to the same path without it. Following that here keeps the loop
/// off the page, which would otherwise be handed its own start URL again.
const MAX_REDIRECTS: u8 = 4;

pub struct ProxyResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Where the Editor origin's requests actually go.
///
/// The port is not fixed for the life of the process: a server that crashes is
/// restarted and may land somewhere else, and every surface has to follow it
/// without its origin changing.
#[derive(Default)]
pub struct EditorProxy {
    port: AtomicU16,
    cookies: Mutex<Vec<(String, String)>>,
}

impl EditorProxy {
    pub fn new() -> Self {
        Self::default()
    }

    /// Point the origin at a server, and forget the session that belonged to
    /// whatever was there before.
    pub fn set_upstream(&self, port: u16) {
        if self.port.swap(port, Ordering::AcqRel) != port {
            if let Ok(mut cookies) = self.cookies.lock() {
                cookies.clear();
            }
        }
    }

    pub fn upstream(&self) -> Option<u16> {
        match self.port.load(Ordering::Acquire) {
            0 => None,
            port => Some(port),
        }
    }

    pub fn request(
        &self,
        method: &str,
        target: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> Option<ProxyResponse> {
        let mut target = target.to_owned();
        for _ in 0..=MAX_REDIRECTS {
            let response = self.round_trip(method, &target, headers, body)?;
            self.remember_cookies(&response);
            let redirect = matches!(response.status, 301 | 302 | 303 | 307 | 308);
            let Some(location) = redirect.then(|| header(&response, "location")).flatten() else {
                return Some(response);
            };
            // Only a redirect that stays on this server can be followed
            // silently; anything else is the page's business, not ours.
            let Some(next) = same_origin_target(&location) else {
                return Some(response);
            };
            target = next;
        }
        None
    }

    fn round_trip(
        &self,
        method: &str,
        target: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> Option<ProxyResponse> {
        let port = self.upstream()?;
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).ok()?;
        stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
        stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;

        let mut request = format!("{method} {target} HTTP/1.1\r\nHost: {LOOPBACK_HOST}:{port}\r\n");
        for (name, value) in headers {
            // Hop-by-hop headers describe the connection this proxy is
            // making, not the one it was asked about, and the browser's own
            // Host and Origin name an origin the server has never heard of.
            if is_hop_by_hop(name) || name.eq_ignore_ascii_case("host") {
                continue;
            }
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        if let Some(cookie) = self.cookie_header() {
            request.push_str(&format!("Cookie: {cookie}\r\n"));
        }
        if !body.is_empty() {
            request.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        // Every request gets its own connection. A pool would be faster, and
        // loopback is cheap enough that correctness is worth more here.
        request.push_str("Accept-Encoding: identity\r\nConnection: close\r\n\r\n");

        stream.write_all(request.as_bytes()).ok()?;
        if !body.is_empty() {
            stream.write_all(body).ok()?;
        }
        stream.flush().ok()?;

        let mut raw = Vec::new();
        let mut buffer = [0_u8; 32 * 1024];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if raw.len() + read > MAX_BODY {
                        return None;
                    }
                    raw.extend_from_slice(&buffer[..read]);
                }
                Err(_) => break,
            }
        }
        parse_response(&raw)
    }

    fn cookie_header(&self) -> Option<String> {
        let cookies = self.cookies.lock().ok()?;
        if cookies.is_empty() {
            return None;
        }
        Some(
            cookies
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    fn remember_cookies(&self, response: &ProxyResponse) {
        let Ok(mut cookies) = self.cookies.lock() else { return };
        for (name, value) in &response.headers {
            if !name.eq_ignore_ascii_case("set-cookie") {
                continue;
            }
            let Some((pair, _)) = value.split_once(';').or(Some((value.as_str(), ""))) else {
                continue;
            };
            let Some((key, cookie)) = pair.trim().split_once('=') else { continue };
            let key = key.trim().to_owned();
            let cookie = cookie.trim().to_owned();
            match cookies.iter_mut().find(|(existing, _)| existing == &key) {
                Some(slot) => slot.1 = cookie,
                None => cookies.push((key, cookie)),
            }
        }
    }
}

fn header(response: &ProxyResponse, name: &str) -> Option<String> {
    response
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

/// The request target for a redirect that stays on this server.
fn same_origin_target(location: &str) -> Option<String> {
    if location.starts_with('/') {
        return Some(location.to_owned());
    }
    let rest = location.strip_prefix("http://")?;
    let (authority, target) = rest.split_once('/').unwrap_or((rest, ""));
    authority.starts_with(LOOPBACK_HOST).then(|| format!("/{target}"))
}

fn is_hop_by_hop(name: &str) -> bool {
    const HOP_BY_HOP: [&str; 8] = [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ];
    HOP_BY_HOP.iter().any(|candidate| name.eq_ignore_ascii_case(candidate))
}

fn parse_response(raw: &[u8]) -> Option<ProxyResponse> {
    let split = raw.windows(4).position(|window| window == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split(' ').nth(1)?.parse::<u16>().ok()?;
    let mut headers = Vec::new();
    let mut chunked = false;
    let mut length = None;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value.eq_ignore_ascii_case("chunked");
        }
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse::<usize>().ok();
        }
        headers.push((name.to_owned(), value.to_owned()));
    }
    let rest = &raw[split + 4..];
    let body = if chunked {
        decode_chunked(rest)?
    } else {
        // A response with neither framing header ends when the connection
        // closes, which it already has.
        rest[..length.unwrap_or(rest.len()).min(rest.len())].to_vec()
    };
    // Framing belongs to the connection this proxy made. The custom-scheme
    // response is handed over as one complete body.
    headers
        .retain(|(name, _)| !is_hop_by_hop(name) && !name.eq_ignore_ascii_case("content-length"));
    Some(ProxyResponse { status, headers, body })
}

fn decode_chunked(mut rest: &[u8]) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let line_end = rest.windows(2).position(|window| window == b"\r\n")?;
        let size = std::str::from_utf8(&rest[..line_end]).ok()?;
        let size = usize::from_str_radix(size.split(';').next()?.trim(), 16).ok()?;
        rest = rest.get(line_end + 2..)?;
        if size == 0 {
            return Some(body);
        }
        body.extend_from_slice(rest.get(..size)?);
        rest = rest.get(size + 2..)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(raw: &str) -> ProxyResponse {
        parse_response(raw.as_bytes()).expect("response")
    }

    #[test]
    fn chunked_framing_is_decoded_and_not_passed_on() {
        // The server chunks the Workbench document. Framing describes the
        // connection this proxy made, not the one the page asked about, so the
        // body is reassembled and the framing headers are dropped.
        let parsed = response(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ntransfer-encoding: chunked\r\n\r\n\
             5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
        );
        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.body, b"hello world");
        assert!(parsed
            .headers
            .iter()
            .all(|(name, _)| !name.eq_ignore_ascii_case("transfer-encoding")));
        assert!(parsed.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-type")));
    }

    #[test]
    fn a_content_length_body_is_taken_at_its_stated_size() {
        let parsed = response("HTTP/1.1 200 OK\r\ncontent-length: 4\r\n\r\nbodyTRAILING");
        assert_eq!(parsed.body, b"body");
        assert!(parsed
            .headers
            .iter()
            .all(|(name, _)| !name.eq_ignore_ascii_case("content-length")));
    }

    #[test]
    fn a_body_with_no_framing_ends_where_the_connection_did() {
        let parsed = response("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nwhatever");
        assert_eq!(parsed.body, b"whatever");
    }

    #[test]
    fn the_session_cookie_is_kept_and_replaced_but_not_duplicated() {
        // The server trades the connection token for a cookie on the first
        // request and expects it on every one after, so this is what keeps the
        // rest of the Workbench authenticated.
        let proxy = EditorProxy::new();
        proxy.remember_cookies(&response(
            "HTTP/1.1 302 Found\r\nset-cookie: vscode-tkn=first; Max-Age=604800; SameSite=Lax\r\n\
             set-cookie: other=keep; Path=/\r\n\r\n",
        ));
        assert_eq!(proxy.cookie_header().expect("cookies"), "vscode-tkn=first; other=keep");
        proxy.remember_cookies(&response(
            "HTTP/1.1 200 OK\r\nset-cookie: vscode-tkn=second\r\n\r\n",
        ));
        assert_eq!(proxy.cookie_header().expect("cookies"), "vscode-tkn=second; other=keep");
    }

    #[test]
    fn a_server_that_moves_takes_its_session_with_it() {
        // The origin outlives the server. A session minted by the process that
        // used to be on that port is worth nothing to the one that replaced it.
        let proxy = EditorProxy::new();
        proxy.set_upstream(40_000);
        proxy
            .remember_cookies(&response("HTTP/1.1 200 OK\r\nset-cookie: vscode-tkn=first\r\n\r\n"));
        assert!(proxy.cookie_header().is_some());
        proxy.set_upstream(40_000);
        assert!(proxy.cookie_header().is_some(), "the same port is the same server");
        proxy.set_upstream(40_001);
        assert!(proxy.cookie_header().is_none());
    }

    #[test]
    fn only_a_redirect_that_stays_on_this_server_is_followed() {
        // The token in the query string is answered with a cookie and a
        // redirect back to the same path. Following it here is what keeps the
        // page from being handed its own start URL again, forever.
        assert_eq!(same_origin_target("/?ew=true"), Some("/?ew=true".to_owned()));
        assert_eq!(same_origin_target("http://127.0.0.1:40000/x"), Some("/x".to_owned()));
        assert_eq!(same_origin_target("https://example.invalid/"), None);
        assert_eq!(same_origin_target("http://example.invalid/"), None);
    }

    #[test]
    fn no_upstream_is_a_refusal_rather_than_a_connection_attempt() {
        let proxy = EditorProxy::new();
        assert!(proxy.upstream().is_none());
        assert!(proxy.request("GET", "/", &[], &[]).is_none());
    }
}
