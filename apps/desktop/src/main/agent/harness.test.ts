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
import { EXIT_EVIDENCE_ROUNDS } from "./model.js";
import { HerdrAgentRuntime } from "./runtime.js";
import {
	AgentProfileKind,
	AgentStatus,
	CancellationToken,
	PortErrorCode,
	RuntimeHealth,
	type AgentProfile,
	type AgentReconciliation,
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

/**
 * Reconciles until the runtime agrees an Agent ended, and fails if it takes
 * more rounds than the evidence rule allows. Nothing here waits for a timeout:
 * the number of rounds is the rule.
 */
async function reconcileUntilExit(
	runtime: HerdrAgentRuntime,
	seed: number,
): Promise<AgentReconciliation> {
	let reconciled = await runtime.reconcile(token(seed));
	for (let round = 1; round < EXIT_EVIDENCE_ROUNDS; round += 1) {
		expect(reconciled.exited).toEqual([]);
		reconciled = await runtime.reconcile(token(seed + round));
	}
	return reconciled;
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
		const exited = await reconcileUntilExit(runtime, 7);
		expect(exited.exited).toEqual([HARNESS_AGENT_ID]);
		harness.setCleanupFailure(false);
		await delay(250);
		await runtime.reconcile(token(80));
		await runtime.shutdown();
	}, 30_000);

	it("treats a missing agent identity as observable before confirmation, as evidence after, and as an exit only once the evidence repeats", async () => {
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

		harness.restoreAgent();
		const confirmed = await runtime.reconcile(token(12));
		expect(confirmed.exited).toEqual([]);

		// One snapshot without the identity is a photograph taken while Herdr
		// was changing, not an obituary. The Agent that comes back must keep
		// its row — and its confirmed status.
		harness.setTransientMissingAgent();
		expect((await runtime.reconcile(token(13))).exited).toEqual([]);
		expect((await runtime.reconcile(token(14))).exited).toEqual([]);
		harness.restoreAgent();
		const recovered = await runtime.reconcile(token(15));
		expect(recovered.exited).toEqual([]);
		expect(recovered.observations[0].status).toBe(AgentStatus.Working);

		// The evidence has to start over, so the exit still takes a full run
		// of consecutive snapshots after the Agent was last seen.
		harness.setTransientMissingAgent();
		expect((await runtime.reconcile(token(16))).exited).toEqual([]);
		expect((await runtime.reconcile(token(17))).exited).toEqual([]);
		expect((await runtime.reconcile(token(18))).exited).toEqual([
			HARNESS_AGENT_ID,
		]);
		await runtime.shutdown();
	}, 30_000);

	it("keeps an agent that finished a turn, however long it stays done", async () => {
		const harness = await startHarness();
		const runtime = runtimeFor(harness);
		const root = workspaceRoot();
		runtime.registerAgentWorkspace(
			HARNESS_AGENT_ID,
			HARNESS_WORKSPACE_ID,
			root,
		);
		expect((await runtime.bootstrap(token(19))).isReady).toBe(true);
		await runtime.launchForWorkspace(
			HARNESS_WORKSPACE_ID,
			root,
			HARNESS_AGENT_ID,
			profile(),
			token(20),
		);
		harness.restoreAgent();
		expect((await runtime.reconcile(token(21))).exited).toEqual([]);

		// Herdr reports `done` for every turn an unwatched agent finishes, and
		// keeps reporting it. Reading that as an exit is what made a working
		// Agent vanish a few seconds after its first prompt.
		harness.setDone();
		for (let round = 0; round < 6; round += 1) {
			const reconciled = await runtime.reconcile(token(22 + round));
			expect(reconciled.exited).toEqual([]);
			expect(reconciled.observations).toEqual([
				{
					agentId: HARNESS_AGENT_ID,
					status: AgentStatus.Idle,
					runtimeHealth: RuntimeHealth.Healthy,
				},
			]);
		}

		// Working again on the next prompt, from the same row.
		harness.restoreAgent();
		const working = await runtime.reconcile(token(30));
		expect(working.observations[0].status).toBe(AgentStatus.Working);
		await runtime.shutdown();
	}, 30_000);

	it("removes an agent whose pane Herdr closed", async () => {
		const harness = await startHarness();
		const runtime = runtimeFor(harness);
		const root = workspaceRoot();
		runtime.registerAgentWorkspace(
			HARNESS_AGENT_ID,
			HARNESS_WORKSPACE_ID,
			root,
		);
		expect((await runtime.bootstrap(token(31))).isReady).toBe(true);
		await runtime.launchForWorkspace(
			HARNESS_WORKSPACE_ID,
			root,
			HARNESS_AGENT_ID,
			profile(),
			token(32),
		);
		harness.restoreAgent();
		expect((await runtime.reconcile(token(33))).exited).toEqual([]);

		harness.closePane();
		const exited = await reconcileUntilExit(runtime, 34);
		expect(exited.exited).toEqual([HARNESS_AGENT_ID]);
		expect(exited.observations).toEqual([]);
		await runtime.shutdown();
	}, 30_000);

	it("reconciles away an agent restored from a runtime that no longer exists", async () => {
		const harness = await startHarness();
		const runtime = runtimeFor(harness);
		const root = workspaceRoot();
		// Nothing was ever launched against this harness, so its snapshot has
		// no workspace, no pane and no agent: exactly what DevHub sees when it
		// starts and the Herdr session from the last run is gone.
		runtime.restoreAgent(HARNESS_AGENT_ID, HARNESS_WORKSPACE_ID, root);
		expect((await runtime.bootstrap(token(40))).isReady).toBe(true);

		// The surface a restored row mounts asks to attach. It must be told
		// the Agent has ended, not that its surface would not connect.
		await expect(
			runtime.attachSurface(HARNESS_AGENT_ID, "surface-gone", false, token(41)),
		).rejects.toMatchObject({ code: PortErrorCode.Gone });

		const exited = await reconcileUntilExit(runtime, 42);
		expect(exited.exited).toEqual([HARNESS_AGENT_ID]);
		expect(exited.observations).toEqual([]);
		await runtime.shutdown();
	}, 30_000);
});
