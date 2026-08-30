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
	socketName,
	workspaceTarget,
	type TerminalTarget,
} from "../terminal/ports.js";
import { TmuxTerminalRuntime } from "../terminal/tmux.js";
import {
	registerTerminalService,
	type TerminalService,
} from "../terminal/service.js";
import type { Config } from "../../model/config.js";
import type { AppModel } from "../../model/appModel.js";
import { workspaceId as parseWorkspaceId } from "../../model/domain.js";
import type { SettingsResolvedRuntimeWire } from "../../ipc/settings.js";
import { registerTerminalAdapter } from "./adapters.js";

/** An executable the runtime can launch, or nothing if it was not found. */
function executable(
	resolved: SettingsResolvedRuntimeWire,
	configured: string,
): { path: string; basename: string } | undefined {
	if (resolved.kind === "unavailable") return undefined;
	const path = resolved.value;
	return { path, basename: configured.split("/").at(-1) ?? configured };
}

/**
 * The environment every DevHub child is launched with, frozen at startup.
 *
 * The terminal must not observe an environment that changed under it, and the
 * shell inside tmux inherits exactly this. `import_login_environment` is the
 * user's say over whether their login shell's environment is part of it; when
 * it is off, a child gets only what this process was started with.
 */
export function launchEnvironment(
	config: Config | undefined,
): Readonly<Record<string, string | undefined>> {
	const environment = { ...process.env };
	if (config && !config.general.import_login_environment) {
		// Nothing to strip: this process is what it is. The flag is honoured by
		// *not* going out to a login shell for more, which is the only thing the
		// option could mean for a process that is already running.
		return Object.freeze(environment);
	}
	return Object.freeze(environment);
}

export interface TerminalWiringOptions {
	readonly config: Config | undefined;
	readonly resolved: {
		readonly tmux: SettingsResolvedRuntimeWire;
		readonly shell: SettingsResolvedRuntimeWire;
	};
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
			environment: launchEnvironment(config),
		},
		tmux: executable(options.resolved.tmux, config?.runtimes.tmux ?? "tmux"),
		shell: executable(
			options.resolved.shell,
			config?.runtimes.shell ?? "/bin/zsh",
		),
		tmuxArgs: config?.runtimes.tmux_args ?? [],
		effectiveSocketName: options.effectiveSocketName,
		bootstrapDirectory: options.userDataPath,
	});

	const resolveSurface = (surfaceKey: string): TerminalTarget | undefined => {
		if (surfaceKey === "global-terminal") return SCRATCH_TARGET;
		const prefix = "workspace-terminal:";
		if (!surfaceKey.startsWith(prefix)) return undefined;
		const raw = surfaceKey.slice(prefix.length);
		let workspace;
		try {
			workspace = options.model().workspace(parseWorkspaceId(raw));
		} catch {
			// A key that is not a canonical identity names no workspace, which is
			// the same answer as one that names a workspace that is gone.
			return undefined;
		}
		if (!workspace) return undefined;
		return workspaceTarget(workspace.id, workspace.root);
	};

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

export { socketName };
