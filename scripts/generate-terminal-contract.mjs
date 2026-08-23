#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixturePath = resolve(
  root,
  "contracts/terminal/terminal-v1.fixture.json",
);
const outputPath = resolve(
  root,
  "apps/devhub/src/terminal/generated-contract.ts",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const union = (values) => {
  const serialized = values.map((value) => JSON.stringify(value));
  return serialized.length > 5
    ? `\n  | ${serialized.join("\n  | ")}`
    : serialized.join(" | ");
};
const constant = (name, value) => `export const ${name} = ${value} as const;`;
const limits = fixture.limits;

const generated = `// @generated from contracts/terminal/terminal-v1.fixture.json; DO NOT EDIT.

${constant("TERMINAL_PROTOCOL_VERSION", fixture.protocolVersion)}
${constant("MAX_INPUT_BYTES", limits.maxInputBytes)}
${constant("MAX_OUTPUT_FRAME_BYTES", limits.maxOutputFrameBytes)}
${constant("MAX_CHANNEL_FRAME_BYTES", limits.maxChannelFrameBytes)}
${constant("MAX_SURFACE_KEY_BYTES", limits.maxSurfaceKeyBytes)}
${constant("MAX_ATTACHMENT_ID_BYTES", limits.maxAttachmentIdBytes)}
${constant("MAX_ERROR_SUMMARY_BYTES", limits.maxErrorSummaryBytes)}
${constant("MAX_INPUT_SEQUENCE", limits.maxInputSequence)}
${constant("MIN_COLS", limits.minCols)}
${constant("MAX_COLS", limits.maxCols)}
${constant("MIN_ROWS", limits.minRows)}
${constant("MAX_ROWS", limits.maxRows)}
${constant("MAX_PIXEL", limits.maxPixel)}
${constant("MAX_TARGET_GENERATION", limits.maxTargetGeneration)}

export const TERMINAL_FRAME_KINDS = {
  started: ${fixture.frameKinds.started},
  output: ${fixture.frameKinds.output},
  exited: ${fixture.frameKinds.exited},
  error: ${fixture.frameKinds.error},
} as const;

export type TerminalErrorCode =${union(fixture.errors.codes)};

export interface TerminalError {
  readonly code: TerminalErrorCode;
  readonly summary: string;
}

export type ExitReason = ${union(fixture.exitReasons)};

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
  | StartedFrame
  | OutputFrame
  | ExitedFrame
  | ErrorFrame;
`;

if (process.argv.includes("--check")) {
  const existing = readFileSync(outputPath, "utf8");
  if (existing !== generated) {
    console.error(`terminal contract is stale: ${outputPath}`);
    process.exit(1);
  }
  console.log("terminal contract generation: PASS");
} else {
  writeFileSync(outputPath, generated);
  console.log(`generated ${outputPath}`);
}
