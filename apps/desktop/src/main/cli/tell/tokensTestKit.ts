/**
 * The token fixtures (`main/tokenUsage/fixtures/`) as one report, for the
 * tests of `usage --by`: Claude's session and its subagent run by one Agent,
 * and a Codex rollout on an SSH host that no Agent ran.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TokenIndex } from "../../../model/tokenIndex.js";
import { buildTokenReport, resolveRange } from "../../../model/tokenReport.js";
import { claudeUsage, codexUsage } from "../../../model/tokenTranscripts.js";
import type { TokenReportWire } from "../../../ipc/tokenUsage.js";

export const NOW = Date.parse("2026-11-13T10:00:00.000Z");
const fixture = (name: string) => {
	const url = new URL(`../../tokenUsage/fixtures/${name}`, import.meta.url);
	// A page's test (jsdom) has its modules' URLs from the project's root:
	// the same file, under it.
	return readFileSync(
		existsSync(url) ? url : join(process.cwd(), url.pathname),
		"utf8",
	);
};

/** The fixtures' requests, Claude's session run by one Agent. */
export function fixtureReport(
	by: "agent" | "model" = "agent",
): TokenReportWire {
	const index = new TokenIndex();
	const claude = claudeUsage(fixture("claude-session.jsonl"), {});
	index.ingest(
		{
			machine: "local",
			cli: "claude",
			path: "/c/projects/-work-app/s.jsonl",
			session: "s",
		},
		{ start: 0, consumed: 1, size: 1, mtimeMs: NOW, ...claude },
		NOW,
	);
	const sub = claudeUsage(fixture("claude-subagent.jsonl"), {});
	index.ingest(
		{
			machine: "local",
			cli: "claude",
			path: "/c/projects/-work-app/s/subagents/agent-abc123.jsonl",
			session: "s",
			subagent: "abc123",
			subagentLabel: "Survey the parser",
		},
		{ start: 0, consumed: 1, size: 1, mtimeMs: NOW, ...sub },
		NOW,
	);
	const codex = codexUsage(fixture("codex-rollout.jsonl"), {});
	index.ingest(
		{
			machine: "ssh:box",
			cli: "codex",
			path: "/x/rollout.jsonl",
			session: "t",
		},
		{ start: 0, consumed: 1, size: 1, mtimeMs: NOW, ...codex },
		NOW,
	);
	return buildTokenReport({
		records: index.records(),
		ownerOf: (_machine, cli) =>
			cli === "claude"
				? {
						agentId: "a1",
						name: "Builder",
						profile: "Claude",
						machine: "local",
						workspaceLabel: "app",
						role: "worker",
					}
				: undefined,
		tasks: [],
		workspaces: [],
		range: resolveRange("days7", NOW, {}),
		by,
		takenAt: NOW,
	});
}
