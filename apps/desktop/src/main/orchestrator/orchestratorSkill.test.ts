import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTellArguments } from "../cli/tell/command.js";
import { GUI_AGENT_INSTRUCTIONS } from "../agent/conversation/linkInstructions.js";
import {
	codexDevhubInstructions,
	codexGuiInstructions,
	devhubSkillPaths,
	withDevhubSkill,
} from "../agent/devhubSkill.js";
import { EVENT_TYPES } from "./events.js";
import {
	codexOrchestratorInstructions,
	isOrchestratorAgent,
	orchestratorSkillAnswer,
	orchestratorSkillPaths,
	orchestratorSkillText,
	withOrchestratorSkill,
	writeOrchestratorSkill,
} from "./orchestratorSkill.js";

const userData = "/Users/d/Library/Application Support/DevHub";
const devhub = devhubSkillPaths(userData);
const skill = orchestratorSkillPaths(userData);

describe("the /devhub-orchestrator skill", () => {
	let scratch: string | undefined;
	afterEach(() => {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	it("lives in DevHub's own directory, apart from /devhub's", () => {
		expect(skill).toEqual({
			root: `${userData}/devhub/orchestrator-skill`,
			skillFile: `${userData}/devhub/orchestrator-skill/.claude/skills/devhub-orchestrator/SKILL.md`,
		});
		expect(skill.root).not.toBe(devhub.root);
	});

	it("is written on every start, and is what skill --orchestrator prints", () => {
		scratch = mkdtempSync(join(tmpdir(), "dh-orch-skill-"));
		const paths = orchestratorSkillPaths(scratch);
		const cli = devhubSkillPaths(scratch).cli;
		writeOrchestratorSkill(paths, cli);
		writeOrchestratorSkill(paths, cli);
		const written = readFileSync(paths.skillFile, "utf8");
		expect(written).toBe(orchestratorSkillText(cli));
		expect(orchestratorSkillAnswer(scratch)).toEqual({
			text: written,
			cli,
			skillFile: paths.skillFile,
		});
	});

	it("gives the orchestrator's Claude a second --add-dir, after /devhub's, once", () => {
		const profile = { kind: "claude" as const, args: ["--model", "opus"] };
		const both = withOrchestratorSkill(withDevhubSkill(profile, devhub), skill);
		expect(both.args).toEqual([
			"--model",
			"opus",
			`--add-dir=${devhub.root}`,
			`--add-dir=${skill.root}`,
		]);
		expect(withOrchestratorSkill(both, skill).args).toHaveLength(4);
	});

	it("leaves an ordinary agent's argv and Codex instructions as /devhub has them", () => {
		const claude = { kind: "claude" as const, args: [] };
		const ordinary = withOrchestratorSkill(
			withDevhubSkill(claude, devhub),
			undefined,
		);
		expect(ordinary.args).toEqual([`--add-dir=${devhub.root}`]);
		expect(ordinary.args.join(" ")).not.toContain("orchestrator-skill");
		const codex = { kind: "codex" as const, args: ["app-server"] };
		expect(withOrchestratorSkill(codex, skill)).toBe(codex);
		expect(codexGuiInstructions(devhub)).toBe(
			`${codexDevhubInstructions(devhub)}\n\n${GUI_AGENT_INSTRUCTIONS}`,
		);
		expect(codexGuiInstructions(devhub)).not.toContain(skill.skillFile);
	});

	it("points the orchestrator's Codex thread at the same file", () => {
		const text = codexGuiInstructions(devhub, [
			codexOrchestratorInstructions(skill),
		]);
		expect(text).toBe(
			[
				codexDevhubInstructions(devhub),
				codexOrchestratorInstructions(skill),
				GUI_AGENT_INSTRUCTIONS,
			].join("\n\n"),
		);
		expect(codexOrchestratorInstructions(skill)).toContain(skill.skillFile);
		expect(codexOrchestratorInstructions(skill)).toContain(
			"/devhub-orchestrator",
		);
	});

	it("is the orchestrator's only: the assigned agent, or the one orchestrator start is making", () => {
		const agents = new Map([["ws-orch", ["old", "new"]]]);
		const agentsIn = (id: string) => agents.get(id) ?? [];
		// Nobody is the orchestrator: nobody gets it.
		for (const id of ["old", "new", "other"])
			expect(
				isOrchestratorAgent(id, {
					assigned: undefined,
					starting: undefined,
					agentsIn,
				}),
			).toBe(false);
		// The assigned one, on every restart and thread start.
		expect(
			isOrchestratorAgent("orch", {
				assigned: "orch",
				starting: undefined,
				agentsIn,
			}),
		).toBe(true);
		expect(
			isOrchestratorAgent("other", {
				assigned: "orch",
				starting: undefined,
				agentsIn,
			}),
		).toBe(false);
		// While starting: the new agent in its workspace, not the ones already there.
		const starting = { workspaceId: "ws-orch", before: new Set(["old"]) };
		expect(
			isOrchestratorAgent("new", { assigned: undefined, starting, agentsIn }),
		).toBe(true);
		expect(
			isOrchestratorAgent("old", { assigned: undefined, starting, agentsIn }),
		).toBe(false);
		expect(
			isOrchestratorAgent("elsewhere", {
				assigned: undefined,
				starting,
				agentsIn,
			}),
		).toBe(false);
	});

	it("is a skill named devhub-orchestrator that runs this DevHub's launcher", () => {
		const text = orchestratorSkillText(devhub.cli);
		expect(
			text.startsWith("---\nname: devhub-orchestrator\ndescription: "),
		).toBe(true);
		expect(text).toContain(`"${devhub.cli}"`);
		expect(text).not.toContain("\\`");
	});

	it("covers the lanes, the event types, the interview and the settings it hands over", () => {
		const text = orchestratorSkillText(devhub.cli);
		for (const word of [
			"要回答",
			"対応中",
			"不明",
			"{EVENT}",
			"{EVENT_JSON}",
			"init",
			"escalation_answered",
			"unaccounted",
			"github.lane_changed",
			"github.pr_merged",
			"workspace.issue_assigned",
			"agent.turn_ended",
			"agent.asked",
			"agent.permission_requested",
			"timer.elapsed",
			"custom.",
			"orchestrator events",
			"event_prompt",
			"init_prompt",
			"settings.toml は書かない",
			"ヒアリング",
			"decisions.md",
			"背景",
			"選択肢と推奨",
			"回答後に起きること",
			"AGENTS.md",
			"name: make-progress",
		])
			expect({ word, found: text.includes(word) }).toEqual({
				word,
				found: true,
			});
	});
});

describe("the /devhub-orchestrator skill's event table", () => {
	const text = orchestratorSkillText("/x/devhub");

	it("names every event type DevHub sends", () => {
		for (const type of EVENT_TYPES)
			expect({ type, found: text.includes(`\`${type}\``) }).toEqual({
				type,
				found: true,
			});
	});

	it("names no type DevHub does not send", () => {
		const named = [
			...text.matchAll(/`((?:github|workspace|agent|timer|usage)\.[a-z_]+)`/gu),
		].map((match) => match[1]!);
		expect(named.length).toBeGreaterThan(20);
		for (const type of named)
			expect({
				type,
				known: (EVENT_TYPES as readonly string[]).includes(type),
			}).toEqual({ type, known: true });
	});

	it("shows lines in the format DevHub writes them", () => {
		expect(text).toContain(
			"[agent.turn_ended] agent=a1b2c3d4 (API fix) ws=login-fix since=e39 — 「テストを追加しました。残りは…」",
		);
	});
});

/** A command line split as a shell would: words, and "quoted words". */
function shellWords(line: string): string[] {
	const words: string[] = [];
	for (const match of line.matchAll(/"([^"]*)"|(\S+)/gu))
		words.push(match[1] ?? match[2]!);
	return words;
}

describe("the /devhub-orchestrator skill's examples", () => {
	const examples = orchestratorSkillText("/x/devhub")
		.split("\n")
		.filter((line) => /^ {4,}devhub --tell /u.test(line))
		.map((line) =>
			line
				.replace(/\s+# .*$/u, "")
				.replace(/\[[^\]]*\]/gu, "")
				.trim(),
		);

	it("are there", () => {
		expect(examples.length).toBeGreaterThan(20);
	});

	it("are every one a command --tell takes", () => {
		for (const example of examples) {
			const parsed = parseTellArguments(
				shellWords(example).slice("devhub --tell".split(" ").length),
			);
			expect({
				example,
				kind: parsed.kind,
				...(parsed.kind === "invalid" ? { message: parsed.message } : {}),
			}).toEqual({ example, kind: "tell" });
		}
	});
});
