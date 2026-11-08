/**
 * `TerminalNeovims` joined to the rest of DevHub: tmux on each machine for
 * its readings and commands, the socket forward for a host, the theme for a
 * Neovim just attached, and the window for its pages and its keys. Kept out
 * of `appController.ts`, which only builds it and tells it the terminals.
 */

import { mkdir } from "node:fs/promises";
import { NeovimClient } from "./neovimRpc.js";
import { PUBLISH_THEME_LUA } from "./managedNeovim.js";
import { forwardedSocketPath } from "./neovimMachines.js";
import {
	parseTerminalNeovimReading,
	TerminalNeovims,
	type OverlayTerminal,
} from "./terminalNeovims.js";
import type { TmuxTerminalRuntime } from "../terminal/tmux.js";
import type { Runtime, RuntimeId } from "../runtime/runtime.js";
import type { ShellWindow } from "../shell/shellWindow.js";
import {
	themeEnvironment,
	type PublishedTheme,
} from "../../model/publishedTheme.js";
import type { AgentTerminal } from "../../model/agentTerminal.js";

export interface TerminalNeovimWiringOptions {
	readonly tmuxOf: (machine: RuntimeId) => Promise<TmuxTerminalRuntime>;
	readonly runtimeById: (machine: RuntimeId) => Runtime;
	/** Where a host's socket is forwarded to, here. */
	readonly forwardDirectory: string;
	readonly shell: () => ShellWindow | undefined;
	readonly theme: () => PublishedTheme | undefined;
}

export function wireTerminalNeovims(
	options: TerminalNeovimWiringOptions,
): TerminalNeovims {
	const log = (line: string) => {
		console.error(line);
	};
	const neovims: TerminalNeovims = new TerminalNeovims({
		changed: () => {
			options.shell()?.syncTerminalNeovims(neovims.views());
		},
		ports: {
			read: async (terminal, announce) => {
				const tmux = await options.tmuxOf(terminal.machine);
				// Written once per run, so a terminal that outlived the last
				// DevHub runs this one's `nvim`, not the one it left.
				if (announce) await tmux.ensureNeovimShim();
				const output = await tmux.terminalNeovimReading(
					terminal.terminalId,
					announce,
				);
				return output === undefined
					? undefined
					: parseTerminalNeovimReading(output);
			},
			claim: async (terminal, paneId) => {
				await (
					await options.tmuxOf(terminal.machine)
				).terminalNeovimCommand({ kind: "claim", paneId });
			},
			selectPane: async (terminal, paneId) => {
				await (
					await options.tmuxOf(terminal.machine)
				).terminalNeovimCommand({ kind: "select", paneId });
			},
			enterPrefix: async (terminal, client) => {
				await (
					await options.tmuxOf(terminal.machine)
				).terminalNeovimCommand({ kind: "prefix", client });
			},
			reach: async (terminal, socket) => {
				if (terminal.machine === "local") return socket;
				await mkdir(options.forwardDirectory, {
					recursive: true,
					mode: 0o700,
				});
				return options
					.runtimeById(terminal.machine)
					.forwardUnixSocket(
						socket,
						forwardedSocketPath(
							options.forwardDirectory,
							terminal.machine,
							socket,
						),
					);
			},
			attached: (localPath) => {
				const theme = options.theme();
				if (theme === undefined) return;
				void (async () => {
					const client = await NeovimClient.connect(localPath);
					try {
						await client.request("nvim_exec_lua", [
							PUBLISH_THEME_LUA,
							[theme, themeEnvironment(theme, undefined)],
						]);
					} finally {
						client.close();
					}
				})().catch((error: unknown) => {
					log(
						`[devhub] a terminal's Neovim was not told the theme: ${String(error)}`,
					);
				});
			},
			log,
		},
	});
	options.shell()?.setTerminalNeovimHooks(neovims);
	return neovims;
}

/** The Agent terminals there are, on their machines, for `setTerminals`. */
export function overlayTerminals<Terminal extends AgentTerminal>(
	terminals: readonly Terminal[],
	machineOf: (terminal: Terminal) => RuntimeId | undefined,
): OverlayTerminal[] {
	return terminals.flatMap((terminal) => {
		const machine = machineOf(terminal);
		return machine === undefined
			? []
			: [{ terminalId: terminal.terminalId, machine }];
	});
}
