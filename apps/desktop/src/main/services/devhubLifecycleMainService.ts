/**
 * Restarting, translated into DevHub's vocabulary.
 *
 * In VS Code the application *is* the workbench, so "restart" means "quit this
 * process and start it again" and every window comes back because the process
 * does. In DevHub the workbench is a view inside an application that also
 * holds every other workspace, the terminals and the Agents. Upstream's
 * `relaunch()` is `app.relaunch()` + `app.quit()`, so a setting that wanted
 * one workbench reloaded took all of that down with it. That is the reported
 * damage, and it is not a bug in VS Code: it is a sentence in a language
 * DevHub does not speak, and it has to be translated rather than obeyed.
 *
 * There are exactly two things a caller can mean, and the request says which:
 *
 *   - **The process arguments must change** (`addArgs` / `removeArgs`). Only
 *     the developer paths ask for this — `--inspect-extensions=<port>` from
 *     the extension-host debugger and the extension profiler, `--trace` from
 *     the developer actions, dropping `--prof-startup` from the startup
 *     profiler. What they are after is a workbench running with different
 *     arguments, and DevHub gives them one: every workbench window reloads
 *     with the new command line. Nothing outside the workbench world moves.
 *   - **Nothing about the arguments changes** (`relaunch()` with no options).
 *     This is `hostService.restart()` — a display-language change, a setting
 *     marked as needing a restart, the shared-process crash notification.
 *     A reload cannot deliver those: `VSCODE_NLS_CONFIG` and the rest are
 *     burned into the process at launch. So the *whole of DevHub* has to go
 *     down, which is no longer a decision a workbench is entitled to make on
 *     its own — it costs the person every other workspace, every terminal and
 *     every Agent. DevHub asks them, and restarts only if they say yes.
 *
 * Reading which of the two a request is stands on its own in
 * `relaunchRequest.ts`, where it can be tested without an application; a
 * request that is neither throws there rather than being guessed at.
 *
 * `quit()` is deliberately **not** overridden. Once `relaunch()` no longer
 * calls it, every remaining caller is a person choosing File > Quit, which
 * really is a request to end DevHub, and DevHub's own `before-quit` handler in
 * `bootstrapShell.ts` already owns what happens next.
 *
 * Registered for `ILifecycleMainService` in `codeMain.ts`, at the registration
 * line rather than in `devhubApplication.ts`: `startup()` resolves the
 * lifecycle service before `initServices` runs, so a later substitution would
 * leave two lifecycle services side by side, each believing it is the one.
 *
 * A VS Code bump has to re-check: `LifecycleMainService`'s constructor
 * parameters, `relaunch` / `kill` / `reload` / `unload`, `IRelaunchOptions`
 * having exactly `addArgs` and `removeArgs`, and `CodeWindow.reload` only
 * honouring `cli` for an extension-development host (see below).
 */

import { electron } from "../electron.js";
import {
	LifecycleMainService,
	type IRelaunchOptions,
} from "code-oss-dev/out/vs/platform/lifecycle/electron-main/lifecycleMainService.js";
import { UnloadReason } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import { ILogService } from "code-oss-dev/out/vs/platform/log/common/log.js";
import { IStateService } from "code-oss-dev/out/vs/platform/state/node/state.js";
import { IEnvironmentMainService } from "code-oss-dev/out/vs/platform/environment/electron-main/environmentMainService.js";
import type { NativeParsedArgs } from "code-oss-dev/out/vs/platform/environment/common/argv.js";
import { appController } from "../shell/appController.js";
import { askToRestartDevHub } from "../shell/restartDevHub.js";
import { readRelaunchRequest } from "./relaunchRequest.js";

export class DevHubLifecycleMainService extends LifecycleMainService {
	constructor(
		@ILogService private readonly log: ILogService,
		@IStateService stateService: IStateService,
		@IEnvironmentMainService
		private readonly environment: IEnvironmentMainService,
	) {
		super(log, stateService, environment);
	}

	override async relaunch(options?: IRelaunchOptions): Promise<void> {
		const request = readRelaunchRequest(options, this.environment.args);
		if (request.kind === "reload-workbenches") {
			await this.reloadEveryWorkbench(request.cli);
			return;
		}
		await this.restartAllOfDevHub();
	}

	/**
	 * A restart that only the workbench world needs: reload every workbench.
	 *
	 * All of them, and all or nothing. A workbench asks for this because a
	 * setting changed, and settings are DevHub-wide — one reloaded workbench
	 * and five stale ones is a state no workbench can describe, and it shows
	 * up later as a difference nobody can account for. So every window is
	 * asked to unload first, and if any of them vetoes (unsaved work, an
	 * extension refusing) nothing reloads at all.
	 *
	 * Upstream's `CodeWindow.reload` only carries `cli` into the new window
	 * configuration for an extension-development host; for an ordinary window
	 * the reloaded workbench keeps the configuration it already had. That is
	 * upstream's rule, not DevHub's, and every caller that edits the arguments
	 * is an extension-host debugging path, so it is recorded here rather than
	 * worked around.
	 */
	private async reloadEveryWorkbench(cli: NativeParsedArgs): Promise<void> {
		const windows = await appController().workbenchWindows();
		const vetoes = await Promise.all(
			windows.map((window) => this.unload(window, UnloadReason.RELOAD)),
		);
		if (vetoes.some((veto) => veto)) {
			this.log.info(
				"[devhub] relaunch: a workbench vetoed the reload; nothing was reloaded",
			);
			return;
		}
		this.log.info(
			`[devhub] relaunch: reloading ${String(windows.length)} workbench window(s) instead of restarting DevHub`,
		);
		for (const window of windows) {
			window.reload(cli);
		}
	}

	/**
	 * Restarting the whole application, which is the person's call to make.
	 *
	 * Every workspace, terminal and Agent goes with it, and the workbench that
	 * asked knows about none of them. Answering yes on their behalf is the
	 * behaviour this whole file exists to remove.
	 */
	private async restartAllOfDevHub(): Promise<void> {
		const agreed = await askToRestartDevHub();
		if (!agreed) {
			this.log.info("[devhub] relaunch: the restart was declined");
			return;
		}
		this.log.info(
			"[devhub] relaunch: restarting DevHub at the person's request",
		);
		// `app.quit()` and not `app.exit()`: DevHub's own `before-quit`
		// handler is the one shutdown path, and it ends in `app.exit(0)`,
		// which is what makes the relaunch below happen.
		electron.app.relaunch({ args: process.argv.slice(1) });
		electron.app.quit();
	}

	/**
	 * A workbench dying is not a reason for DevHub to die.
	 *
	 * Upstream's `kill` destroys every window and calls `app.exit(code)`. Two
	 * callers reach it: `CodeWindow` when a renderer is gone while running
	 * extension tests from the CLI, and `codeMain`'s startup failure — and the
	 * second one calls `app.exit` directly in DevHub's copy, because a DevHub
	 * that never came up has nothing to keep alive.
	 *
	 * What is left is a crashed workbench, and DevHub already has an answer
	 * for that: the App Shell rebuilds the view and says so on the workspace's
	 * row. Exiting here would take the whole application down for one broken
	 * editor. So this refuses, loudly — the refusal is in the log rather than
	 * silent, because a `kill` that does nothing and says nothing is exactly
	 * the invisible failure that costs hours later.
	 */
	override async kill(code?: number): Promise<void> {
		this.log.error(
			`[devhub] a workbench asked DevHub to exit with code ${String(code ?? 0)}; refused — DevHub does not exit because one workbench died`,
		);
	}
}
