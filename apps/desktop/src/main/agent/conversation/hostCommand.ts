/**
 * Where a GUI Agent's host keeps its files, and the session command that
 * starts it.
 *
 * The launch itself is `tmux.launchAgent`, unchanged: a GUI Agent's session is
 * created, marked, listed and killed exactly as a TUI Agent's is. What differs
 * is only the command handed to it, and this is the one place that composes
 * it.
 */

import { posix } from "node:path";
import { isCanonicalUuid, type AgentProfile } from "../../../model/domain.js";
import type { Runtime } from "../../runtime/runtime.js";
import type { AgentSessionCommand } from "../../terminal/ports.js";
import { claudeStructuredCommand } from "./claude/argv.js";
import { HOST_NAME, HOST_SCRIPT } from "./hostScript.js";
import { codexStructuredArgs, withSession } from "./resume.js";

/**
 * What an Agent id may look like to become a directory name.
 *
 * The ids are UUIDs DevHub mints, so anything else reaching here is a bug and
 * not a name to sanitise: a `/` or a `..` in it would put a host's files, and
 * a later `removeTree`, somewhere other than under `agents/`.
 */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;

/** What a profile tag (`remoteProfileTag`) looks like: a hex digest. */
const PROFILE_TAG = /^[0-9a-f]+$/u;

/**
 * `<home>/.devhub/agents-<profile tag>`: one DevHub profile's host directories
 * on a machine.
 *
 * Per profile, like the `bin-<tag>` beside it, because two DevHubs — two
 * profiles on this Mac — reach the same home, and each accounts only for its
 * own Agents: a directory shared between them would be one whose every entry
 * the other profile's sweep takes for an Agent nobody has.
 */
function agentsDirectory(home: string, profileTag: string): string {
	if (!PROFILE_TAG.test(profileTag)) {
		throw new Error(
			`${JSON.stringify(profileTag)} is not a profile tag DevHub makes, so it cannot name a directory`,
		);
	}
	return posix.join(home, ".devhub", `agents-${profileTag}`);
}

/**
 * `<home>/.devhub/agents-<profile tag>/<agentId>` on the Agent's machine.
 *
 * Beside `~/.devhub/terminal` and `~/.devhub/tmp`, which DevHub already keeps
 * on a far machine, and built from `Runtime.home()` on this one too, so there
 * is one rule for where a host's files are rather than one per machine.
 */
export function agentStateDirectory(
	home: string,
	profileTag: string,
	agentId: string,
): string {
	if (!AGENT_ID.test(agentId)) {
		throw new Error(
			`${JSON.stringify(agentId)} is not an Agent id DevHub mints, so it cannot name a directory`,
		);
	}
	return posix.join(agentsDirectory(home, profileTag), agentId);
}

/**
 * Every GUI Agent host directory on a machine, by Agent id, and the removal
 * of one.
 *
 * Only a name DevHub could have made is listed: anything else under
 * `agents/` is not a host directory, and DevHub does not remove what it did
 * not make.
 */
export async function agentHostFiles(
	runtime: Runtime,
	profileTag: string,
): Promise<{
	list(): Promise<readonly string[]>;
	remove(agentId: string): Promise<void>;
}> {
	const home = await runtime.home();
	const root = agentsDirectory(home, profileTag);
	return {
		async list() {
			if ((await runtime.stat(root)) === "absent") return [];
			return (
				(await runtime.readdir(root))
					// An Agent id DevHub mints is a canonical UUID, and nothing
					// else here is a host directory of this profile's.
					.filter((entry) => entry.directory && isCanonicalUuid(entry.name))
					.map((entry) => entry.name)
			);
		},
		remove: (agentId) =>
			runtime.removeTree(agentStateDirectory(home, profileTag, agentId)),
	};
}

/**
 * The session command that runs `cli` under the host.
 *
 * `/bin/sh -c <script> devhub-agent-host <state dir> <cli argv…>`: the script
 * rides in argv, so there is nothing to install on any machine, and the CLI's
 * own argv follows it as positional words, so nothing in it is ever
 * re-parsed by a shell. The profile's environment is the session's, as it is
 * for a TUI Agent.
 */
/**
 * Put `lines` at the head of a new Agent's journal, before its host starts:
 * the one thing DevHub ever writes to `out`, and only while nothing else can.
 */
export async function seedJournal(
	runtime: Runtime,
	stateDirectory: string,
	lines: readonly string[],
): Promise<void> {
	if (lines.length === 0) return;
	await runtime.writeTextFile(
		posix.join(stateDirectory, "out"),
		lines.map((line) => `${line}\n`).join(""),
		0o600,
	);
}

export function hostSessionCommand(
	stateDirectory: string,
	cli: AgentSessionCommand,
): AgentSessionCommand {
	return {
		file: "/bin/sh",
		args: ["-c", HOST_SCRIPT, HOST_NAME, stateDirectory, cli.file, ...cli.args],
		env: cli.env,
	};
}

/**
 * The CLI a GUI Agent's host runs: `profile`'s command in the structured mode
 * its adapter reads, on the session its record picks — or, given `session`,
 * on the one a rewind or a `/resume` picks in its place (`withSession`), which
 * is the whole argv the host starts it again with.
 *
 * Only Claude and Codex can be GUI Agents — the domain refuses any other kind
 * a GUI presentation — so reaching another kind here is that rule broken.
 */
export function guiAgentCli(
	profile: Pick<AgentProfile, "kind" | "command" | "args" | "env">,
	session?: readonly string[],
): AgentSessionCommand {
	const cli: AgentSessionCommand = {
		file: profile.command,
		args:
			session === undefined
				? [...profile.args]
				: withSession(profile.kind, profile.args, session),
		env: Object.fromEntries(profile.env),
	};
	switch (profile.kind) {
		case "claude":
			return claudeStructuredCommand(cli);
		case "codex":
			return { ...cli, args: codexStructuredArgs(cli.args).args };
		default:
			throw new Error(`a ${profile.kind} Agent cannot be a GUI Agent`);
	}
}
