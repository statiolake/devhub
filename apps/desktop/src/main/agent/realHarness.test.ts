/**
 * Opt-in end-to-end coverage against a real Herdr server.
 *
 * Ported from `src-tauri/src/agent/real_harness.rs`. The Rust test was
 * `#[ignore]` and relied on an external runner script to build an isolated
 * HOME/XDG tree, start a headless Herdr session and place deterministic
 * `codex`/`claude` executables on PATH. Here the test provisions that tree
 * itself under `.spike/`, so the only external requirement is a `herdr` on
 * PATH — which the adapter resolves, never hard-codes.
 *
 * It is opt-in because it starts a real provider server and leaves nothing to
 * chance about which one: run it with
 *
 *     DEVHUB_HERDR_REAL=1 npx vitest run src/main/agent/realHarness.test.ts
 *
 * Without that variable the suite is skipped, exactly as the Rust `#[ignore]`
 * attribute did.
 *
 * One thing the Rust suite asserted is deliberately not asserted here: the
 * agent's own output and its Working/Waiting status. Herdr 0.8.2 recognises an
 * agent by the provider's identity, and the shell stand-in below stays
 * `launch_pending` with status `unknown`; the Rust runner supplied purpose-built
 * deterministic `codex`/`claude` wrappers that this port does not carry. The
 * status projection is covered deterministically by `harness.test.ts`, which
 * scripts the provider's status on the wire.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { delay } from "./api.js";
import { HERDR_SESSION_NAME } from "./contract.js";
import { RuntimeLaunchContext } from "./launchContext.js";
import { HerdrAgentRuntime } from "./runtime.js";
import {
	AgentProfileKind,
	CancellationToken,
	type AgentProfile,
} from "./ports.js";

const ENABLED = process.env.DEVHUB_HERDR_REAL === "1";
const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const READY_MARKER = "DEVHUB_HERDR_CODEX_READY";
const EXIT_MARKER = "DEVHUB_HERDR_HARNESS_EXIT";
const DEADLINE_MS = 30_000;

/** Scratch lives under `.spike/`, never `$TMPDIR`, and never in a commit. */
const SPIKE_ROOT = resolve(import.meta.dirname, "../../../../../.spike");

let root: string | undefined;

function token(seed: number): CancellationToken {
	return new CancellationToken(
		`cccccccc-cccc-4ccc-8ccc-${seed.toString(16).padStart(12, "0")}`,
	);
}

function provision(): {
	context: RuntimeLaunchContext;
	workspace: string;
	journal: string;
} {
	// The directory name is short on purpose. A Unix socket path is limited
	// to 104 bytes on macOS, and Herdr appends
	// `config/herdr/sessions/devhub-session/herdr-client.sock` (54 bytes) to
	// whatever XDG config home it is given: a longer scratch name makes the
	// server fail to bind its control socket and exit without a word.
	root = join(SPIKE_ROOT, `hr-${process.pid % 1000}`);
	rmSync(root, { recursive: true, force: true });
	const home = join(root, "home");
	const config = join(root, "config");
	const bin = join(root, "bin");
	const workspace = join(root, "workspace");
	for (const dir of [home, config, bin, workspace]) {
		mkdirSync(dir, { recursive: true });
	}
	// A deterministic stand-in for the real agent: it announces itself, then
	// stays in the foreground until the surface sends the exit marker.
	const agent = join(bin, "codex");
	writeFileSync(
		agent,
		[
			"#!/bin/sh",
			`echo ${READY_MARKER}`,
			"while IFS= read -r line; do",
			`  case "$line" in *${EXIT_MARKER}*) exit 0;; esac`,
			"done",
			"",
		].join("\n"),
	);
	chmodSync(agent, 0o755);

	const context = RuntimeLaunchContext.create(home, {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: config,
		PATH: `${bin}:${process.env.PATH ?? ""}`,
	});
	return { context, workspace, journal: join(root, "journal.json") };
}

function profile(bin: string): AgentProfile {
	return {
		id: "codex-real",
		displayName: "Real Herdr Codex",
		kind: AgentProfileKind.Codex,
		args: ["--deterministic"],
		env: {
			DEVHUB_HERDR_HARNESS: "1",
			// Herdr uses this process-environment hint when a test executable
			// is a deterministic wrapper rather than the real provider.
			HERDR_AGENT: "codex",
			PATH: `${bin}:${process.env.PATH ?? ""}`,
		},
	};
}

afterAll(() => {
	if (root === undefined) {
		return;
	}
	try {
		// The server is session-scoped and isolated; stopping it through its own
		// CLI leaves nothing behind for the next run to inherit.
		execFileSync("herdr", ["--session", HERDR_SESSION_NAME, "server", "stop"], {
			env: {
				...process.env,
				HOME: join(root, "home"),
				XDG_CONFIG_HOME: join(root, "config"),
			},
			stdio: "ignore",
			timeout: 10_000,
		});
	} catch {
		// Already gone, or never started. The directory removal below is the
		// part that must happen either way.
	}
	rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe.skipIf(!ENABLED)("the real Herdr agent runtime lifecycle", () => {
	it("bootstraps, launches, observes, attaches, exits and cleans up", async () => {
		const { context, workspace, journal } = provision();
		const bin = join(root!, "bin");
		const runtime = HerdrAgentRuntime.create(context, "herdr", journal);

		// Bootstrap resolves `herdr` through PATH, verifies its version and
		// protocol, probes every mutation capability and the control socket,
		// and starts the session server if it is not already running.
		const health = await runtime.bootstrap(token(1));
		expect(health.isReady).toBe(true);

		runtime.registerAgentWorkspace(AGENT_ID, WORKSPACE_ID, workspace);
		const receipt = await runtime.launchForWorkspace(
			WORKSPACE_ID,
			workspace,
			AGENT_ID,
			profile(bin),
			token(2),
		);
		expect(receipt.agentId).toBe(AGENT_ID);

		// Reconciliation must observe the launched agent through the hidden
		// workspace marker. Its *status* stays `unknown` here, because Herdr
		// derives Working/Waiting/Idle from a real provider's output and the
		// stand-in above is a shell: the status projection is covered
		// deterministically by the wire harness instead. What this asserts
		// is that a real Herdr snapshot resolves to this agent at all.
		let sequence = 3;
		let observed;
		const deadline = Date.now() + DEADLINE_MS;
		for (;;) {
			const reconciled = await runtime.reconcile(token(sequence));
			sequence += 1;
			observed = reconciled.observations.find(
				(item) => item.agentId === AGENT_ID,
			);
			if (observed !== undefined) {
				break;
			}
			expect(Date.now()).toBeLessThan(deadline);
			await delay(200);
		}
		expect(observed.agentId).toBe(AGENT_ID);

		const surface = await runtime.attachSurface(
			AGENT_ID,
			"codex-surface-a",
			false,
			token(sequence),
		);
		sequence += 1;
		// The control socket is real: bytes here came off Herdr's binary
		// protocol-20 stream for this exact terminal. What the agent itself
		// prints is deliberately not asserted — see the note at the end of
		// this file about the stand-in agent.
		let recent = Buffer.alloc(0);
		const readDeadline = Date.now() + DEADLINE_MS;
		while (recent.length === 0) {
			recent = Buffer.concat([recent, await surface.readRecent()]);
			expect(Date.now()).toBeLessThan(readDeadline);
			await delay(200);
		}
		expect(recent.length).toBeGreaterThan(0);

		// A live surface owns the controller: a second one is refused until
		// the first detaches.
		await expect(
			runtime.attachSurface(AGENT_ID, "codex-surface-b", true, token(sequence)),
		).rejects.toBeDefined();
		sequence += 1;

		// Input travels the same real control socket.
		await surface.sendText(`${EXIT_MARKER}\n`);
		surface.detach();

		// Explicit termination closes the provider pane and workspace and
		// clears the tombstone, so nothing of this run survives it.
		await runtime.terminate(AGENT_ID, token(sequence));
		sequence += 1;
		const closed = await runtime.reconcile(token(sequence));
		expect(closed.observations.some((item) => item.agentId === AGENT_ID)).toBe(
			false,
		);
		await runtime.shutdown();
	}, 120_000);
});
