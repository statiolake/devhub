import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	codexDevhubInstructions,
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

	it("points Codex at the same file", () => {
		expect(codexDevhubInstructions(skill)).toContain(skill.skillFile);
		expect(codexDevhubInstructions(skill)).toContain("/devhub");
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
		// Again, as every start does.
		writeDevhubSkill(paths, "#!/bin/sh\nexit 1\n");
		expect(readFileSync(paths.cli, "utf8")).toBe("#!/bin/sh\nexit 1\n");
	});
});
