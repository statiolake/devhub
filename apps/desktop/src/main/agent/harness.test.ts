/**
 * Ported from the two `#[test]` functions in `src-tauri/src/agent/harness.rs`.
 *
 * These drive the real `HerdrTransport` and `HerdrTerminalControl` against a
 * wire-level Herdr server, so the whole lifecycle — bootstrap, launch, status
 * reconciliation, surface takeover, subscription reconnect, natural exit and
 * tombstone retry — is exercised without a real agent process.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { delay, type ProviderTransport } from "./api.js";
import {
	HARNESS_AGENT_ID,
	HARNESS_WORKSPACE_ID,
	HerdrHarness,
} from "./harness.js";
import { RuntimeLaunchContext } from "./launchContext.js";
import { HerdrAgentRuntime } from "./runtime.js";
import {
	AgentProfileKind,
	AgentStatus,
	CancellationToken,
	RuntimeHealth,
	type AgentProfile,
} from "./ports.js";

const harnesses: HerdrHarness[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
	while (harnesses.length > 0) {
		await harnesses.pop()!.stop();
	}
	while (scratchDirs.length > 0) {
		rmSync(scratchDirs.pop()!, { recursive: true, force: true });
	}
});

async function startHarness(): Promise<HerdrHarness> {
	const harness = await HerdrHarness.start(import.meta.dirname);
	harnesses.push(harness);
	return harness;
}

function token(seed: number): CancellationToken {
	return new CancellationToken(
		`cccccccc-cccc-4ccc-8ccc-${seed.toString(16).padStart(12, "0")}`,
	);
}

function profile(): AgentProfile {
	return {
		id: "codex",
		displayName: "User-facing Codex",
		kind: AgentProfileKind.Codex,
		args: ["--deterministic"],
		env: { DEVHUB_HARNESS: "1" },
	};
}

function runtimeFor(harness: HerdrHarness): HerdrAgentRuntime {
	const home = join(harness.root, "home");
	mkdirSync(home, { recursive: true });
	return HerdrAgentRuntime.withTransport(
		RuntimeLaunchContext.create(home, process.env),
		harness.transport() as ProviderTransport,
		join(harness.root, "agent-runtime-journal.json"),
	);
}

function workspaceRoot(): string {
	const dir = mkdtempSync(join(import.meta.dirname, "agent-harness-root-"));
	scratchDirs.push(dir);
	return dir;
}

describe("the pinned Herdr wire harness", () => {
	it("covers launch, status, exit, reconnect, surface and retry", async () => {
		const harness = await startHarness();
		const runtime = runtimeFor(harness);
		const root = workspaceRoot();
		runtime.registerAgentWorkspace(
			HARNESS_AGENT_ID,
			HARNESS_WORKSPACE_ID,
			root,
		);
		expect((await runtime.bootstrap(token(0))).isReady).toBe(true);

		const receipt = await runtime.launchForWorkspace(
			HARNESS_WORKSPACE_ID,
			root,
			HARNESS_AGENT_ID,
			profile(),
			token(1),
		);
		expect(receipt.agentId).toBe(HARNESS_AGENT_ID);
		const observed = harness.launchObserved();
		expect(observed.name.length).toBeLessThanOrEqual(32);
		expect(observed.name.startsWith("a")).toBe(true);
		expect(observed.kind).toBe("codex");
		expect(observed.args).toEqual(["--deterministic"]);
		expect(observed.cwd).toBe(root);

		// Agent detection is asynchronous in Herdr. A pane with a live
		// terminal and a non-terminal status must remain observable even if
		// its agent label is absent for one authoritative snapshot.
		harness.setTransientMissingAgent();
		const reconciled = await runtime.reconcile(token(2));
		expect(reconciled.observations[0].status).toBe(AgentStatus.Working);
		expect(reconciled.observations[0].runtimeHealth).toBe(
			RuntimeHealth.Healthy,
		);
		expect(reconciled.exited).toEqual([]);
		harness.restoreAgent();

		const first = await runtime.attachSurface(
			HARNESS_AGENT_ID,
			"surface-a",
			false,
			token(3),
		);
		expect((await first.readRecent()).toString("utf8")).toContain(
			"herdr-harness",
		);
		await expect(
			runtime.attachSurface(HARNESS_AGENT_ID, "surface-a", true, token(4)),
		).rejects.toBeDefined();
		first.detach();
		const second = await runtime.attachSurface(
			HARNESS_AGENT_ID,
			"surface-b",
			true,
			token(5),
		);
		second.detach();

		harness.dropSubscriptions(true);
		await delay(250);
		harness.dropSubscriptions(false);
		await runtime.reconcile(token(6));

		harness.setNaturalExit();
		harness.setCleanupFailure(true);
		const exited = await runtime.reconcile(token(7));
		expect(exited.exited).toEqual([HARNESS_AGENT_ID]);
		harness.setCleanupFailure(false);
		await delay(250);
		await runtime.reconcile(token(8));
		await runtime.shutdown();
	}, 30_000);

	it("treats a missing agent identity as observable before confirmation and as an exit after", async () => {
		const harness = await startHarness();
		const runtime = runtimeFor(harness);
		const root = workspaceRoot();
		runtime.registerAgentWorkspace(
			HARNESS_AGENT_ID,
			HARNESS_WORKSPACE_ID,
			root,
		);
		expect((await runtime.bootstrap(token(9))).isReady).toBe(true);
		await runtime.launchForWorkspace(
			HARNESS_WORKSPACE_ID,
			root,
			HARNESS_AGENT_ID,
			profile(),
			token(10),
		);

		// The first authoritative snapshot can have a live pane but no
		// detected agent identity while Herdr is still settling.
		harness.setTransientMissingAgent();
		const startup = await runtime.reconcile(token(11));
		expect(startup.exited).toEqual([]);
		expect(startup.observations).toHaveLength(1);

		// Once a snapshot confirms the agent, the same missing identity
		// means the agent exited even though Herdr kept the pane alive.
		harness.restoreAgent();
		const confirmed = await runtime.reconcile(token(12));
		expect(confirmed.exited).toEqual([]);
		harness.setTransientMissingAgent();
		const exited = await runtime.reconcile(token(13));
		expect(exited.exited).toEqual([HARNESS_AGENT_ID]);
		await runtime.shutdown();
	}, 30_000);
});
