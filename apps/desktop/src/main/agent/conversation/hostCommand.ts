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
import type { AgentSessionCommand } from "../../terminal/ports.js";
import { HOST_NAME, HOST_SCRIPT } from "./hostScript.js";

/**
 * What an Agent id may look like to become a directory name.
 *
 * The ids are UUIDs DevHub mints, so anything else reaching here is a bug and
 * not a name to sanitise: a `/` or a `..` in it would put a host's files, and
 * a later `removeTree`, somewhere other than under `agents/`.
 */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;

/**
 * `<home>/.devhub/agents/<agentId>` on the Agent's machine.
 *
 * Beside `~/.devhub/terminal` and `~/.devhub/tmp`, which DevHub already keeps
 * on a far machine, and built from `Runtime.home()` on this one too, so there
 * is one rule for where a host's files are rather than one per machine.
 */
export function agentStateDirectory(home: string, agentId: string): string {
	if (!AGENT_ID.test(agentId)) {
		throw new Error(
			`${JSON.stringify(agentId)} is not an Agent id DevHub mints, so it cannot name a directory`,
		);
	}
	return posix.join(home, ".devhub", "agents", agentId);
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
