/**
 * What a machine's failure is drawn as when it reaches the one conversion
 * outside an Agent's pane — opening a dev container, a folder on a host.
 *
 * It used to be a plain `Error` there, so "DevHub could not reach the Docker
 * daemon… Start Docker" was drawn under "The native app shell is
 * unavailable."
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorWire } from "../../model/wire.js";
import { LocalRuntime } from "../runtime/local.js";
import { portFailure, type PortErrorCode } from "./ports.js";

describe("a machine's failure, drawn", () => {
	it.each([
		["unavailable", "machine_unavailable"],
		["incompatible", "machine_unavailable"],
		["timed_out", "machine_timed_out"],
		["cancelled", "operation_cancelled"],
		["conflict", "machine_command_failed"],
		["failed", "machine_command_failed"],
		["root_missing", "workspace_unavailable"],
		["root_inaccessible", "workspace_unavailable"],
	] as const)("is a %s port failure as %s, with its sentence", (port, code) => {
		expect(
			errorWire(portFailure(port as PortErrorCode, { detail: "It said so." })),
		).toMatchObject({ code, detail: "It said so." });
	});

	it("keeps its own message, which the rest of main reads", () => {
		expect(portFailure("unavailable", { detail: "It said so." }).message).toBe(
			"It said so.",
		);
		expect(portFailure("timed_out").message).toBe("terminal runtime timed out");
	});
});

describe("a file or folder the machine could not read, drawn", () => {
	it("is its own failure, naming the path and the errno", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devhub-unreadable-"));
		try {
			const missing = join(dir, "not-there");
			const thrown = await new LocalRuntime().realpath(missing).then(
				() => undefined,
				(failure: unknown) => failure,
			);
			expect(errorWire(thrown)).toMatchObject({
				code: "file_unreadable",
				detail: `${missing} could not be read (ENOENT)`,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
