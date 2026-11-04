import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GUI_AGENT_INSTRUCTIONS } from "./conversation/linkInstructions.js";
import { parseTellArguments } from "../cli/tell/command.js";
import {
	codexDevhubInstructions,
	codexGuiInstructions,
	devhubSkillAnswer,
	devhubSkillPaths,
	devhubSkillText,
	withDevhubSkill,
	writeDevhubSkill,
} from "./devhubSkill.js";

const skill = devhubSkillPaths("/Users/d/Library/Application Support/DevHub");

describe("the /devhub skill", () => {
	let scratch: string | undefined;
	afterEach(() => {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	it("lives in DevHub's own directory, where Claude's --add-dir finds skills", () => {
		expect(skill).toEqual({
			root: "/Users/d/Library/Application Support/DevHub/devhub/agent-skill",
			skillFile:
				"/Users/d/Library/Application Support/DevHub/devhub/agent-skill/.claude/skills/devhub/SKILL.md",
			cli: "/Users/d/Library/Application Support/DevHub/devhub/agent-skill/bin/devhub",
		});
	});

	it("adds itself to a Claude profile's arguments, after the person's own, once", () => {
		const profile = { kind: "claude" as const, args: ["--model", "opus"] };
		const skilled = withDevhubSkill(profile, skill);
		expect(skilled.args).toEqual([
			"--model",
			"opus",
			`--add-dir=${skill.root}`,
		]);
		// The `=` form: a bare `--add-dir` takes every directory after it.
		expect(withDevhubSkill(skilled, skill).args).toHaveLength(3);
		expect(profile.args).toEqual(["--model", "opus"]);
	});

	it("leaves other kinds, and machines without the skill, alone", () => {
		const codex = { kind: "codex" as const, args: ["app-server"] };
		expect(withDevhubSkill(codex, skill)).toBe(codex);
		const claude = { kind: "claude" as const, args: [] };
		expect(withDevhubSkill(claude, undefined)).toBe(claude);
	});

	it("is a skill named devhub that runs this DevHub's launcher, quoted", () => {
		const text = devhubSkillText(skill.cli);
		expect(text.startsWith("---\nname: devhub\ndescription: ")).toBe(true);
		expect(text).toContain(`"${skill.cli}" --tell agents`);
		expect(text).toContain("123-fix-login-timeout");
		expect(text).toContain("delegate");
		expect(text).toContain("answer in DevHub");
	});

	it("says how to orchestrate other agents, leaving permission prompts to the person", () => {
		const text = devhubSkillText(skill.cli);
		expect(text).toContain("## Orchestrating other agents");
		expect(text).toContain("agent wait --any");
		expect(text).toContain("agent read A --since SINCE");
		expect(text).toContain("questions only");
		expect(text).toContain("agent stop A");
		expect(text).toContain("agent restart A");
		expect(text).toContain("agent resume ID");
		expect(text).toContain("devhub --tell notify");
		expect(text).toContain("Never try to approve it.");
		// Orchestrating is not a reason to start DevHub agents for subagent work.
		expect(text).toContain("**A subagent is not a DevHub agent.**");
	});

	it("says how to open, drive and close the agent's own terminal, and find a pane the person split", () => {
		const text = devhubSkillText(skill.cli);
		expect(text).toContain("## Your terminal");
		expect(text).toContain("terminal open [--command CMD] [--focus]");
		expect(text).toContain("terminal status");
		expect(text).toContain("terminal close");
		expect(text).toContain('send-keys -t "$P" -l --');
		expect(text).toContain("capture-pane -p");
		// "The terminal on the right" is the agent's own, whoever opened it.
		expect(text).toContain("右のターミナル");
		expect(text).toContain("Cmd+Q V");
		// A pane the person split inside it is found by position.
		expect(text).toContain("list-panes -s -t");
		expect(text).toContain("#{pane_left}");
		expect(text).toContain("右下のペーン");
		expect(text).toContain("bottom-right");
		expect(text).toContain("ask which one");
		// Nothing of the pane tree is left.
		expect(text).not.toContain("terminal resolve");
		expect(text).not.toContain("terminal list");
		expect(text).not.toContain("--split");
		expect(text).not.toContain("Cmd+Q S");
		// The template literal kept its own quoting: no stray backslash.
		expect(text).not.toContain("\\`");
		expect(codexDevhubInstructions(skill)).toContain("terminal");
	});

	it("points Codex at the same file", () => {
		expect(codexDevhubInstructions(skill)).toContain(skill.skillFile);
		expect(codexDevhubInstructions(skill)).toContain("/devhub");
	});

	it("tells a Codex GUI Agent how to link files, with the skill's pointer or without it", () => {
		expect(codexGuiInstructions(skill)).toBe(
			`${codexDevhubInstructions(skill)}\n\n${GUI_AGENT_INSTRUCTIONS}`,
		);
		expect(codexGuiInstructions(undefined)).toBe(GUI_AGENT_INSTRUCTIONS);
	});

	it("writes the skill and an executable launcher", () => {
		scratch = mkdtempSync(join(tmpdir(), "dh-skill-"));
		const paths = devhubSkillPaths(scratch);
		writeDevhubSkill(paths, "#!/bin/sh\nexit 0\n");
		expect(readFileSync(paths.skillFile, "utf8")).toBe(
			devhubSkillText(paths.cli),
		);
		expect(readFileSync(paths.cli, "utf8")).toBe("#!/bin/sh\nexit 0\n");
		expect(statSync(paths.cli).mode & 0o777).toBe(0o700);
		// What `--tell skill` prints is that file, byte for byte.
		expect(devhubSkillAnswer(scratch)).toEqual({
			text: readFileSync(paths.skillFile, "utf8"),
			cli: paths.cli,
		});
		// Again, as every start does.
		writeDevhubSkill(paths, "#!/bin/sh\nexit 1\n");
		expect(readFileSync(paths.cli, "utf8")).toBe("#!/bin/sh\nexit 1\n");
	});
});

/** A command line split as a shell would: words, and "quoted words". */
function shellWords(line: string): string[] {
	const words: string[] = [];
	for (const match of line.matchAll(/"([^"]*)"|(\S+)/gu))
		words.push(match[1] ?? match[2]!);
	return words;
}

describe("the /devhub skill's examples", () => {
	/** Every example line, `devhub --tell ...`, with its comment and [optional] parts gone. */
	const examples = devhubSkillText("/x/devhub")
		.split("\n")
		.filter((line) => /^ {4}devhub --tell /u.test(line))
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
			expect({ example, kind: parsed.kind }).toEqual({
				example,
				kind: "tell",
			});
		}
	});

	it("name every choice of the commands that start something", () => {
		const commands = examples
			.map((example) =>
				parseTellArguments(
					shellWords(example).slice("devhub --tell".split(" ").length),
				),
			)
			.flatMap((parsed) => (parsed.kind === "tell" ? [parsed.command] : []));
		const starting = commands.filter(
			(command) =>
				command.verb === "agent-new" || command.verb === "issue-assign",
		);
		expect(starting.map((command) => command.verb).sort()).toEqual([
			"agent-new",
			"issue-assign",
		]);
		for (const command of starting) {
			if (command.verb === "agent-new") {
				expect(command.workspace).toBeDefined();
				expect(command.profile).toBeDefined();
				expect(command.presentation).toBeDefined();
			}
			if (command.verb === "issue-assign") {
				expect(command.repo).toBeDefined();
				expect(command.branch ?? command.place).toBeDefined();
				expect(command.profile).toBeDefined();
				expect(command.presentation).toBeDefined();
				expect(command.action).toBeDefined();
				expect(command.start).toBeDefined();
			}
		}
	});
});
