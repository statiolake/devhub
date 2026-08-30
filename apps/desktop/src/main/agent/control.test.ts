/** Ported from the `control.rs` test module of the Tauri agent adapter. */

import { describe, expect, it } from "vitest";

import {
	appendTerminalBytes,
	encodeControlTerminal,
	encodeHello,
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
