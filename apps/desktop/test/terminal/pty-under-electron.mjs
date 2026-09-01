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
			// Deliberately *not* unref'd. This timer is the test's only defence
			// against waiting for something that will never arrive — a shell
			// whose server was killed under it, say. An unref'd one lets the
			// process go idle instead, and the runner then reports "cancelled"
			// with no message at all rather than the timeout that explains it.
			// It is cleared in `finally`, so it never outlives its own wait.
		}),
	]).finally(() => clearTimeout(timer));
}

const sleep = (milliseconds) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Whether the server this test started is still there. */
function serverIsAlive(socket) {
	try {
		execFileSync(TMUX, ["-L", socket, "has-session", "-t", "scratch"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		// Not a swallow: absence is the answer this function exists to give.
		return false;
	}
}

/**
 * Run the body, and if it fails, say whether the ground moved underneath it.
 *
 * This test owns its socket and starts and stops its own server, so the only
 * way that server can vanish mid-run is something outside the test — a global
 * `pkill`, or a cleanup script matching more than it created. That is a
 * different fact from the runtime misbehaving, and a failure that cannot tell
 * them apart is the one that "passes on retry" and sends the next person
 * looking in the wrong place.
 */
async function withSocketGuard(socket, body) {
	try {
		await body();
	} catch (failure) {
		if (!serverIsAlive(socket)) {
			throw new Error(
				`the tmux server this test started on socket "${socket}" was gone before the test finished — something outside the test killed it (a global pkill, or a cleanup script matching more than it created). The failure underneath was: ${String(failure)}`,
				{ cause: failure },
			);
		}
		throw failure;
	}
}

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

		await withSocketGuard(socket, async () => {
		const runtime = new TmuxTerminalRuntime({
			context: { home, environment: { ...process.env } },
			tmux: { kind: "resolved", value: { path: TMUX, basename: "tmux" } },
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

		await surfaces.resize(identity, {
			cols: 100,
			rows: 30,
			pixelWidth: 0,
			pixelHeight: 0,
		});

		/**
		 * The pane must fill the client exactly — no more.
		 *
		 * A window is the client minus the rows tmux draws itself in, so on a
		 * session with a status bar a 30-row client gives a 29-row window. The
		 * pane may never be told it is taller than that: the extra row would be
		 * where the status bar is, and a full-screen TUI's bottom line would be
		 * drawn there and never seen. DevHub used to force exactly that by
		 * calling `resize-window` with the client's own rows.
		 *
		 * The expectation is computed from tmux's own chrome rather than
		 * written as a number, so this holds for a status bar that is there and
		 * one that is not.
		 */
		const geometry = async () => {
			const message = await runtime.runTmux(
				socket,
				[
					"display-message",
					"-p",
					"-t",
					"scratch:0.0",
					"#{pane_width} #{pane_height} #{client_height} #{status} #{window-size}",
				],
				home,
				new CancellationToken(),
				OperationDeadline.in(15_000),
			);
			const [width, height, client, status, mode] = message.stdout
				.toString("utf8")
				.trim()
				.split(/\s+/);
			// tmux spells the status bar as off, on, or a count of lines.
			const lines = status === "off" ? 0 : status === "on" ? 1 : Number(status);
			assert.ok(
				Number.isInteger(lines),
				`tmux reported a status bar this test cannot read: ${status}`,
			);
			return {
				width: Number(width),
				height: Number(height),
				client: Number(client),
				status: lines,
				mode,
			};
		};

		const resizeDeadline = Date.now() + 15_000;
		let pane = await geometry();
		while (
			Date.now() < resizeDeadline &&
			!(pane.width === 100 && pane.client === 30)
		) {
			await sleep(20);
			pane = await geometry();
		}
		assert.equal(pane.width, 100, "the pane must observe the requested width");
		assert.equal(pane.client, 30, "the client must observe the requested rows");
		assert.equal(
			pane.height,
			30 - pane.status,
			"the pane must be the client's rows minus tmux's own status lines",
		);
		// Left at its default, the window keeps following the client. An
		// explicit `resize-window` latches it to `manual` for good, and tmux
		// then ignores every later resize.
		assert.equal(
			pane.mode,
			"latest",
			"the window must keep following the client",
		);

		await sleep(250);
		type("printf 'DEVHUB_PTY_''SIZE:'; stty size; printf '\\n'\r");
		await waitForText(
			`${30 - pane.status} 100`,
			"the shell to observe the size it can actually draw in",
		);

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
		});
	},
);
