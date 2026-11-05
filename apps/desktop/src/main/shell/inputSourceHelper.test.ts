/**
 * The helper's end of the pipe, against stand-ins for the helper.
 *
 * The real `devhub-input-source` changes the machine's input source, which a
 * test has no business doing; these scripts speak its protocol instead, so
 * what is tested is the parsing and every way the process can fail.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NamedFailure } from "../../model/wire.js";
import { InputSourceHelper } from "./inputSourceHelper.js";

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "devhub-input-source-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

/** A helper that answers each request line with what `answers` says. */
function helper(body: string): string {
	const path = join(directory, "devhub-input-source");
	writeFileSync(
		path,
		`#!/bin/sh\nwhile IFS= read -r line; do\n  case "$line" in\n${body}\n  esac\ndone\n`,
	);
	chmodSync(path, 0o755);
	return path;
}

async function failureOf(promise: Promise<unknown>): Promise<NamedFailure> {
	const failure = await promise.then(
		() => undefined,
		(error: unknown) => error,
	);
	if (!(failure instanceof NamedFailure)) {
		throw new Error(`expected a NamedFailure, got ${String(failure)}`);
	}
	return failure;
}

describe("the input source helper", () => {
	it("reads a switch, and a source that was ASCII-capable already", async () => {
		const switched = new InputSourceHelper(
			helper(`    ascii) printf 'switched\\tjp\\tabc\\n' ;;`),
		);
		await expect(switched.selectAscii()).resolves.toBeUndefined();
		const unchanged = new InputSourceHelper(
			helper(`    ascii) printf 'unchanged\\tabc\\n' ;;`),
		);
		await expect(unchanged.selectAscii()).resolves.toBeUndefined();
	});

	it("refuses an answer outside the protocol", async () => {
		const port = new InputSourceHelper(
			helper(`    ascii) printf 'restored\\n' ;;`),
		);
		await expect(port.selectAscii()).rejects.toThrow(/answered "ascii"/u);
	});

	it("fails a request the helper says it could not do", async () => {
		const port = new InputSourceHelper(
			helper(`    ascii) printf 'error\\tno ASCII-capable source\\n' ;;`),
		);
		const failure = await failureOf(port.selectAscii());
		expect(failure.wire.code).toBe("input_source_unavailable");
		expect(failure.wire.detail).toBe("no ASCII-capable source");
	});

	it("fails every request when the helper is not there", async () => {
		const port = new InputSourceHelper(join(directory, "missing"));
		const first = await failureOf(port.selectAscii());
		expect(first.wire.code).toBe("input_source_unavailable");
		expect(first.wire.detail).toContain("could not be started");
		await expect(port.selectAscii()).rejects.toBe(first);
	});

	it("fails the request in flight, and every later one, when the helper stops", async () => {
		const port = new InputSourceHelper(helper(`    ascii) exit 3 ;;`));
		const failure = await failureOf(port.selectAscii());
		expect(failure.wire.code).toBe("input_source_unavailable");
		expect(failure.wire.detail).toContain("exit code 3");
		await expect(port.selectAscii()).rejects.toBe(failure);
	});
});
