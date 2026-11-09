import { describe, expect, it } from "vitest";
import { controlArgv } from "../main/terminal/attachments.js";
import {
	WORKSPACE_TERMINAL_SURFACE_PREFIX,
	validateAttachRequest,
} from "./terminal.js";
import { validateControlRequest } from "./terminalControl.js";

const SURFACE = `${WORKSPACE_TERMINAL_SURFACE_PREFIX}0b7c8e2a-4f1d-4c3e-9a6b-2d5e8f1a3c4b`;
const identity = {
	surfaceKey: SURFACE,
	attachmentId: "0123456789abcdef0123456789abcdef",
	targetGeneration: 3,
};
const attach = {
	schemaVersion: 1,
	surfaceKey: SURFACE,
	targetGeneration: 0,
	cols: 80,
	rows: 24,
	pixelWidth: 640,
	pixelHeight: 480,
};

describe("control-mode requests", () => {
	it("attaches a control client only when asked, and only by that name", () => {
		expect(validateAttachRequest(attach).mode).toBeUndefined();
		expect(validateAttachRequest({ ...attach, mode: "control" }).mode).toBe(
			"control",
		);
		expect(() => validateAttachRequest({ ...attach, mode: "pty" })).toThrow();
	});

	it("takes the page's messages of the shapes it knows", () => {
		const keys = validateControlRequest({
			...identity,
			message: { kind: "keys", keys: ["C-b", "z"] },
		});
		expect(keys).toEqual({
			...identity,
			message: { kind: "keys", keys: ["C-b", "z"] },
		});
		const bytes = validateControlRequest({
			...identity,
			message: { kind: "bytes", pane: 4, bytes: new Uint8Array([104, 105]) },
		});
		expect(bytes.message).toEqual({
			kind: "bytes",
			pane: 4,
			bytes: new Uint8Array([104, 105]),
		});
		expect(
			validateControlRequest({
				...identity,
				message: { kind: "resize", cols: 120, rows: 40 },
			}).message,
		).toEqual({
			kind: "resize",
			cols: 120,
			rows: 40,
		});
		expect(
			validateControlRequest({
				...identity,
				message: { kind: "resize-pane", pane: 3, vertical: true, cells: 30 },
			}).message,
		).toEqual({ kind: "resize-pane", pane: 3, vertical: true, cells: 30 });
	});

	it("refuses what it does not know, and keys that would end a command line", () => {
		for (const message of [
			{ kind: "run-shell", command: "rm -rf /" },
			{ kind: "keys", keys: ["a\nkill-server"] },
			{ kind: "keys", keys: "C-b" },
			{ kind: "bytes", bytes: [1, 2] },
			{ kind: "resize", cols: -1, rows: 2 },
			{ kind: "resize-pane", pane: 3, vertical: "yes", cells: 3 },
			{ kind: "resize-pane", pane: 3, vertical: true, cells: 1.5 },
		]) {
			expect(() => validateControlRequest({ ...identity, message })).toThrow();
		}
		expect(() =>
			validateControlRequest({
				...identity,
				attachmentId: "",
				message: { kind: "ack", seq: 1 },
			}),
		).toThrow();
	});

	it("runs the same attach as a control client", () => {
		expect(
			controlArgv([
				"-f",
				"/conf",
				"-L",
				"devhub",
				"attach-session",
				"-t",
				"ws-1",
			]),
		).toEqual([
			"-f",
			"/conf",
			"-L",
			"devhub",
			"-C",
			"attach-session",
			"-t",
			"ws-1",
		]);
		expect(() => controlArgv(["new-session"])).toThrow();
	});
});
