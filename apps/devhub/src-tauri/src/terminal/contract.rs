//! The versioned terminal PTY wire contract.
//!
//! This contract intentionally contains only the semantic DevHub surface key
//! and the opaque attachment handle.  tmux socket names, session names,
//! workspace paths, and provider handles are native-only values.  Terminal
//! output is sent as a raw Tauri Channel frame (see [`encode_frame`]); this
//! keeps binary PTY output out of JSON and avoids a second base64 copy.

use std::fmt;

use serde::{Deserialize, Serialize};
use tauri::ipc::InvokeResponseBody;

use devhub_app_core::WorkspaceId;

pub const TERMINAL_PROTOCOL_VERSION: u16 = 1;
pub const MAX_ATTACH_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_OUTPUT_FRAME_BYTES: usize = 32 * 1024;
pub const MAX_OUTPUT_BUFFER_BYTES: usize = 256 * 1024;
pub const MAX_CHANNEL_FRAME_BYTES: usize = 40 * 1024;
pub const MAX_SURFACE_KEY_BYTES: usize = 256;
pub const MAX_ATTACHMENT_COUNT: usize = 1;
pub const MIN_COLS: u16 = 1;
pub const MAX_COLS: u16 = 500;
pub const MIN_ROWS: u16 = 1;
pub const MAX_ROWS: u16 = 500;
pub const MAX_PIXEL: u16 = 10_000;
/// Input, output, and cumulative ACK sequences cross the JavaScript Number
/// boundary and therefore share the exact safe-integer ceiling.
pub const MAX_INPUT_SEQUENCE: u64 = 9_007_199_254_740_991;
/// JavaScript transports generations as a Number; keep the native ledger
/// inside the exact integer range shared by JSON and the TS decoder.
pub const MAX_TARGET_GENERATION: u64 = MAX_INPUT_SEQUENCE;
pub const RESIZE_INTERVAL_MS: u64 = 16;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachRequest {
    pub schema_version: u16,
    pub surface_key: String,
    /// Must be zero on attach. Native allocates the opaque attachment
    /// generation after resolving the active semantic surface.
    pub target_generation: u64,
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachReceipt {
    pub schema_version: u16,
    pub attachment_id: String,
    pub surface_key: String,
    pub target_generation: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputRequest {
    pub schema_version: u16,
    pub surface_key: String,
    pub attachment_id: String,
    pub target_generation: u64,
    pub input_sequence: u64,
    #[serde(deserialize_with = "deserialize_bounded_bytes")]
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResizeRequest {
    pub schema_version: u16,
    pub surface_key: String,
    pub attachment_id: String,
    pub target_generation: u64,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub pixel_width: u16,
    #[serde(default)]
    pub pixel_height: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetachRequest {
    pub schema_version: u16,
    pub surface_key: String,
    pub attachment_id: String,
    pub target_generation: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AckRequest {
    pub schema_version: u16,
    pub surface_key: String,
    pub attachment_id: String,
    pub target_generation: u64,
    pub sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

impl PtySize {
    pub fn validate(self) -> Result<Self, TerminalError> {
        if !(MIN_COLS..=MAX_COLS).contains(&self.cols)
            || !(MIN_ROWS..=MAX_ROWS).contains(&self.rows)
            || self.pixel_width > MAX_PIXEL
            || self.pixel_height > MAX_PIXEL
        {
            return Err(TerminalError::new(TerminalErrorCode::InvalidResize));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameKind {
    Started = 1,
    Output = 2,
    Exited = 3,
    Error = 4,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TerminalFrame {
    Started {
        schema_version: u16,
        attachment_id: String,
        sequence: u64,
        surface_key: String,
        target_generation: u64,
        cols: u16,
        rows: u16,
    },
    /// `bytes` is encoded as the trailing bytes in the raw Channel frame,
    /// never as JSON/base64. The field exists for the logical fixture shape.
    Output {
        schema_version: u16,
        attachment_id: String,
        sequence: u64,
        #[serde(skip)]
        bytes: Vec<u8>,
    },
    Exited {
        schema_version: u16,
        attachment_id: String,
        sequence: u64,
        reason: ExitReason,
    },
    Error {
        schema_version: u16,
        attachment_id: String,
        sequence: u64,
        error: TerminalError,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExitReason {
    Eof,
    Detached,
    ChildExited,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalErrorCode {
    InvalidRequest,
    InvalidSurface,
    SurfaceUnavailable,
    StaleTarget,
    WrongAttachment,
    AttachmentLimit,
    SessionUnavailable,
    PtyUnavailable,
    InputTooLarge,
    InvalidResize,
    ChannelClosed,
    Backpressure,
    RuntimeUnavailable,
    Internal,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalError {
    pub code: TerminalErrorCode,
    pub summary: &'static str,
}

impl TerminalError {
    pub const fn new(code: TerminalErrorCode) -> Self {
        Self { code, summary: code.summary() }
    }

    pub const fn code(&self) -> TerminalErrorCode {
        self.code
    }
}

impl TerminalErrorCode {
    pub const fn summary(self) -> &'static str {
        match self {
            Self::InvalidRequest => "The terminal request is invalid.",
            Self::InvalidSurface => "The selected terminal surface is invalid.",
            Self::SurfaceUnavailable => "The selected terminal surface is unavailable.",
            Self::StaleTarget => "The terminal target is stale.",
            Self::WrongAttachment => "The terminal attachment is not owned by this view.",
            Self::AttachmentLimit => "This terminal surface already has an attachment.",
            Self::SessionUnavailable => "The terminal session is unavailable.",
            Self::PtyUnavailable => "The terminal client could not be attached.",
            Self::InputTooLarge => "Terminal input exceeded the allowed size.",
            Self::InvalidResize => "The terminal size is invalid.",
            Self::ChannelClosed => "The terminal view is disconnected.",
            Self::Backpressure => "Terminal output exceeded the view buffer.",
            Self::RuntimeUnavailable => "The terminal runtime is unavailable.",
            Self::Internal => "The terminal runtime could not complete the request.",
        }
    }
}

impl fmt::Display for TerminalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.summary)
    }
}

impl std::error::Error for TerminalError {}

/// Raw Channel framing. Every message is a complete frame, so the frontend
/// can reject malformed/truncated output without retaining partial PTY data.
/// The fixed header is JSON metadata (bounded by [`MAX_CHANNEL_FRAME_BYTES`])
/// followed by raw output bytes only for an Output frame.
pub fn encode_frame(frame: &TerminalFrame) -> Result<InvokeResponseBody, TerminalError> {
    let kind = match frame {
        TerminalFrame::Started { .. } => FrameKind::Started,
        TerminalFrame::Output { .. } => FrameKind::Output,
        TerminalFrame::Exited { .. } => FrameKind::Exited,
        TerminalFrame::Error { .. } => FrameKind::Error,
    };
    let payload = match frame {
        TerminalFrame::Output { schema_version, attachment_id, sequence, .. } => {
            serde_json::json!({
                "type": "output",
                "schemaVersion": schema_version,
                "attachmentId": attachment_id,
                "sequence": sequence,
            })
        }
        _ => serde_json::to_value(frame)
            .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?,
    };
    let header = serde_json::to_vec(&payload)
        .map_err(|_| TerminalError::new(TerminalErrorCode::Internal))?;
    let output = match frame {
        TerminalFrame::Output { bytes, .. } => bytes.as_slice(),
        _ => &[],
    };
    if output.len() > MAX_OUTPUT_FRAME_BYTES
        || header.len() > MAX_CHANNEL_FRAME_BYTES
        || header.len().saturating_add(output.len()).saturating_add(8) > MAX_CHANNEL_FRAME_BYTES
    {
        return Err(TerminalError::new(TerminalErrorCode::Backpressure));
    }
    let mut encoded = Vec::with_capacity(8 + header.len() + output.len());
    encoded.push(TERMINAL_PROTOCOL_VERSION as u8);
    encoded.push(kind as u8);
    encoded.extend_from_slice(&[0, 0]);
    encoded.extend_from_slice(&(header.len() as u32).to_le_bytes());
    encoded.extend_from_slice(&header);
    encoded.extend_from_slice(output);
    Ok(InvokeResponseBody::Raw(encoded))
}

pub fn validate_schema(schema_version: u16) -> Result<(), TerminalError> {
    if schema_version == TERMINAL_PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(TerminalError::new(TerminalErrorCode::InvalidRequest))
    }
}

pub fn validate_surface_key(value: &str) -> Result<(), TerminalError> {
    if value.is_empty()
        || value.len() > MAX_SURFACE_KEY_BYTES
        || value.bytes().any(|byte| byte == 0 || byte.is_ascii_whitespace())
    {
        return Err(TerminalError::new(TerminalErrorCode::InvalidSurface));
    }
    let valid = value == "global-terminal"
        || value
            .strip_prefix("workspace-terminal:")
            .and_then(|id| WorkspaceId::from_uuid(id.to_owned()).ok())
            .is_some();
    if !valid {
        return Err(TerminalError::new(TerminalErrorCode::InvalidSurface));
    }
    Ok(())
}

pub fn validate_attachment_id(value: &str) -> Result<(), TerminalError> {
    if value.len() != 32 || !value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(TerminalError::new(TerminalErrorCode::WrongAttachment));
    }
    Ok(())
}

pub fn validate_attach_request(request: &AttachRequest) -> Result<(), TerminalError> {
    validate_schema(request.schema_version)?;
    validate_surface_key(&request.surface_key)?;
    // Attach has no caller-selected capability generation. Native allocates
    // the generation only after resolving the current immutable surface.
    if request.target_generation != 0 {
        return Err(TerminalError::new(TerminalErrorCode::InvalidRequest));
    }
    PtySize {
        cols: request.cols,
        rows: request.rows,
        pixel_width: request.pixel_width,
        pixel_height: request.pixel_height,
    }
    .validate()?;
    let estimated = request.surface_key.len().saturating_add(64);
    if estimated > MAX_ATTACH_REQUEST_BYTES {
        return Err(TerminalError::new(TerminalErrorCode::InvalidRequest));
    }
    Ok(())
}

pub fn validate_input(bytes: &[u8]) -> Result<(), TerminalError> {
    if bytes.len() > MAX_INPUT_BYTES {
        Err(TerminalError::new(TerminalErrorCode::InputTooLarge))
    } else {
        Ok(())
    }
}

pub fn validate_input_sequence(sequence: u64) -> Result<(), TerminalError> {
    if !(1..=MAX_INPUT_SEQUENCE).contains(&sequence) {
        Err(TerminalError::new(TerminalErrorCode::InvalidRequest))
    } else {
        Ok(())
    }
}

fn deserialize_bounded_bytes<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct BytesVisitor;

    impl<'de> serde::de::Visitor<'de> for BytesVisitor {
        type Value = Vec<u8>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a bounded byte sequence")
        }

        fn visit_bytes<E>(self, value: &[u8]) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            if value.len() > MAX_INPUT_BYTES {
                return Err(E::invalid_length(value.len(), &self));
            }
            Ok(value.to_owned())
        }

        fn visit_byte_buf<E>(self, value: Vec<u8>) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            if value.len() > MAX_INPUT_BYTES {
                return Err(E::invalid_length(value.len(), &self));
            }
            Ok(value)
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            let mut bytes =
                Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(MAX_INPUT_BYTES));
            while let Some(byte) = sequence.next_element::<u8>()? {
                if bytes.len() >= MAX_INPUT_BYTES {
                    return Err(serde::de::Error::invalid_length(bytes.len() + 1, &self));
                }
                bytes.push(byte);
            }
            Ok(bytes)
        }
    }

    deserializer.deserialize_bytes(BytesVisitor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared_fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../../../contracts/terminal/terminal-v1.fixture.json"
        ))
        .expect("shared terminal fixture")
    }

    #[test]
    fn raw_output_frames_are_bounded_and_not_base64() {
        let frame = TerminalFrame::Output {
            schema_version: TERMINAL_PROTOCOL_VERSION,
            attachment_id: "attachment".to_owned(),
            sequence: 1,
            bytes: vec![0, 1, 2, 255],
        };
        let InvokeResponseBody::Raw(raw) = encode_frame(&frame).expect("frame") else {
            panic!("output must use raw Channel bytes");
        };
        assert!(raw.windows(4).all(|window| window != b"base"));
        assert_eq!(raw[0], TERMINAL_PROTOCOL_VERSION as u8);
        assert_eq!(raw[1], FrameKind::Output as u8);
    }

    #[test]
    fn validation_rejects_untrusted_wire_values() {
        assert!(validate_schema(TERMINAL_PROTOCOL_VERSION).is_ok());
        assert!(validate_schema(2).is_err());
        assert!(
            validate_surface_key("workspace-terminal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").is_ok()
        );
        assert!(validate_surface_key("/tmp/session").is_err());
        assert!(validate_surface_key("workspace terminal").is_err());
        assert!(validate_input(&vec![0; MAX_INPUT_BYTES]).is_ok());
        assert!(validate_input(&vec![0; MAX_INPUT_BYTES + 1]).is_err());
        assert!(validate_input_sequence(1).is_ok());
        assert!(validate_input_sequence(MAX_INPUT_SEQUENCE).is_ok());
        assert!(validate_input_sequence(0).is_err());
        assert!(validate_input_sequence(MAX_INPUT_SEQUENCE.saturating_add(1)).is_err());
        assert!(PtySize { cols: 80, rows: 24, pixel_width: 0, pixel_height: 0 }.validate().is_ok());
        assert!(PtySize { cols: 0, rows: 24, pixel_width: 0, pixel_height: 0 }.validate().is_err());
    }

    #[test]
    fn shared_fixture_keeps_rust_protocol_constants_aligned() {
        let fixture = shared_fixture();
        assert_eq!(fixture["protocolVersion"], TERMINAL_PROTOCOL_VERSION);
        assert_eq!(fixture["headerBytes"], 8);
        assert_eq!(fixture["frameKinds"]["started"], FrameKind::Started as u8);
        assert_eq!(fixture["frameKinds"]["output"], FrameKind::Output as u8);
        assert_eq!(fixture["frameKinds"]["exited"], FrameKind::Exited as u8);
        assert_eq!(fixture["frameKinds"]["error"], FrameKind::Error as u8);
        assert_eq!(fixture["limits"]["maxInputBytes"], MAX_INPUT_BYTES);
        assert_eq!(fixture["limits"]["maxOutputFrameBytes"], MAX_OUTPUT_FRAME_BYTES);
        assert_eq!(fixture["limits"]["maxChannelFrameBytes"], MAX_CHANNEL_FRAME_BYTES);
        assert_eq!(fixture["limits"]["maxSurfaceKeyBytes"], MAX_SURFACE_KEY_BYTES);
        assert_eq!(fixture["limits"]["maxInputSequence"], MAX_INPUT_SEQUENCE);
        assert_eq!(fixture["limits"]["maxTargetGeneration"], MAX_TARGET_GENERATION);
    }
}
