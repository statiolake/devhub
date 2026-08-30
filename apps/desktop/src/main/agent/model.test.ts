/** Ported from the `model.rs` test module of the Tauri agent adapter. */

import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentRuntimeErrorCode, type AgentRuntimeError } from "./error.js";
import {
	MAX_PROFILE_ARG_BYTES,
	ProviderStatus,
	TombstoneReason,
	decodeProviderMapping,
	encodeProviderMapping,
	loadCleanupJournal,
	markerLabel,
	parseSessionSnapshot,
	mappingsEqual,
	projectProviderStatus,
	providerAgentName,
	recoverMapping,
	saveCleanupJournal,
	validateProfile,
	type CleanupTombstone,
	type ProviderMapping,
} from "./model.js";
import {
	AgentProfileKind,
	AgentStatus,
	RuntimeHealth,
	type AgentProfile,
} from "./ports.js";

const scratchDirs: string[] = [];

function scratchDir(): string {
	// Under the repo, never the OS temp dir: a sandboxed run sees a different
	// $TMPDIR inside and outside, and these files must be the same ones.
	const dir = mkdtempSync(join(import.meta.dirname, "agent-model-test-"));
	scratchDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (scratchDirs.length > 0) {
		rmSync(scratchDirs.pop()!, { recursive: true, force: true });
	}
});

function profile(
	kind: AgentProfileKind,
	args: string[] = [],
	env: Record<string, string> = {},
): AgentProfile {
	return { id: "profile", displayName: "Profile", kind, args, env };
}

function mapping(overrides: Partial<ProviderMapping> = {}): ProviderMapping {
	return {
		workspaceId: "workspace-private",
		tabId: "tab-private",
		paneId: "pane-private",
		terminalId: "terminal-private",
		workspaceRoot: "/devhub-agent",
		workspaceDomainId: undefined,
		generation: 4,
		...overrides,
	};
}

function codeOf(run: () => unknown): AgentRuntimeErrorCode {
	try {
		run();
	} catch (error) {
		return (error as AgentRuntimeError).code;
	}
	throw new Error("expected a failure");
}

describe("profile validation", () => {
	it("maps supported profiles without provider ids", () => {
		expect(validateProfile(profile(AgentProfileKind.Codex)).kind).toBe("codex");
		expect(validateProfile(profile(AgentProfileKind.Claude)).kind).toBe(
			"claude",
		);
	});

	it("rechecks environment names and bounds at launch", () => {
		expect(
			codeOf(() =>
				validateProfile(
					profile(AgentProfileKind.Codex, [], { "A-B": "value" }),
				),
			),
		).toBe(AgentRuntimeErrorCode.InvalidProfile);
		expect(
			codeOf(() =>
				validateProfile(
					profile(AgentProfileKind.Codex, [
						"x".repeat(MAX_PROFILE_ARG_BYTES + 1),
					]),
				),
			),
		).toBe(AgentRuntimeErrorCode.InvalidProfile);
	});

	it("rejects every control character in an argument", () => {
		for (const control of ["\n", "\r", "\t", "", ""]) {
			expect(
				codeOf(() =>
					validateProfile(
						profile(AgentProfileKind.Codex, [`prefix${control}suffix`]),
					),
				),
			).toBe(AgentRuntimeErrorCode.InvalidProfile);
		}
	});

	it("rejects a profile whose aggregate wire size exceeds the budget", () => {
		expect(
			codeOf(() =>
				validateProfile(
					profile(AgentProfileKind.Codex, Array(64).fill("x".repeat(14_500))),
				),
			),
		).toBe(AgentRuntimeErrorCode.InvalidProfile);
	});
});

describe("provider names and mappings", () => {
	it("derives a deterministic, unique, Herdr-safe agent name", () => {
		const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const second = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
		const firstName = providerAgentName(first);
		expect(firstName).toBe(providerAgentName(first));
		expect(firstName).not.toBe(providerAgentName(second));
		expect(firstName.length).toBeLessThanOrEqual(32);
		expect(/^[a-z][0-9a-z_-]*$/.test(firstName)).toBe(true);
	});

	it("round-trips an opaque mapping the core never interprets", () => {
		const value = mapping({
			workspaceDomainId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		});
		const opaque = encodeProviderMapping(value);
		expect(`${opaque}`).toContain("redacted");
		expect(mappingsEqual(decodeProviderMapping(opaque), value)).toBe(true);
	});
});

describe("the cleanup journal", () => {
	function tombstones(
		agentId: string,
		attempts: number,
		reason = TombstoneReason.ExplicitStop,
	): Map<string, CleanupTombstone> {
		return new Map([
			[
				agentId,
				{ mapping: mapping(), reason, attempts, nextRetry: Date.now() },
			],
		]);
	}

	it("round-trips through a private file", () => {
		const path = join(scratchDir(), "journal.json");
		const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		saveCleanupJournal(path, tombstones(agentId, 2));
		expect(loadCleanupJournal(path).get(agentId)?.attempts).toBe(2);
	});

	it("never follows a symlink target", () => {
		const dir = scratchDir();
		const target = join(dir, "symlink-target");
		const path = join(dir, "journal.json");
		writeFileSync(target, "not a journal");
		symlinkSync(target, path);
		expect(codeOf(() => saveCleanupJournal(path, new Map()))).toBe(
			AgentRuntimeErrorCode.Unavailable,
		);
		expect(codeOf(() => loadCleanupJournal(path))).toBe(
			AgentRuntimeErrorCode.Unavailable,
		);
	});

	it("is private and never reuses a fixed temporary name", () => {
		const path = join(scratchDir(), "journal.json");
		const staleFixedTemp = `${path}.tmp`;
		writeFileSync(staleFixedTemp, "interrupted old writer");
		saveCleanupJournal(path, new Map());
		expect(existsSync(staleFixedTemp)).toBe(true);
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
	});

	it("quarantines a corrupt primary and restores the previous commit", () => {
		const path = join(scratchDir(), "journal.json");
		const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		saveCleanupJournal(
			path,
			tombstones(agentId, 1, TombstoneReason.NaturalExit),
		);
		saveCleanupJournal(
			path,
			tombstones(agentId, 2, TombstoneReason.NaturalExit),
		);
		writeFileSync(path, "{not-json", { mode: 0o600 });
		chmodSync(path, 0o600);

		const restored = loadCleanupJournal(path);
		expect(restored.get(agentId)?.attempts).toBe(1);
		expect(existsSync(`${path}.corrupt.0`)).toBe(true);
	});
});

describe("provider projection", () => {
	it("projects status to product status without leaking wire values", () => {
		expect(projectProviderStatus(ProviderStatus.Working)).toEqual([
			AgentStatus.Working,
			RuntimeHealth.Healthy,
		]);
		expect(projectProviderStatus(ProviderStatus.Blocked)).toEqual([
			AgentStatus.Waiting,
			RuntimeHealth.Healthy,
		]);
		expect(projectProviderStatus(ProviderStatus.Unknown)).toEqual([
			AgentStatus.Error,
			RuntimeHealth.Degraded,
		]);
		// `done` is Herdr's idle-after-unseen-work, not an exit: an Agent in
		// DevHub's hidden session is unseen by construction, so every finished
		// turn lands here while the agent is still very much alive.
		expect(projectProviderStatus(ProviderStatus.Done)).toEqual([
			AgentStatus.Idle,
			RuntimeHealth.Healthy,
		]);
	});

	it("recovers a mapping from the hidden workspace marker", () => {
		const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const recovered = recoverMapping(
			{
				workspaces: [{ id: "workspace-provider", label: markerLabel(agentId) }],
				panes: [
					{
						id: "pane-provider",
						terminalId: "terminal-provider",
						workspaceId: "workspace-provider",
						tabId: "tab-provider",
						agent: "codex",
						status: ProviderStatus.Idle,
					},
				],
			},
			agentId,
			"/root",
			undefined,
			1,
		);
		expect(recovered?.paneId).toBe("pane-provider");
	});
});

describe("session snapshot parsing", () => {
	it("reads the agent identity from either pinned Herdr shape", () => {
		const base = {
			pane_id: "w2:p1",
			terminal_id: "term_1",
			workspace_id: "w2",
			tab_id: "w2:t1",
			agent_status: "working",
		};
		// 0.8.1 put the label on the pane.
		expect(
			parseSessionSnapshot({
				snapshot: { workspaces: [], panes: [{ ...base, agent: "codex" }] },
			}).panes[0].agent,
		).toBe("codex");
		// 0.8.2 lists agents separately and keys them by pane.
		expect(
			parseSessionSnapshot({
				snapshot: {
					workspaces: [],
					panes: [base],
					agents: [{ pane_id: "w2:p1", name: "aa3qmm1bzfr1yum8" }],
				},
			}).panes[0].agent,
		).toBe("aa3qmm1bzfr1yum8");
		// A pane with no agent anywhere stays unconfirmed.
		expect(
			parseSessionSnapshot({ snapshot: { workspaces: [], panes: [base] } })
				.panes[0].agent,
		).toBeUndefined();
	});

	it("rejects a malformed provider snapshot instead of guessing", () => {
		expect(codeOf(() => parseSessionSnapshot({}))).toBe(
			AgentRuntimeErrorCode.ProviderRejected,
		);
		expect(
			codeOf(() =>
				parseSessionSnapshot({ snapshot: { panes: [{ pane_id: "p" }] } }),
			),
		).toBe(AgentRuntimeErrorCode.ProviderRejected);
	});
});
