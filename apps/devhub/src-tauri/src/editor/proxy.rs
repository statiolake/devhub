//! The Editor origin's transport.
//!
//! Surfaces are served from a fixed custom scheme so the browser's per-origin
//! storage survives a server that binds a different port every run. Nothing
//! here knows anything about VS Code: a request that arrives on the scheme is
//! replayed against the loopback server and its response is handed back as it
//! came. The one piece of state is the session cookie the server issues in
//! exchange for the connection token, which later requests have to carry.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
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
/// One cookie the origin holds, and whether the server asked for it to outlive
/// the session that set it.
#[derive(Clone, PartialEq, Eq)]
struct Cookie {
    name: String,
    value: String,
    durable: bool,
}

#[derive(Default)]
pub struct EditorProxy {
    port: AtomicU16,
    cookies: Mutex<Vec<Cookie>>,
    token: Mutex<Option<String>>,
    /// Where the durable cookies are kept between runs. Absent in tests that
    /// have no provider directory to write into.
    session_file: Mutex<Option<PathBuf>>,
}

impl EditorProxy {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read back the cookies a previous run left behind.
    ///
    /// Called once the provider directory is known. A jar that starts empty
    /// every launch is a new encryption key every launch, and every secret the
    /// Workbench stored under the old one — the signed-in account included —
    /// becomes unreadable.
    pub fn restore(&self, path: &Path) {
        if let Ok(mut file) = self.session_file.lock() {
            *file = Some(path.to_path_buf());
        }
        let Ok(contents) = fs::read_to_string(path) else { return };
        let Ok(mut cookies) = self.cookies.lock() else { return };
        for line in contents.lines() {
            if let Some((name, value)) = line.split_once('=') {
                cookies.push(Cookie {
                    name: name.to_owned(),
                    value: value.to_owned(),
                    durable: true,
                });
            }
        }
    }

    /// Point the origin at a server.
    ///
    /// The cookies are not dropped with the server that issued them. The one
    /// that is only good for a single server — the connection token — is
    /// replaced on the first request, because the document's own URL carries
    /// the current token and the server answers it with a fresh cookie before
    /// anything else is fetched.
    pub fn set_upstream(&self, port: u16, token: &str) {
        if let Ok(mut current) = self.token.lock() {
            *current = Some(token.to_owned());
        }
        self.port.store(port, Ordering::Release);
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
        // A redirect is followed here, so whatever it set on the way past has
        // to be carried to the end of the chain. Dropping it would hand the
        // page a document whose session it was never told about.
        let mut carried = Vec::new();
        for _ in 0..=MAX_REDIRECTS {
            let mut response = self.round_trip(method, &target, headers, body)?;
            self.remember_cookies(&response);
            let redirect = matches!(response.status, 301 | 302 | 303 | 307 | 308);
            let location = redirect.then(|| header(&response, "location")).flatten();
            // Only a redirect that stays on this server can be followed
            // silently; anything else is the page's business, not ours.
            let next = location.as_deref().and_then(same_origin_target);
            let Some(next) = next else {
                response.headers.splice(0..0, carried);
                self.prepare_document(&mut response);
                return Some(response);
            };
            carried.extend(
                response
                    .headers
                    .into_iter()
                    .filter(|(name, _)| name.eq_ignore_ascii_case("set-cookie")),
            );
            target = next;
        }
        None
    }

    /// Give the document the two things a custom scheme takes away from it.
    ///
    /// WebKit gives a page on a non-HTTP scheme no cookies at all: the ones
    /// its own handler sets never arrive, and writes to `document.cookie` are
    /// dropped without an error. The Workbench depends on cookies twice over —
    /// for the token its WebSocket authenticates with, and for the key path
    /// that decides whether stored secrets can be encrypted at all — so both
    /// are put back here, from the jar this proxy keeps on its behalf.
    fn prepare_document(&self, response: &mut ProxyResponse) {
        if !header(response, "content-type")
            .is_some_and(|value| value.to_ascii_lowercase().contains("text/html"))
        {
            return;
        }
        let Ok(document) = std::str::from_utf8(&response.body) else { return };
        let mut document = document.to_owned();
        self.inject_connection_token(&mut document);
        self.inject_cookie_jar(&mut document, header(response, "content-security-policy"));
        response.body = document.into_bytes();
    }

    /// The client authenticates its WebSocket with a token from its injected
    /// configuration, falling back to a cookie. The server leaves the key out
    /// and relies on the cookie, which is a same-origin arrangement this proxy
    /// is not.
    fn inject_connection_token(&self, document: &mut String) {
        const ANCHOR: &str = "data-settings=\"{";
        if document.contains("connectionToken") {
            return;
        }
        let Ok(token) = self.token.lock() else { return };
        let Some(token) = token.as_deref() else { return };
        let Some(anchor) = document.find(ANCHOR) else { return };
        document.insert_str(
            anchor + ANCHOR.len(),
            &format!("&quot;connectionToken&quot;:&quot;{token}&quot;,"),
        );
    }

    /// Restore `document.cookie` from the jar.
    ///
    /// The accessor is replaced rather than supplemented, because there is
    /// nothing to supplement: on this scheme the property is permanently
    /// empty. The script is inline, so it needs the nonce the server put in
    /// its own policy; without one there is nothing safe to do but leave the
    /// document alone.
    fn inject_cookie_jar(&self, document: &mut String, policy: Option<String>) {
        let Some(nonce) = policy.as_deref().and_then(script_nonce) else { return };
        let Some(jar) = self.cookie_header() else { return };
        if jar.contains('\'') || jar.contains('\\') || jar.contains('<') {
            return;
        }
        let script = format!(
            "<script nonce=\"{nonce}\">(function(){{var j='{jar}';\
             try{{Object.defineProperty(Document.prototype,'cookie',{{configurable:true,\
             get:function(){{return j;}},set:function(v){{var p=String(v).split(';')[0];\
             var n=p.split('=')[0];var k=j?j.split('; '):[];\
             k=k.filter(function(c){{return c.split('=')[0]!==n;}});k.push(p);\
             j=k.join('; ');}}}});}}catch(e){{}}}})();</script>"
        );
        let anchor = document
            .find("<head>")
            .map(|index| index + "<head>".len())
            .or_else(|| document.find("<script"));
        let Some(anchor) = anchor else { return };
        document.insert_str(anchor, &script);
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
                .map(|cookie| format!("{}={}", cookie.name, cookie.value))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    fn remember_cookies(&self, response: &ProxyResponse) {
        let Ok(mut cookies) = self.cookies.lock() else { return };
        let mut changed = false;
        for (name, value) in &response.headers {
            if !name.eq_ignore_ascii_case("set-cookie") {
                continue;
            }
            let (pair, attributes) = value.split_once(';').unwrap_or((value.as_str(), ""));
            let Some((key, cookie)) = pair.trim().split_once('=') else { continue };
            let next = Cookie {
                name: key.trim().to_owned(),
                value: cookie.trim().to_owned(),
                durable: has_lifetime(attributes),
            };
            match cookies.iter_mut().find(|existing| existing.name == next.name) {
                Some(slot) => {
                    if *slot != next {
                        changed |= slot.durable || next.durable;
                        *slot = next;
                    }
                }
                None => {
                    changed |= next.durable;
                    cookies.push(next);
                }
            }
        }
        if changed {
            self.persist(&cookies);
        }
    }

    /// Write the cookies the server asked to outlive this run. A session
    /// cookie is not one of them, by its own definition.
    fn persist(&self, cookies: &[Cookie]) {
        let Ok(path) = self.session_file.lock() else { return };
        let Some(path) = path.as_ref() else { return };
        let mut contents = String::new();
        for cookie in cookies.iter().filter(|cookie| cookie.durable) {
            if cookie.name.contains('=') || cookie.value.contains('\n') {
                continue;
            }
            contents.push_str(&format!("{}={}\n", cookie.name, cookie.value));
        }
        let temporary = path.with_extension("tmp");
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let written = options
            .open(&temporary)
            .and_then(|mut file| file.write_all(contents.as_bytes()).map(|()| file))
            .and_then(|file| file.sync_all());
        if written.is_ok() {
            let _ = fs::rename(&temporary, path);
        } else {
            let _ = fs::remove_file(&temporary);
        }
    }
}

/// Whether a `Set-Cookie` asked to survive the session that set it.
fn has_lifetime(attributes: &str) -> bool {
    attributes.split(';').any(|attribute| {
        let name = attribute.split('=').next().unwrap_or_default().trim();
        name.eq_ignore_ascii_case("max-age") || name.eq_ignore_ascii_case("expires")
    })
}

/// The nonce the server's own policy authorises inline scripts with.
fn script_nonce(policy: &str) -> Option<&str> {
    let start = policy.find("'nonce-")? + "'nonce-".len();
    let rest = &policy[start..];
    let end = rest.find('\'')?;
    let nonce = &rest[..end];
    nonce
        .chars()
        .all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '+' | '/' | '=')
        })
        .then_some(nonce)
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
    fn a_server_that_moves_does_not_take_the_stored_session_with_it() {
        // VS Code Web encrypts its stored secrets with a key it splits between
        // the server and a month-long cookie. Dropping that cookie because the
        // server moved would mean a new key every launch, and a signed-in
        // account that cannot be read back.
        let proxy = EditorProxy::new();
        proxy.set_upstream(40_000, "abab");
        proxy.remember_cookies(&response(
            "HTTP/1.1 200 OK\r\nset-cookie: vscode-cli-secret-half=half; Max-Age=2592000\r\n\r\n",
        ));
        proxy.set_upstream(40_001, "cdcd");
        assert_eq!(proxy.cookie_header().expect("cookies"), "vscode-cli-secret-half=half");
    }

    #[test]
    fn only_the_cookies_asked_to_outlive_the_run_are_written_down() {
        let directory = std::env::temp_dir().join(format!(
            "devhub-editor-session-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&directory).expect("directory");
        let path = directory.join("web-session");

        let proxy = EditorProxy::new();
        proxy.restore(&path);
        proxy.remember_cookies(&response(
            "HTTP/1.1 200 OK\r\nset-cookie: vscode-cli-secret-half=half; Max-Age=2592000\r\n\
             set-cookie: vscode-secret-key-path=/mint; SameSite=Strict\r\n\r\n",
        ));
        let written = fs::read_to_string(&path).expect("session file");
        assert_eq!(written, "vscode-cli-secret-half=half\n", "a session cookie is not durable");

        // A later run reads it back and speaks for the same stored secrets.
        let relaunched = EditorProxy::new();
        relaunched.restore(&path);
        assert_eq!(relaunched.cookie_header().expect("cookies"), "vscode-cli-secret-half=half");

        fs::remove_dir_all(&directory).expect("cleanup");
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
    fn the_workbench_document_is_given_the_token_its_socket_will_be_asked_for() {
        // The client authenticates its WebSocket with the token from its
        // injected configuration, or failing that the `vscode-tkn` cookie. The
        // socket goes straight to the loopback server from a document on
        // another scheme, so no cookie reaches it and the client would send the
        // placeholder the server refuses as an auth mismatch.
        let proxy = EditorProxy::new();
        proxy.set_upstream(40_000, "abab");
        let mut document = response(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n             <html><div data-settings=\"{&quot;remoteAuthority&quot;:&quot;127.0.0.1:40000&quot;}\"></div>",
        );
        proxy.prepare_document(&mut document);
        let body = String::from_utf8(document.body).expect("utf8");
        assert!(
            body.contains("data-settings=\"{&quot;connectionToken&quot;:&quot;abab&quot;,&quot;remoteAuthority&quot;"),
            "the token belongs at the front of the settings object: {body}"
        );

        // A document that already carries one is left exactly as it is.
        let mut already = response(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n             <div data-settings=\"{&quot;connectionToken&quot;:&quot;server&quot;}\"></div>",
        );
        let before = already.body.clone();
        proxy.prepare_document(&mut already);
        assert_eq!(already.body, before);

        // Everything that is not the document is passed through untouched.
        let mut script = response(
            "HTTP/1.1 200 OK\r\ncontent-type: text/javascript\r\n\r\ndata-settings=\"{x}\"",
        );
        let before = script.body.clone();
        proxy.prepare_document(&mut script);
        assert_eq!(script.body, before);
    }

    #[test]
    fn the_document_is_handed_a_cookie_jar_it_would_otherwise_never_have() {
        // WebKit gives a page on a non-HTTP scheme no cookies at all — the
        // handler's own `Set-Cookie` never arrives and writes are dropped
        // silently. The Workbench reads `document.cookie` to find the key path
        // that decides whether stored secrets can be encrypted, and without it
        // falls back to keeping them in memory, which is a sign-in that does
        // not survive a reload.
        let proxy = EditorProxy::new();
        proxy.set_upstream(40_000, "abab");
        proxy.remember_cookies(&response(
            "HTTP/1.1 200 OK\r\nset-cookie: vscode-secret-key-path=/mint; SameSite=Strict\r\n\r\n",
        ));
        let mut document = response(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n             content-security-policy: script-src 'self' 'nonce-1nline-m4p'\r\n\r\n             <html><head></head><body></body></html>",
        );
        proxy.prepare_document(&mut document);
        let body = String::from_utf8(document.body).expect("utf8");
        assert!(body.contains("<head><script nonce=\"1nline-m4p\">"), "{body}");
        assert!(body.contains("vscode-secret-key-path=/mint"), "{body}");

        // Without a nonce of the server's own there is nothing safe to inject,
        // so the document is left exactly as it came.
        let mut unpoliced = response(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n<html><head></head></html>",
        );
        let before = unpoliced.body.clone();
        proxy.prepare_document(&mut unpoliced);
        assert_eq!(unpoliced.body, before);
    }

    #[test]
    fn a_policy_nonce_is_only_taken_when_it_is_one() {
        assert_eq!(script_nonce("script-src 'self' 'nonce-abc123'"), Some("abc123"));
        assert_eq!(script_nonce("script-src 'self'"), None);
        assert_eq!(script_nonce("script-src 'nonce-\"><script>'"), None);
    }

    #[test]
    fn no_upstream_is_a_refusal_rather_than_a_connection_attempt() {
        let proxy = EditorProxy::new();
        assert!(proxy.upstream().is_none());
        assert!(proxy.request("GET", "/", &[], &[]).is_none());
    }
}
