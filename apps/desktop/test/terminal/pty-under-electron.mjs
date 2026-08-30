/* The lint config gives Node's globals to `.ts`/`.tsx` only, and this file is
   plain JavaScript because its interpreter has no TypeScript. */
/* global Buffer, URL, TextEncoder, process, setTimeout, clearTimeout */

/**
 * The whole terminal, end to end, on the real native module and a real tmux.
 *
 * This is the one terminal test that cannot run under plain Node: `node-pty` is
 * a native module built for VS Code's Electron, so the test runs under that
 * binary as Node (`run-under-electron.sh`). Everything else about the terminal
 * — framing, the ack window, the input ledger, the marker protocol, the socket
 * transitions — is tested under vitest.
 *
 * Ported from the Rust `real_tmux_pty_roundtrip_resize_detach_and_replacement_preserve_session`.
 * What it proves is the property the tmux runtime exists for: the shell lives in
 * the session, so detaching the client leaves it running, and the next attach
 * finds the same session.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { nodePty, openPty, terminalEnvironment } from "../../out/test-terminal/main/terminal/pty.js";
import { AttachmentManager } from "../../out/test-terminal/main/terminal/attachments.js";
import { TerminalSurfaces } from "../../out/test-terminal/main/terminal/surfaces.js";
import { TmuxTerminalRuntime } from "../../out/test-terminal/main/terminal/tmux.js";
import {
	CancellationToken,
	SCRATCH_TARGET,
} from "../../out/test-terminal/main/terminal/ports.js";
import { OperationDeadline } from "../../out/test-terminal/main/terminal/command.js";
import {
	decodeTerminalFrame,
	encodeTerminalFrame,
} from "../../out/test-terminal/ipc/terminal.js";

/** Scratch lives inside the repository, never in the OS temp directory. */
const SCRATCH_ROOT = fileURLToPath(new URL("../../../../.spike/", import.meta.url));
const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find(
	(path) => existsSync(path),
);

function scratchDirectory(label) {
	mkdirSync(SCRATCH_ROOT, { recursive: true });
	return realpathSync(mkdtempSync(join(SCRATCH_ROOT, `devhub-${label}-`)));
}

function deadline(promise, milliseconds, what) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`timed out waiting for ${what}`)),
				milliseconds,
			);
			timer.unref();
		}),
	]).finally(() => clearTimeout(timer));
}

const sleep = (milliseconds) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

test("node-pty resolves from the submodule and drives a real child", async (t) => {
	assert.equal(typeof nodePty().spawn, "function");
	const cwd = scratchDirectory("pty");
	// Registered before anything can fail, so a scratch directory is never
	// left behind by a failing run.
	t.after(() => rmSync(cwd, { recursive: true, force: true }));

	const pty = openPty({
		file: "/bin/sh",
		args: [],
		cwd,
		cols: 80,
		rows: 24,
		pixelWidth: 0,
		pixelHeight: 0,
		env: terminalEnvironment(process.env),
	});
	assert.ok(pty.pid > 0);
	let text = "";
	const sawMarker = new Promise((resolve) => {
		pty.onData((bytes) => {
			text += Buffer.from(bytes).toString("utf8");
			if (text.includes("devhub-pty-ok")) resolve();
		});
	});
	pty.write(new TextEncoder().encode("printf 'devhub''-pty-ok\\n'\n"));
	await deadline(sawMarker, 15_000, "the child to echo its marker");
	pty.kill();
});

test(
	"a terminal surface is a tmux client, and detaching it keeps the session",
	{ skip: TMUX === undefined ? "tmux is not installed" : false },
	async (t) => {
		const home = scratchDirectory("tmux-pty");
		const socket = `dhpty${process.pid}`;
		t.after(() => {
			try {
				execFileSync(TMUX, ["-L", socket, "kill-server"], { stdio: "ignore" });
			} catch {
				// Not a swallow: no server on that socket is the goal.
			}
			rmSync(home, { recursive: true, force: true });
		});

		const runtime = new TmuxTerminalRuntime({
			context: { home, environment: { ...process.env } },
			tmux: { path: TMUX, basename: "tmux" },
			shell: { path: "/bin/sh", basename: "sh" },
			tmuxArgs: [],
			effectiveSocketName: socket,
			timeoutMs: 15_000,
			bootstrapDirectory: home,
		});
		const surfaces = new TerminalSurfaces({
			runtime,
			attachments: new AttachmentManager({
				randomBytes: (count) => new Uint8Array(randomBytes(count)),
				environment: () => terminalEnvironment(process.env),
			}),
		});

		const frames = [];
		let onFrame = () => undefined;
		const sink = (frame) => {
			// Encode and decode exactly as the wire does, so the test only ever
			// sees frames the page could have parsed.
			const decoded = decodeTerminalFrame(encodeTerminalFrame(frame));
			frames.push(decoded);
			onFrame(decoded);
			return true;
		};

		const receipt = await surfaces.attach({
			target: SCRATCH_TARGET,
			surfaceKey: "global-terminal",
			viewLabel: "real-pty-window",
			size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
			sink,
		});
		const identity = {
			surfaceKey: "global-terminal",
			attachmentId: receipt.attachmentId,
			targetGeneration: receipt.targetGeneration,
			viewLabel: "real-pty-window",
		};
		assert.equal(frames.length, 1);
		assert.equal(frames[0].type, "started");
		assert.equal(frames[0].sequence, 0);

		const text = () =>
			frames
				.filter((frame) => frame.type === "output")
				.map((frame) => Buffer.from(frame.bytes).toString("utf8"))
				.join("");

		const waitForText = (needle, what) =>
			deadline(
				new Promise((resolve) => {
					const check = () => {
						if (text().includes(needle)) resolve();
					};
					onFrame = (frame) => {
						// Acknowledging is what keeps the output window open; a
						// view that never acknowledges is disconnected by design.
						if (frame.type === "output") {
							surfaces.acknowledge(identity, frame.sequence);
						}
						check();
					};
					check();
				}),
				20_000,
				what,
			);

		let sequence = 0;
		const type = (line) => {
			sequence += 1;
			surfaces.input(identity, sequence, new TextEncoder().encode(line));
		};

		// The quotes split the marker in the command the shell echoes back, so
		// waiting for it cannot match the echo of the keystrokes themselves.
		type("printf 'DEVHUB_PTY_''ROUNDTRIP\\n'\r");
		await waitForText("DEVHUB_PTY_ROUNDTRIP", "the pane to echo the marker");

		await surfaces.resize(identity, SCRATCH_TARGET, {
			cols: 100,
			rows: 30,
			pixelWidth: 0,
			pixelHeight: 0,
		});
		// tmux keeps a detached window at its old size, so the resize has to
		// reach the session's window, not only the client's PTY.
		const resizeDeadline = Date.now() + 15_000;
		let resized = false;
		while (Date.now() < resizeDeadline && !resized) {
			const pane = await runtime.runTmux(
				socket,
				[
					"display-message",
					"-p",
					"-t",
					"scratch:0.0",
					"#{pane_width}x#{pane_height}",
				],
				home,
				new CancellationToken(),
				OperationDeadline.in(15_000),
			);
			resized = pane.stdout.toString("utf8").includes("100x30");
			if (!resized) await sleep(20);
		}
		assert.ok(resized, "the owned tmux pane must observe the requested geometry");

		await sleep(250);
		type("printf 'DEVHUB_PTY_''SIZE:'; stty size; printf '\\n'\r");
		await waitForText("30 100", "the shell to observe its new size");

		surfaces.detach(identity);
		assert.equal(surfaces.attachmentCount, 0);
		const survivors = await runtime.listSessions(
			socket,
			new CancellationToken(),
			OperationDeadline.in(15_000),
		);
		// The whole point: the client is gone and the session is not.
		assert.ok(
			survivors.some((session) => session.name === "scratch"),
			"the tmux session must survive its client",
		);

		// Attaching again replaces the view's client only. The stale receipt is
		// refused by identity, and the session underneath is untouched.
		const replacement = await surfaces.attach({
			target: SCRATCH_TARGET,
			surfaceKey: "global-terminal",
			viewLabel: "real-pty-window",
			size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
			sink: () => true,
		});
		const latest = await surfaces.attach({
			target: SCRATCH_TARGET,
			surfaceKey: "global-terminal",
			viewLabel: "real-pty-window",
			size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
			sink: () => true,
		});
		assert.notEqual(replacement.attachmentId, latest.attachmentId);
		assert.throws(
			() =>
				surfaces.input(
					{
						surfaceKey: "global-terminal",
						attachmentId: replacement.attachmentId,
						targetGeneration: replacement.targetGeneration,
						viewLabel: "real-pty-window",
					},
					1,
					new TextEncoder().encode("stale\r"),
				),
			(error) => error.code === "wrong_attachment",
		);

		surfaces.detach({
			surfaceKey: "global-terminal",
			attachmentId: latest.attachmentId,
			targetGeneration: latest.targetGeneration,
			viewLabel: "real-pty-window",
		});
		assert.equal(surfaces.attachmentCount, 0);
	},
);
