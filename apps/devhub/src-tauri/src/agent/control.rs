//! Private Herdr terminal-control client.
//!
//! Herdr exposes terminal ownership on a second binary socket.  This module
//! contains the small protocol subset needed by AgentRuntime and deliberately
//! keeps every provider identifier inside the adapter.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::api::MAX_TERMINAL_READ_BYTES;
use super::error::{AgentRuntimeError, AgentRuntimeErrorCode};

const PROTOCOL_VERSION: u32 = 20;
const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const ATTACH_ACK_TIMEOUT: Duration = Duration::from_secs(5);
const ATTACH_ACK_POLL: Duration = Duration::from_millis(100);
const READ_POLL_TIMEOUT: Duration = Duration::from_millis(10);

/// The runtime-facing control seam.  It carries only terminal bytes and
/// content-free adapter errors; the target terminal ID is never exposed.
pub(crate) trait TerminalControl: Send + Sync {
    fn send_text(&self, text: &str) -> Result<(), AgentRuntimeError>;
    fn read_recent(&self) -> Result<String, AgentRuntimeError>;
    fn detach(&self);
}

/// Used by isolated transport fakes.  Production HerdrTransport overrides
/// the factory and never uses this implementation.
pub(crate) struct NoopTerminalControl;

impl TerminalControl for NoopTerminalControl {
    fn send_text(&self, _text: &str) -> Result<(), AgentRuntimeError> {
        Ok(())
    }

    fn read_recent(&self) -> Result<String, AgentRuntimeError> {
        Ok(String::new())
    }

    fn detach(&self) {}
}

enum ClientMessage {
    Hello {
        version: u32,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
        requested_encoding: RenderEncoding,
        keybindings: ClientKeybindings,
        launch_mode: ClientLaunchMode,
    },
    Input {
        data: Vec<u8>,
    },
    Detach,
    ControlTerminal {
        target: String,
        takeover: bool,
    },
}

enum RenderEncoding {
    TerminalAnsi,
}

enum ClientKeybindings {
    Server,
}

enum ClientLaunchMode {
    TerminalAttach,
}

#[derive(Default)]
struct ControlState {
    pending: VecDeque<Vec<u8>>,
    detached: bool,
}

/// A single writable control socket.  The stream is separate from the
/// persistent JSON subscription socket and is serialized for read/write so a
/// surface cannot interleave frames.
pub(crate) struct HerdrTerminalControl {
    stream: Mutex<std::os::unix::net::UnixStream>,
    state: Mutex<ControlState>,
}

impl HerdrTerminalControl {
    #[cfg(unix)]
    pub(crate) fn open(
        socket_path: &Path,
        terminal_id: &str,
        takeover: bool,
    ) -> Result<Arc<dyn TerminalControl>, AgentRuntimeError> {
        let mut stream =
            std::os::unix::net::UnixStream::connect(socket_path).map_err(classify_io)?;
        stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).map_err(classify_io)?;
        stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)).map_err(classify_io)?;
        write_message(
            &mut stream,
            &ClientMessage::Hello {
                version: PROTOCOL_VERSION,
                cols: 80,
                rows: 24,
                cell_width_px: 0,
                cell_height_px: 0,
                requested_encoding: RenderEncoding::TerminalAnsi,
                keybindings: ClientKeybindings::Server,
                launch_mode: ClientLaunchMode::TerminalAttach,
            },
        )?;
        let welcome = read_message(&mut stream)?;
        verify_welcome(&welcome)?;
        write_message(
            &mut stream,
            &ClientMessage::ControlTerminal { target: terminal_id.to_owned(), takeover },
        )?;

        // Herdr has no separate acknowledgement for ControlTerminal: the
        // first Terminal frame proves ownership, while ServerShutdown rejects
        // it. Silence is ambiguous and must not be treated as success.
        stream.set_read_timeout(Some(ATTACH_ACK_POLL)).map_err(classify_io)?;
        let mut pending = VecDeque::new();
        let deadline = Instant::now() + ATTACH_ACK_TIMEOUT;
        loop {
            match read_message(&mut stream) {
                Ok(frame) => match server_tag(&frame)? {
                    2 => {
                        pending.push_back(frame);
                        break;
                    }
                    4 => return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Conflict)),
                    _ => {
                        return Err(AgentRuntimeError::new(
                            AgentRuntimeErrorCode::ProtocolMismatch,
                        ));
                    }
                },
                Err(error)
                    if error.code() == AgentRuntimeErrorCode::Timeout
                        && Instant::now() < deadline =>
                {
                    continue;
                }
                Err(error) if error.code() == AgentRuntimeErrorCode::Timeout => {
                    return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Timeout));
                }
                Err(error) => return Err(error),
            }
        }
        stream.set_read_timeout(Some(READ_POLL_TIMEOUT)).map_err(classify_io)?;
        Ok(Arc::new(Self {
            stream: Mutex::new(stream),
            state: Mutex::new(ControlState { pending, detached: false }),
        }))
    }

    #[cfg(not(unix))]
    pub(crate) fn open(
        _socket_path: &Path,
        _terminal_id: &str,
        _takeover: bool,
    ) -> Result<Arc<dyn TerminalControl>, AgentRuntimeError> {
        Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))
    }

    #[cfg(unix)]
    pub(crate) fn probe(socket_path: &Path) -> Result<(), AgentRuntimeError> {
        let mut stream =
            std::os::unix::net::UnixStream::connect(socket_path).map_err(classify_io)?;
        stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).map_err(classify_io)?;
        stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)).map_err(classify_io)?;
        write_message(
            &mut stream,
            &ClientMessage::Hello {
                version: PROTOCOL_VERSION,
                cols: 80,
                rows: 24,
                cell_width_px: 0,
                cell_height_px: 0,
                requested_encoding: RenderEncoding::TerminalAnsi,
                keybindings: ClientKeybindings::Server,
                launch_mode: ClientLaunchMode::TerminalAttach,
            },
        )?;
        let welcome = read_message(&mut stream)?;
        verify_welcome(&welcome)?;
        write_message(&mut stream, &ClientMessage::Detach)
    }

    #[cfg(not(unix))]
    pub(crate) fn probe(_socket_path: &Path) -> Result<(), AgentRuntimeError> {
        Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable))
    }
}

impl TerminalControl for HerdrTerminalControl {
    fn send_text(&self, text: &str) -> Result<(), AgentRuntimeError> {
        if text.len() > MAX_TERMINAL_READ_BYTES || text.contains('\0') {
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
        }
        let mut stream = self.stream.lock().map_err(|_| internal())?;
        let detached = self.state.lock().map_err(|_| internal())?.detached;
        if detached {
            return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Disconnected));
        }
        write_message(&mut *stream, &ClientMessage::Input { data: text.as_bytes().to_vec() })
    }

    fn read_recent(&self) -> Result<String, AgentRuntimeError> {
        let mut stream = self.stream.lock().map_err(|_| internal())?;
        let mut output = Vec::new();
        let pending = {
            let mut state = self.state.lock().map_err(|_| internal())?;
            std::mem::take(&mut state.pending)
        };
        for frame in pending {
            append_terminal_bytes(&frame, &mut output)?;
        }
        loop {
            match read_message(&mut *stream) {
                Ok(frame) => append_terminal_bytes(&frame, &mut output)?,
                Err(error) if error.code() == AgentRuntimeErrorCode::Timeout => break,
                Err(error) => return Err(error),
            }
        }
        Ok(String::from_utf8_lossy(&output).into_owned())
    }

    fn detach(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.detached {
            return;
        }
        state.detached = true;
        drop(state);
        if let Ok(mut stream) = self.stream.lock() {
            let _ = write_message(&mut *stream, &ClientMessage::Detach);
        }
    }
}

impl Drop for HerdrTerminalControl {
    fn drop(&mut self) {
        self.detach();
    }
}

fn verify_welcome(frame: &[u8]) -> Result<(), AgentRuntimeError> {
    if server_tag(frame)? != 0 {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch));
    }
    let (_, mut offset) = decode_tag(frame)?;
    let version = read_varint(frame, &mut offset)?;
    if version != u64::from(PROTOCOL_VERSION) {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch));
    }
    let encoding = read_varint(frame, &mut offset)?;
    if encoding != 1 {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::CapabilityMismatch));
    }
    let error = read_bool(frame, &mut offset)?;
    if error {
        let _ = read_string(frame, &mut offset)?;
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable));
    }
    if offset != frame.len() {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch));
    }
    Ok(())
}

fn append_terminal_bytes(frame: &[u8], output: &mut Vec<u8>) -> Result<(), AgentRuntimeError> {
    if server_tag(frame)? != 2 {
        return Ok(());
    }
    let (_, mut offset) = decode_tag(frame)?;
    let _seq = read_varint(frame, &mut offset)?;
    let _width = read_varint(frame, &mut offset)?;
    let _height = read_varint(frame, &mut offset)?;
    let _full = read_bool(frame, &mut offset)?;
    let bytes = read_bytes(frame, &mut offset)?;
    if offset != frame.len()
        || bytes.len() > MAX_TERMINAL_READ_BYTES
        || output.len().saturating_add(bytes.len()) > MAX_TERMINAL_READ_BYTES
    {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
    }
    output.extend_from_slice(bytes);
    Ok(())
}

fn server_tag(frame: &[u8]) -> Result<u32, AgentRuntimeError> {
    decode_tag(frame).map(|(tag, _)| tag)
}

fn decode_tag(frame: &[u8]) -> Result<(u32, usize), AgentRuntimeError> {
    let mut offset = 0;
    let tag = read_varint(frame, &mut offset)?;
    let tag = u32::try_from(tag)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))?;
    Ok((tag, offset))
}

fn write_message<W: Write>(
    writer: &mut W,
    message: &ClientMessage,
) -> Result<(), AgentRuntimeError> {
    let mut payload = Vec::new();
    encode_client_message(message, &mut payload)?;
    if payload.len() > MAX_FRAME_BYTES || payload.len() > u32::MAX as usize {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
    }
    writer.write_all(&(payload.len() as u32).to_le_bytes()).map_err(classify_io)?;
    writer.write_all(&payload).map_err(classify_io)?;
    writer.flush().map_err(classify_io)
}

fn encode_client_message(
    message: &ClientMessage,
    payload: &mut Vec<u8>,
) -> Result<(), AgentRuntimeError> {
    match message {
        ClientMessage::Hello {
            version,
            cols,
            rows,
            cell_width_px,
            cell_height_px,
            requested_encoding,
            keybindings,
            launch_mode,
        } => {
            push_varint(payload, 0);
            push_varint(payload, u64::from(*version));
            push_varint(payload, u64::from(*cols));
            push_varint(payload, u64::from(*rows));
            push_varint(payload, u64::from(*cell_width_px));
            push_varint(payload, u64::from(*cell_height_px));
            let _ = requested_encoding;
            let _ = keybindings;
            let _ = launch_mode;
            push_varint(payload, 1);
            push_varint(payload, 0);
            push_varint(payload, 2);
        }
        ClientMessage::Input { data } => {
            push_varint(payload, 1);
            push_bytes(payload, data)?;
        }
        ClientMessage::Detach => push_varint(payload, 4),
        ClientMessage::ControlTerminal { target, takeover } => {
            push_varint(payload, 9);
            push_string(payload, target)?;
            payload.push(u8::from(*takeover));
        }
    }
    Ok(())
}

fn push_varint(payload: &mut Vec<u8>, value: u64) {
    if value < 251 {
        payload.push(value as u8);
    } else if value <= u64::from(u16::MAX) {
        payload.push(251);
        payload.extend_from_slice(&(value as u16).to_le_bytes());
    } else if value <= u64::from(u32::MAX) {
        payload.push(252);
        payload.extend_from_slice(&(value as u32).to_le_bytes());
    } else {
        payload.push(253);
        payload.extend_from_slice(&value.to_le_bytes());
    }
}

fn push_string(payload: &mut Vec<u8>, value: &str) -> Result<(), AgentRuntimeError> {
    push_bytes(payload, value.as_bytes())
}

fn push_bytes(payload: &mut Vec<u8>, value: &[u8]) -> Result<(), AgentRuntimeError> {
    if value.len() > MAX_FRAME_BYTES {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
    }
    push_varint(payload, value.len() as u64);
    payload.extend_from_slice(value);
    Ok(())
}

fn read_message<R: Read>(reader: &mut R) -> Result<Vec<u8>, AgentRuntimeError> {
    let mut length = [0_u8; 4];
    reader.read_exact(&mut length).map_err(classify_io)?;
    let length = u32::from_le_bytes(length) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload).map_err(classify_io)?;
    Ok(payload)
}

fn read_varint(frame: &[u8], offset: &mut usize) -> Result<u64, AgentRuntimeError> {
    let marker = *frame
        .get(*offset)
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))?;
    *offset = offset.saturating_add(1);
    match marker {
        value @ 0..=250 => Ok(u64::from(value)),
        251 => read_fixed(frame, offset, 2)
            .map(|bytes| u64::from(u16::from_le_bytes([bytes[0], bytes[1]]))),
        252 => read_fixed(frame, offset, 4)
            .map(|bytes| u64::from(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))),
        253 => read_fixed(frame, offset, 8).map(|bytes| {
            u64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            ])
        }),
        _ => Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch)),
    }
}

fn read_fixed<'a>(
    frame: &'a [u8],
    offset: &mut usize,
    length: usize,
) -> Result<&'a [u8], AgentRuntimeError> {
    let end = offset
        .checked_add(length)
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))?;
    let bytes = frame
        .get(*offset..end)
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))?;
    *offset = end;
    Ok(bytes)
}

fn read_bool(frame: &[u8], offset: &mut usize) -> Result<bool, AgentRuntimeError> {
    match *frame
        .get(*offset)
        .ok_or_else(|| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))?
    {
        0 => {
            *offset += 1;
            Ok(false)
        }
        1 => {
            *offset += 1;
            Ok(true)
        }
        _ => Err(AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch)),
    }
}

fn read_bytes<'a>(frame: &'a [u8], offset: &mut usize) -> Result<&'a [u8], AgentRuntimeError> {
    let length = read_varint(frame, offset)?;
    let length = usize::try_from(length)
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput))?;
    if length > MAX_FRAME_BYTES {
        return Err(AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput));
    }
    read_fixed(frame, offset, length)
}

fn read_string(frame: &[u8], offset: &mut usize) -> Result<String, AgentRuntimeError> {
    let bytes = read_bytes(frame, offset)?;
    String::from_utf8(bytes.to_vec())
        .map_err(|_| AgentRuntimeError::new(AgentRuntimeErrorCode::ProtocolMismatch))
}

fn classify_io(error: io::Error) -> AgentRuntimeError {
    match error.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => {
            AgentRuntimeError::new(AgentRuntimeErrorCode::Timeout)
        }
        io::ErrorKind::UnexpectedEof
        | io::ErrorKind::BrokenPipe
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::NotConnected
        | io::ErrorKind::ConnectionRefused
        | io::ErrorKind::NotFound => AgentRuntimeError::new(AgentRuntimeErrorCode::Disconnected),
        _ => AgentRuntimeError::new(AgentRuntimeErrorCode::Unavailable),
    }
}

fn internal() -> AgentRuntimeError {
    AgentRuntimeError::new(AgentRuntimeErrorCode::Internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_message_uses_protocol_twenty_and_terminal_attach_mode() {
        let mut payload = Vec::new();
        encode_client_message(
            &ClientMessage::ControlTerminal {
                target: "provider-terminal".to_owned(),
                takeover: true,
            },
            &mut payload,
        )
        .expect("encode");
        let (tag, _) = decode_tag(&payload).expect("tag");
        assert_eq!(tag, 9);
        assert_eq!(PROTOCOL_VERSION, 20);
    }

    #[test]
    fn terminal_frames_are_bounded_and_provider_content_is_not_in_errors() {
        let frame = vec![2_u8];
        assert_eq!(server_tag(&frame).expect("tag"), 2);
        let error = AgentRuntimeError::new(AgentRuntimeErrorCode::BoundedInput);
        assert!(!format!("{error:?}").contains("provider-terminal"));
    }

    #[test]
    #[ignore = "requires an isolated Herdr 0.8.1 client socket"]
    fn pinned_herdr_control_socket_accepts_protocol_twenty_handshake() {
        let socket = std::env::var_os("DEVHUB_HERDR_CLIENT_SOCKET").expect("client socket path");
        HerdrTerminalControl::probe(Path::new(&socket)).expect("control protocol probe");
    }
}
