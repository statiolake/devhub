/**
 * `/devhub`: the skill DevHub gives the Agents it starts, so that an Agent can
 * be asked to drive DevHub itself — open a workspace, start another Agent,
 * hand an Issue on, watch the others and answer their questions — through
 * `devhub --tell`.
 *
 * Nothing of the person's is touched: no `~/.claude`, no `~/.codex`. DevHub
 * writes the skill into its own user-data directory on every start, beside a
 * `devhub` launcher that names this DevHub's socket, and points the Agents it
 * launches at it:
 *
 * - Claude (terminal and GUI): `--add-dir=<root>`. Claude Code loads
 *   `<dir>/.claude/skills/*` from every added directory as ordinary,
 *   un-namespaced skills — so the person types `/devhub`, not the
 *   `/devhub:devhub` a `--plugin-dir` plugin would be. (Checked against
 *   Claude Code 2.1: the `skills` list `system/init` reports includes
 *   `devhub` with `--add-dir=<root>` and not without.) The `=` form matters:
 *   `--add-dir` takes several directories, and a bare one would swallow the
 *   arguments after it.
 * - Codex (GUI): the thread's `developerInstructions` say that `/devhub` and
 *   `$devhub` mean "read and follow this SKILL.md". Codex has no flag that
 *   adds a skills directory, and its own skill roots are the person's.
 *
 * Agents on another machine (an SSH host) get the same text, written there
 * under `~/.devhub/terminal/skill-<tag>/` by `RemoteShellRuntime.terminalLauncher`
 * beside the `devhub` shim DevHub installs on that machine, whose full path
 * it names. That shim reaches this DevHub over the control socket
 * reverse-forwarded onto the host (`ssh -O forward -R`), and says which
 * machine it is on, so paths it sends are read there (`docs/remote-ssh.md`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "../../model/domain.js";

export interface DevhubSkill {
	/** The directory handed to Claude's `--add-dir`. */
	readonly root: string;
	/** The SKILL.md itself, for Codex's instructions. */
	readonly skillFile: string;
	/** The launcher the skill tells the Agent to run. */
	readonly cli: string;
}

export function devhubSkillPaths(userDataPath: string): DevhubSkill {
	const root = join(userDataPath, "devhub", "agent-skill");
	return {
		root,
		skillFile: join(root, ".claude", "skills", "devhub", "SKILL.md"),
		cli: join(root, "bin", "devhub"),
	};
}

/** Write the skill and its launcher. Called on every start: the paths in them move with the app. */
export function writeDevhubSkill(skill: DevhubSkill, launcher: string): void {
	mkdirSync(join(skill.root, ".claude", "skills", "devhub"), {
		recursive: true,
		mode: 0o700,
	});
	mkdirSync(join(skill.root, "bin"), { recursive: true, mode: 0o700 });
	writeFileSync(skill.cli, launcher, { mode: 0o700 });
	writeFileSync(skill.skillFile, devhubSkillText(skill.cli), { mode: 0o600 });
}

/**
 * The profile an Agent on this machine is launched with: the person's own
 * arguments, then the one that makes `/devhub` a skill. Codex is told in its
 * thread instead (`codexDevhubInstructions`), so its argv is left alone.
 */
export function withDevhubSkill<T extends Pick<AgentProfile, "kind" | "args">>(
	profile: T,
	skill: DevhubSkill | undefined,
): T {
	if (skill === undefined || profile.kind !== "claude") return profile;
	const flag = `--add-dir=${skill.root}`;
	if (profile.args.includes(flag)) return profile;
	return { ...profile, args: [...profile.args, flag] };
}

export function codexDevhubInstructions(skill: DevhubSkill): string {
	return [
		"DevHub skill: when the user's message starts with /devhub or $devhub, or asks you to drive DevHub",
		"(open a workspace, start or hand work to another agent, check on or answer other agents),",
		`read ${skill.skillFile} and follow it. It explains the \`${skill.cli} --tell\` command.`,
	].join(" ");
}

export function devhubSkillText(cli: string): string {
	return `---
name: devhub
description: Drive DevHub, the app this agent runs in - open workspaces, start agents, hand GitHub Issues to new agents with a good branch name, and monitor, message and answer other agents. Use when the user says /devhub or asks to delegate work to another agent in DevHub.
---

# /devhub - drive DevHub from here

You are running inside DevHub. This command talks to the running DevHub app:

    "${cli}"

It is called \`devhub\` below; always run it by that full path, in double
quotes (the path may contain spaces), e.g. \`"${cli}" --tell agents\`. Everything it
does is something the person could do in DevHub's window; you are doing it for
them.

**When asked via /devhub, delegate - do not do the work yourself.** "/devhub
handle this Issue" means: start another agent on it and report back. Do not
start editing the Issue's code in your own session.

Add \`--json\` right after \`--tell\` for machine-readable output (recommended
when you parse results): \`devhub --tell --json agents\`.
Full reference: \`devhub --tell help\`.

## Look around

    devhub --tell workspaces                # id, name, folder, branch, Issue, agents
    devhub --tell agents [--workspace W]    # id, name, kind, status, unread, open requests

W is a workspace id, its folder path, its name, or \`scratch\`. Folder paths
are paths on the machine you run on (on an SSH host, the host's); without
\`--workspace\`, \`agent new\` uses your own workspace. Agents are
named by id (a unique prefix of 4+ characters works) or by their name.
Status is one of working, background, waiting (needs somebody), idle, error.

## Open a workspace and start an agent there

    devhub --tell workspace open ~/src/app
    devhub --tell agent new --workspace ~/src/app [--profile claude] [--name "API fix"] --prompt "Fix the failing test in api/"

\`workspace open\` answers the workspace id. Profiles are the person's
configured agent profiles; leave \`--profile\` out to use the first one.
\`--prompt\` is typed into the new agent once it is ready. For long prompts
use \`--prompt -\` and pipe the text in on stdin.

## Hand a GitHub Issue (or PR) to a new agent

    devhub --tell issue assign https://github.com/OWNER/REPO/issues/123 --branch 123-fix-login-timeout

- Read the Issue first (title/body, e.g. with \`gh issue view\`) and choose a
  short descriptive branch name: \`<number>-<a-few-words>\`, lowercase, words
  joined by \`-\`, e.g. \`123-fix-login-timeout\`. Keep the Issue number first;
  DevHub links a workspace to its Issue by it. Without \`--branch\` DevHub uses
  \`feature/<number>-wip\`. For a pull request leave \`--branch\` out: its own
  branch is used.
- DevHub finds a clone of the repository (\`--repo <path>\` picks one), makes
  a worktree for the branch (\`--root\` checks it out in the clone instead),
  opens it as a workspace and starts an agent with the person's Issue action.
- \`--prompt "..."\` adds your own instructions for the new agent (scope,
  constraints, what the person said). \`--profile\` and \`--action\` pick the
  agent profile and Issue action; \`--editor-only\` opens the editor without
  an agent.

Then tell the person which agent took it (id, workspace, branch).

## Monitor other agents

    devhub --tell agent wait A --until any --timeout 300   # returns when A is idle or waiting
    devhub --tell agent read A --last 20                   # transcript tail (GUI agents)
    devhub --tell agent read A --since CURSOR              # only what is new since the last read

\`agent read\` prints a cursor on its last line (\`cursor ...\`; \`cursor\` in
JSON); pass it to \`--since\` next time. \`agent wait\` is the way to wait: do
not poll in a tight loop.

## Talk to them

    devhub --tell agent send A "Please also add a test for the empty case."
    devhub --tell agent interrupt A

A message to a busy agent is held and delivered when its turn ends, just like
the person's composer does. Terminal agents get it typed in once they are
idle; reading, interrupting and answering need a GUI agent.

## Answer their questions

    devhub --tell agent requests A
    devhub --tell agent answer A REQUEST_ID --option 2
    devhub --tell agent answer A REQUEST_ID --text "Use PostgreSQL"

Only questions (AskUserQuestion-style) can be answered here. Permission
prompts (may a tool run) are listed as "answer in DevHub": they are the
person's decision - tell the person, never try to get around it. When unsure
what the person would want, ask the person instead of answering. Your answer
is recorded in that agent's transcript as answered via devhub CLI by you.

## Other

    devhub --tell commands            # DevHub's command palette, by id
    devhub --tell run <command-id>    # run one (DevHub still asks the person where it would)
    devhub --tell focus A|W           # select an agent or workspace in DevHub
    devhub --tell notify "Agent X finished the migration"

If a command fails, its message says why; fix the arguments rather than
retrying the same thing.
`;
}
