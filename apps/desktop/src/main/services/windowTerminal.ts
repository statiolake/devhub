/**
 * What one workbench window is told its DevHub terminal is, and how that gets
 * to the window.
 *
 *   - `devhubTerminalLauncher`: the `devhub-terminal` the window's integrated
 *     terminal runs (`../terminal/launcher.ts`); absent in a window nothing
 *     hosts.
 *   - `devhubTerminalLocal`: where the DevHub terminal of a window attached to
 *     a dev container runs — on this Mac's pty host, in `cwd`, with the
 *     launcher given `args`. Absent in every other window.
 *
 * Both are fields of the window configuration
 * (`INativeWindowConfiguration`), which the patched `base/common/platform.ts`
 * reads synchronously in the renderer (`devhubTerminalLauncher`,
 * `devhubTerminalLocal`) — not entries in `userEnv`: the preload's
 * `Object.assign(process.env, userEnv)` lands on a copy of the sandboxed
 * renderer's environment snapshot, so a value there never reaches
 * `vscode.process.env`.
 *
 * They get there through `cli`. `WindowsMainService.openInBrowserWindow`
 * builds the configuration as `{ ...environmentMainService.args,
 * ...options.cli, ... }`, and every one of upstream's paths from `open` to
 * `openInBrowserWindow` hands `openConfig.cli` on untouched, so a field DevHub
 * puts into the `cli` of its own `open` call (`AppController`) arrives in the
 * configuration with no change to upstream's option types or its plumbing.
 *
 * What `cli` does not do is survive a request DevHub did not make. A window
 * reloaded through `open` — Remote - SSH resolves its authority that way — or
 * reopened after its renderer died is opened from a fresh configuration whose
 * `cli` is the process's arguments, and nobody told it which machine's
 * launcher the window had. The window's machine does not change across either,
 * so `DevHubWindowsMainService.openInBrowserWindow` carries the fields over
 * from the window being replaced (`inheritWindowTerminal`) where the request
 * does not state them. A window is only ever told this once, by the DevHub
 * call that opened it.
 */

/** The two per-window facts, as they appear in a window configuration. */
export interface WindowTerminal {
	readonly devhubTerminalLauncher?: string;
	readonly devhubTerminalLocal?: {
		readonly cwd: string;
		readonly args: readonly string[];
	};
}

/**
 * `cli` for DevHub's own `open` call, stating a window's terminal facts. The
 * launcher's key is always there, `undefined` included ("none on this
 * machine"): its presence is what says the request is DevHub's and states
 * both facts, so nothing is inherited into it.
 */
export function cliWithWindowTerminal<T extends object>(
	cli: T,
	terminal: WindowTerminal,
): T & WindowTerminal {
	return {
		...cli,
		devhubTerminalLauncher: terminal.devhubTerminalLauncher,
		...(terminal.devhubTerminalLocal === undefined
			? {}
			: { devhubTerminalLocal: terminal.devhubTerminalLocal }),
	};
}

/**
 * `options` for `openInBrowserWindow`, with the terminal facts of `replaced`'s
 * configuration in `cli` — unless the request is DevHub's own and states them
 * (`cliWithWindowTerminal`), or there is nothing to inherit, in which case
 * `options` comes back as it was.
 */
export function inheritWindowTerminal<O extends { readonly cli?: object }>(
	options: O,
	replaced: { readonly config?: unknown } | undefined,
): O {
	if (options.cli !== undefined && "devhubTerminalLauncher" in options.cli) {
		return options;
	}
	const from = replaced?.config as WindowTerminal | undefined;
	if (
		from?.devhubTerminalLauncher === undefined &&
		from?.devhubTerminalLocal === undefined
	) {
		return options;
	}
	return {
		...options,
		cli: cliWithWindowTerminal(options.cli ?? {}, from),
	};
}
