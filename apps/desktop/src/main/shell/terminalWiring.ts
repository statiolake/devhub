/**
 * Where DevHub's terminals get built, and what a surface key means to them.
 *
 * A DevHub terminal is not a process the app owns for the length of a window:
 * it is a tmux session on DevHub's own socket, with the surface being one
 * `tmux attach-session` client over a PTY. That is the whole point — a session
 * survives closing the surface, switching workspace, quitting the app and
 * restarting it, and the same shell is there when you come back.
 *
 * So two things live here. The runtime is constructed from the three places its
 * inputs come from — the config (which tmux, which shell, which socket), the
 * resolved executables (where they actually are), and the persisted state
 * (which socket is in effect) — and the surface-key grammar is translated into
 * the runtime's targets.
 */

import { homedir } from "node:os";
import {
	SCRATCH_TARGET,
	agentTarget,
	socketName,
	workspaceTarget,
	type TerminalTarget,
} from "../terminal/ports.js";
import {
	TmuxTerminalRuntime,
	type RuntimeExecutable,
} from "../terminal/tmux.js";
import {
	registerTerminalService,
	type TerminalService,
} from "../terminal/service.js";
import type { Config } from "../../model/config.js";
import type { AppModel } from "../../model/appModel.js";
import {
	agentId as parseAgentId,
	isWorkspaceClosing,
	workspaceId as parseWorkspaceId,
	type Workspace,
} from "../../model/domain.js";
import { TerminalFailure } from "../../ipc/terminal.js";
import {
	runtimeUnavailableMessage,
	type SettingsResolvedRuntimeWire,
} from "../../ipc/settings.js";
import { registerTerminalAdapter } from "./adapters.js";

/**
 * A Workspace that is closing answers nothing, and says so.
 *
 * This is the entrance the close needed. Removing a worktree deletes the
 * folder and closes the workspace that held it, and for the length of that gap
 * a terminal operation used to be accepted and then fail somewhere inside — in
 * a directory that had just stopped existing — which reported a runtime
 * problem for a workspace that was simply on its way out. The refusal moves to
 * the front, where the state is already known: `closing` is a fact about the
 * workspace, not a race to lose.
 *
 * It is a refusal and not an absence. `undefined` from the resolver means
 * "there is no such surface", which is the wrong sentence for a surface that
 * exists and is being taken away, and it is the difference between a person
 * reading "this workspace is closing" and reading nothing at all.
 */
function refuseIfClosing(workspace: Workspace): void {
	if (isWorkspaceClosing(workspace.state)) {
		throw new TerminalFailure("workspace_closing");
	}
}

/**
 * The whole surface-key grammar, in one function.
 *
 * All three keys name a tmux session on the same socket, so all three are
 * answered here rather than by a second resolver for Agents. An Agent's
 * workspace is not part of its key — the model owns which workspace an Agent
 * belongs to, and asking it is what keeps the two from disagreeing.
 *
 * It takes the model by function rather than by value because the model is
 * rebuilt underneath the wiring and a captured reference would answer for a
 * model that is no longer the one in use.
 */
export function createSurfaceResolver(
	model: () => AppModel,
): (surfaceKey: string) => TerminalTarget | undefined {
	return (surfaceKey) => {
		if (surfaceKey === "global-terminal") return SCRATCH_TARGET;
		const agentPrefix = "agent:";
		if (surfaceKey.startsWith(agentPrefix)) {
			const raw = surfaceKey.slice(agentPrefix.length);
			let agent;
			try {
				agent = parseAgentId(raw);
			} catch {
				return undefined;
			}
			const workspace = model().workspaceForAgent(agent);
			if (!workspace) return undefined;
			// An Agent closes with its Workspace, so it is refused for the same
			// reason and in the same words.
			refuseIfClosing(workspace);
			return agentTarget(agent, workspace.id, workspace.root);
		}
		const prefix = "workspace-terminal:";
		if (!surfaceKey.startsWith(prefix)) return undefined;
		const raw = surfaceKey.slice(prefix.length);
		let workspace;
		try {
			workspace = model().workspace(parseWorkspaceId(raw));
		} catch {
			// A key that is not a canonical identity names no workspace, which is
			// the same answer as one that names a workspace that is gone.
			return undefined;
		}
		if (!workspace) return undefined;
		refuseIfClosing(workspace);
		return workspaceTarget(workspace.id, workspace.root);
	};
}

/**
 * An executable the runtime can launch, or the sentence saying why not.
 *
 * The reason is kept rather than reduced to `undefined`: a pane that refuses
 * to attach an hour later has no other way to say which executable was missing
 * and where DevHub looked for it.
 */
function executable(
	resolved: SettingsResolvedRuntimeWire,
	configured: string,
): RuntimeExecutable {
	if (resolved.kind === "unavailable") {
		return {
			kind: "unavailable",
			reason: runtimeUnavailableMessage(resolved),
		};
	}
	return {
		kind: "resolved",
		value: {
			path: resolved.value,
			basename: configured.split("/").at(-1) ?? configured,
		},
	};
}

export interface TerminalWiringOptions {
	readonly config: Config | undefined;
	readonly resolved: {
		readonly tmux: SettingsResolvedRuntimeWire;
		readonly shell: SettingsResolvedRuntimeWire;
	};
	/**
	 * The one environment every DevHub child is launched with, resolved once at
	 * startup (see `loginEnvironment.ts`). The terminal must not observe an
	 * environment that changed under it, and the shell inside tmux inherits
	 * exactly this — the same environment the executables above were resolved
	 * in, so a tmux DevHub found is a tmux the shell can find too.
	 */
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly effectiveSocketName: string;
	readonly userDataPath: string;
	/** The live model, for turning a workspace id into its canonical root. */
	readonly model: () => AppModel;
}

export interface TerminalWiring {
	readonly runtime: TmuxTerminalRuntime;
	readonly service: TerminalService;
}

/**
 * Build the terminal runtime and put it behind the surface keys the App Shell
 * already uses. `global-terminal` is the scratch session; a workspace's
 * terminal is named from its canonical root, which is what makes the session
 * findable again after a restart.
 */
export function wireTerminals(options: TerminalWiringOptions): TerminalWiring {
	const config = options.config;
	const runtime = new TmuxTerminalRuntime({
		context: {
			home: homedir(),
			environment: options.environment,
		},
		tmux: executable(options.resolved.tmux, config?.runtimes.tmux ?? "tmux"),
		shell: shellExecutable(options.resolved.shell, config),
		tmuxArgs: config?.runtimes.tmux_args ?? [],
		effectiveSocketName: options.effectiveSocketName,
		bootstrapDirectory: options.userDataPath,
	});

	const resolveSurface = createSurfaceResolver(options.model);

	const service = registerTerminalService({ runtime, resolveSurface });

	// What a close confirmation says about this workspace's terminals, and what
	// closing it actually does, both come from the runtime.
	registerTerminalAdapter({
		async closeWorkspaceTerminals(id) {
			const workspace = options.model().workspace(id);
			if (!workspace) return;
			await service.surfaces.closeWorkspace({
				workspaceId: workspace.id,
				root: workspace.root,
			});
		},
		async inspect(id) {
			const workspace = options.model().workspace(id);
			const clean = { kind: "clean" } as const;
			if (!workspace || !runtime.adapterAvailable) {
				return { processes: clean, panes: clean, windows: clean };
			}
			const inspection = await runtime.inspect(
				workspaceTarget(workspace.id, workspace.root),
			);
			return {
				processes: inspection.process,
				panes: inspection.extraPanes,
				windows: inspection.extraWindows,
			};
		},
	});

	return { runtime, service };
}

/**
 * The shell is used for its basename only — tmux is told which shell to start,
 * and inspection reads it back — so an unresolved one is simply absent. It has
 * no failure of its own to report: nothing attaches to a shell.
 */
function shellExecutable(
	resolved: SettingsResolvedRuntimeWire,
	config: Config | undefined,
): { path: string; basename: string } | undefined {
	if (resolved.kind === "unavailable") return undefined;
	const configured = config?.runtimes.shell ?? "/bin/zsh";
	return {
		path: resolved.value,
		basename: configured.split("/").at(-1) ?? configured,
	};
}

export { socketName };
