//! Authenticated OpenVSCode readiness probing.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use super::error::{EditorError, EditorErrorCode, EditorResult};
use super::token::SecretToken;
use super::url::EditorOrigin;

pub trait ReadinessProbe: Send + Sync {
    fn wait_ready(
        &self,
        origin: EditorOrigin,
        token: &SecretToken,
        timeout: Duration,
    ) -> EditorResult<()>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemReadinessProbe;

impl ReadinessProbe for SystemReadinessProbe {
    fn wait_ready(
        &self,
        origin: EditorOrigin,
        token: &SecretToken,
        timeout: Duration,
    ) -> EditorResult<()> {
        let deadline = Instant::now() + timeout;
        let mut last_error = None;
        while Instant::now() < deadline {
            match authenticated_http(origin, token)
                .and_then(|_| authenticated_websocket(origin, token))
            {
                Ok(()) => return Ok(()),
                Err(error) => last_error = Some(error),
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = last_error;
        Err(EditorError::new(EditorErrorCode::ReadinessTimeout))
    }
}

fn authenticated_http(origin: EditorOrigin, token: &SecretToken) -> EditorResult<()> {
    let mut stream = connect(origin)?;
    write_request(&mut stream, origin, token, false)?;
    expect_http_ready(&mut stream)
}

fn authenticated_websocket(origin: EditorOrigin, token: &SecretToken) -> EditorResult<()> {
    let mut stream = connect(origin)?;
    write_request(&mut stream, origin, token, true)?;
    expect_websocket_upgrade(&mut stream)
}

fn connect(origin: EditorOrigin) -> EditorResult<TcpStream> {
    (super::paths::LOOPBACK_HOST, origin.port())
        .to_socket_addrs()
        .map_err(|_| EditorError::new(EditorErrorCode::ProcessUnavailable))?
        .find_map(|address| TcpStream::connect_timeout(&address, Duration::from_millis(250)).ok())
        .ok_or_else(|| EditorError::new(EditorErrorCode::ProcessUnavailable))
}

fn write_request(
    stream: &mut TcpStream,
    origin: EditorOrigin,
    token: &SecretToken,
    websocket: bool,
) -> EditorResult<()> {
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .and_then(|_| stream.set_write_timeout(Some(Duration::from_millis(500))))
        .map_err(EditorError::from)?;
    let upgrade = if websocket {
        "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
    } else {
        "Connection: close\r\n"
    };
    let request = format!(
        "GET /?tkn={} HTTP/1.1\r\nHost: {}\r\n{}\r\n",
        token.hex(),
        origin.authority(),
        upgrade
    );
    stream.write_all(request.as_bytes()).map_err(EditorError::from)
}

fn expect_http_ready<R: Read>(stream: &mut R) -> EditorResult<()> {
    let response = read_headers(stream)?;
    let mut lines = response.split("\r\n");
    let status_line = lines.next().ok_or_else(probe_failed)?;
    let mut fields = status_line.splitn(3, ' ');
    if fields.next() != Some("HTTP/1.1") {
        return Err(probe_failed());
    }
    let status =
        fields.next().and_then(|value| value.parse::<u16>().ok()).ok_or_else(probe_failed)?;
    if status == 200 {
        return Ok(());
    }
    // OpenVSCode 1.109.5 authenticates the initial query-string request by
    // setting its cookie and redirecting to the root document. The redirect
    // is a successful authenticated HTTP readiness response; constrain it to
    // the provider-owned root so an arbitrary redirect cannot pass readiness.
    if status == 302 && lines.any(|line| line.strip_prefix("Location:").map(str::trim) == Some("/"))
    {
        return Ok(());
    }
    Err(probe_failed())
}

fn expect_websocket_upgrade<R: Read>(stream: &mut R) -> EditorResult<()> {
    let response = read_headers(stream)?;
    let mut lines = response.split("\r\n");
    let status_line = lines.next().ok_or_else(probe_failed)?;
    let mut fields = status_line.splitn(3, ' ');
    if fields.next() != Some("HTTP/1.1") || fields.next() != Some("101") {
        return Err(probe_failed());
    }

    let mut upgrade = false;
    let mut connection = false;
    let mut accept = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(probe_failed());
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("upgrade") {
            upgrade = value.eq_ignore_ascii_case("websocket");
        } else if name.eq_ignore_ascii_case("connection") {
            connection = value.split(',').any(|part| part.trim().eq_ignore_ascii_case("upgrade"));
        } else if name.eq_ignore_ascii_case("sec-websocket-accept") {
            accept = Some(value);
        }
    }

    if upgrade && connection && accept == Some("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") {
        Ok(())
    } else {
        Err(probe_failed())
    }
}

fn read_headers<R: Read>(stream: &mut R) -> EditorResult<String> {
    const MAX_HEADERS: usize = 16 * 1024;
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 512];
    while bytes.len() < MAX_HEADERS {
        let read = stream.read(&mut chunk).map_err(EditorError::from)?;
        if read == 0 {
            break;
        }
        let remaining = MAX_HEADERS.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..read.min(remaining)]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            let end = bytes
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| index + 4)
                .ok_or_else(probe_failed)?;
            return String::from_utf8(bytes[..end].to_vec()).map_err(|_| probe_failed());
        }
    }
    Err(probe_failed())
}

fn probe_failed() -> EditorError {
    EditorError::new(EditorErrorCode::ProcessUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct FakeProbe {
        calls: Arc<Mutex<u8>>,
        result: EditorResult<()>,
    }

    impl ReadinessProbe for FakeProbe {
        fn wait_ready(
            &self,
            _origin: EditorOrigin,
            _token: &SecretToken,
            _timeout: Duration,
        ) -> EditorResult<()> {
            *self.calls.lock().expect("calls") += 1;
            self.result.clone()
        }
    }

    #[test]
    fn injected_probe_is_deterministic_without_network() {
        let calls = Arc::new(Mutex::new(0));
        let probe = FakeProbe { calls: calls.clone(), result: Ok(()) };
        let token = SecretToken::from_bytes_for_test([0; 32]);
        probe
            .wait_ready(EditorOrigin::new(54945).expect("origin"), &token, Duration::from_millis(1))
            .expect("ready");
        assert_eq!(*calls.lock().expect("calls"), 1);
    }

    #[test]
    fn status_parser_rejects_partial_or_wrong_status() {
        let mut stream = std::io::Cursor::new(b"HTTP/1.1 2000 OK\r\n\r\n".to_vec());
        assert!(expect_http_ready(&mut stream).is_err());
    }

    #[test]
    fn http_readiness_accepts_pinned_provider_root_redirect() {
        let mut stream = std::io::Cursor::new(
            b"HTTP/1.1 302 Found\r\nLocation: /\r\nSet-Cookie: vscode-tkn=redacted\r\n\r\n"
                .to_vec(),
        );
        expect_http_ready(&mut stream).expect("provider root redirect is ready");
    }

    #[test]
    fn http_readiness_rejects_external_redirect() {
        let mut stream = std::io::Cursor::new(
            b"HTTP/1.1 302 Found\r\nLocation: https://example.invalid\r\n\r\n".to_vec(),
        );
        assert!(expect_http_ready(&mut stream).is_err());
    }

    #[test]
    fn websocket_parser_requires_upgrade_headers_and_exact_accept() {
        let mut stream = std::io::Cursor::new(
            b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n".to_vec(),
        );
        assert!(expect_websocket_upgrade(&mut stream).is_err());
    }
}
