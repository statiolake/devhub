// @generated from contracts/terminal/terminal-v1.fixture.json; DO NOT EDIT.

export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export const MAX_INPUT_BYTES = 65536 as const;
export const MAX_OUTPUT_FRAME_BYTES = 32768 as const;
export const MAX_CHANNEL_FRAME_BYTES = 40960 as const;
export const MAX_SURFACE_KEY_BYTES = 256 as const;
export const MAX_ATTACHMENT_ID_BYTES = 64 as const;
export const MAX_ERROR_SUMMARY_BYTES = 256 as const;
export const MAX_INPUT_SEQUENCE = 9007199254740991 as const;
export const MIN_COLS = 1 as const;
export const MAX_COLS = 500 as const;
export const MIN_ROWS = 1 as const;
export const MAX_ROWS = 500 as const;
export const MAX_PIXEL = 10000 as const;
export const MAX_TARGET_GENERATION = 9007199254740991 as const;

export const TERMINAL_FRAME_KINDS = {
  started: 1,
  output: 2,
  exited: 3,
  error: 4,
} as const;

export type TerminalErrorCode =
  | "invalid_request"
  | "invalid_surface"
  | "surface_unavailable"
  | "stale_target"
  | "wrong_attachment"
  | "attachment_limit"
  | "session_unavailable"
  | "pty_unavailable"
  | "input_too_large"
  | "invalid_resize"
  | "channel_closed"
  | "backpressure"
  | "runtime_unavailable"
  | "internal";

export interface TerminalError {
  readonly code: TerminalErrorCode;
  readonly summary: string;
}

export type ExitReason = "eof" | "detached" | "childExited";

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export interface TerminalAttachRequest extends TerminalSize {
  readonly schemaVersion: 1;
  readonly surfaceKey: string;
  readonly targetGeneration: 0;
}

export interface TerminalAttachReceipt {
  readonly schemaVersion: 1;
  readonly attachmentId: string;
  readonly surfaceKey: string;
  readonly targetGeneration: number;
}

export type TerminalReceipt = TerminalAttachReceipt;

export interface TerminalInputRequest {
  readonly schemaVersion: 1;
  readonly surfaceKey: string;
  readonly attachmentId: string;
  readonly targetGeneration: number;
  readonly inputSequence: number;
  readonly bytes: readonly number[];
}

export interface TerminalResizeRequest extends TerminalSize {
  readonly schemaVersion: 1;
  readonly surfaceKey: string;
  readonly attachmentId: string;
  readonly targetGeneration: number;
}

export interface TerminalAckRequest {
  readonly schemaVersion: 1;
  readonly surfaceKey: string;
  readonly attachmentId: string;
  readonly targetGeneration: number;
  readonly sequence: number;
}

export interface TerminalDetachRequest {
  readonly schemaVersion: 1;
  readonly surfaceKey: string;
  readonly attachmentId: string;
  readonly targetGeneration: number;
}

export interface StartedFrame {
  readonly type: "started";
  readonly schemaVersion: 1;
  readonly attachmentId: string;
  readonly sequence: 0;
  readonly surfaceKey: string;
  readonly targetGeneration: number;
  readonly cols: number;
  readonly rows: number;
}

export interface OutputFrame {
  readonly type: "output";
  readonly schemaVersion: 1;
  readonly attachmentId: string;
  readonly sequence: number;
  readonly bytes: Uint8Array;
}

export interface ExitedFrame {
  readonly type: "exited";
  readonly schemaVersion: 1;
  readonly attachmentId: string;
  readonly sequence: number;
  readonly reason: ExitReason;
}

export interface ErrorFrame {
  readonly type: "error";
  readonly schemaVersion: 1;
  readonly attachmentId: string;
  readonly sequence: number;
  readonly error: TerminalError;
}

export type TerminalFrame =
  StartedFrame | OutputFrame | ExitedFrame | ErrorFrame;
