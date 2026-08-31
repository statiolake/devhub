/** Ported from the `control.rs` test module of the Tauri agent adapter. */

import { describe, expect, it } from "vitest";

import {
	appendTerminalBytes,
	encodeControlTerminal,
	encodeHello,
	encodeScroll,
	pushBytes,
	pushVarint,
	serverTag,
	verifyWelcome,
} from "./control.js";
import { AgentRuntimeErrorCode, agentError } from "./error.js";
import { HERDR_PROTOCOL_VERSION } from "./contract.js";

describe("the Herdr control protocol", () => {
	it("uses protocol twenty and the terminal-attach launch mode", () => {
		const payload = encodeControlTerminal("provider-terminal", true);
		expect(serverTag(payload)).toBe(9);
		expect(HERDR_PROTOCOL_VERSION).toBe(20);
		// Hello: tag, version, cols, rows, cell w, cell h, encoding,
		// keybindings, launch mode = TerminalAttach (2).
		const hello = encodeHello();
		expect([...hello]).toEqual([0, 20, 80, 24, 0, 0, 1, 0, 2]);
	});

	it("asks Herdr to scroll rather than sending the wheel as input", () => {
		// AttachScroll: tag 6, source Wheel (0), direction, lines, Some(column),
		// Some(row), then the modifier bitset as a single byte. Herdr decides
		// from there whether the notch reaches the agent as a mouse report, as
		// arrow keys, or as a move of its own scrollback — which is why this is
		// a frame of its own and not encoded mouse bytes on the input path.
		expect([...encodeScroll("up", 3, 12, 7, 0)]).toEqual([
			6, 0, 0, 3, 1, 12, 1, 7, 0,
		]);
		expect([...encodeScroll("down", 1, 0, 0, 0b111)]).toEqual([
			6, 0, 1, 1, 1, 0, 1, 0, 0b111,
		]);
		// A count past the one-byte varint boundary still encodes as a varint,
		// while the modifiers stay one raw byte.
		expect([...encodeScroll("down", 300, 0, 0, 2)]).toEqual([
			6, 0, 1, 251, 44, 1, 1, 0, 1, 0, 2,
		]);
	});

	it("accepts only a protocol-twenty ANSI welcome", () => {
		expect(() => verifyWelcome(Buffer.from([0, 20, 1, 0]))).not.toThrow();
		expect(() => verifyWelcome(Buffer.from([0, 19, 1, 0]))).toThrow(
			/protocol mismatch/,
		);
		expect(() => verifyWelcome(Buffer.from([0, 20, 2, 0]))).toThrow(
			/capability mismatch/,
		);
	});

	it("keeps terminal frames bounded and errors free of provider content", () => {
		expect(serverTag(Buffer.from([2]))).toBe(2);
		const error = agentError(AgentRuntimeErrorCode.BoundedInput);
		expect(`${error.stack}${error.message}`).not.toContain("provider-terminal");
	});

	it("preserves non-UTF-8 control bytes in a terminal frame", () => {
		const bytes = Uint8Array.from([0, 0xff, 0x1b, 0x5b, 0x32, 0x4a]);
		const frame: number[] = [];
		pushVarint(frame, 2); // Terminal frame
		pushVarint(frame, 7); // provider sequence
		pushVarint(frame, 80); // width
		pushVarint(frame, 24); // height
		frame.push(0); // not a full redraw
		pushBytes(frame, bytes);

		const output: Buffer[] = [];
		appendTerminalBytes(Buffer.from(frame), output);
		expect([...Buffer.concat(output)]).toEqual([...bytes]);
	});

	it("ignores a frame that is not a terminal frame", () => {
		const output: Buffer[] = [];
		appendTerminalBytes(Buffer.from([4, 0]), output);
		expect(output).toHaveLength(0);
	});
});
