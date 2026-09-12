/**
 * Bring up the App Shell before the first workbench asks for a window.
 *
 * Ordering matters and is the whole reason this is a separate step: the shim
 * turns `new BrowserWindow(workbench options)` into a view *inside* the shell,
 * so the shell has to exist first.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeParsedArgs } from "code-oss-dev/out/vs/platform/environment/common/argv.js";
import type { IThemeMainService } from "code-oss-dev/out/vs/platform/theme/electron-main/themeMainService.js";
import { createAppController } from "./appController.js";
import { shellTheme } from "./shellTheme.js";
import {
	registerShellPageProtocol,
	SHELL_ORIGIN,
} from "./shellPageProtocol.js";
import { electron } from "../electron.js";
import {
	beginQuit,
	createShellWindow,
	openShellPage,
	shellWindowIfCreated,
} from "./shellWindow.js";
import { installSettingsWindow, logDirectoryFor } from "./settingsWindow.js";
import { refreshMenu } from "./menu.js";
import { startControlServer } from "../cli/controlServer.js";
import { controlSocketPath } from "../cli/protocol.js";
import { installLauncher } from "../cli/install.js";
import {
	installTerminalLauncher,
	terminalLauncherPath,
} from "../terminal/launcher.js";
import {
	workbenchSettingsPlan,
	type SettingsProblem,
} from "../workbenchDefaults.js";
import { exportTerminalLauncher } from "./loginEnvironment.js";
import { activeProfile } from "../../model/profile.js";
import type { AppErrorWire } from "../../ipc/appShell.js";
import { errorWireAt, withDetail } from "../../model/wire.js";
import { answerFinderOpens, finderOpen } from "./openFromFinder.js";

/** How long a quit waits for the runtimes to let go before leaving anyway. */
const SHUTDOWN_DEADLINE_MS = 3_000;

/** `apps/desktop/out/main/shell` -> `apps/desktop`. */
const APP_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);

/**
 * Write the settings DevHub cannot contribute as defaults; see the module.
 *
 * A file that would not parse is the one outcome that is neither written nor
 * thrown: it is returned, so the caller can say so on screen once there is a
 * screen. Startup carries on without it — the workbench reads the same file
 * with the same parser and has its own answer for it, and an editor that will
 * not open is a far worse thing to do to somebody about a stray comma than a
 * terminal profile that is missing until they fix it.
 */
function ensureWorkbenchDefaults(
	userDataPath: string,
): SettingsProblem | undefined {
	const file = join(userDataPath, "User", "settings.json");

	let existing: string | undefined;
	try {
		existing = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		existing = undefined;
	}

	const plan = workbenchSettingsPlan(existing);
	if (plan.kind === "unreadable") {
		console.error(
			`[devhub] ${file}:${String(plan.problem.line)}:${String(plan.problem.column)} is not valid JSON; workbench defaults not written`,
		);
		return plan.problem;
	}
	if (plan.kind === "answered") return undefined;

	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, plan.text);
	console.log(`[devhub] wrote workbench defaults: ${plan.keys.join(", ")}`);
	return undefined;
}

/** What a broken `User/settings.json` says on screen, and where it is. */
function unreadableSettingsError(
	userDataPath: string,
	problem: SettingsProblem,
): AppErrorWire {
	const file = join(userDataPath, "User", "settings.json");
	return withDetail(
		errorWireAt("workbench_settings_unreadable"),
		`${file}, line ${String(problem.line)}, column ${String(problem.column)}. DevHub left the file alone, so the defaults it writes there are missing until the file is valid.`,
	);
}

export async function bootstrapShell(
	userDataPath: string,
	cliArgs: NativeParsedArgs,
	themeMainService: IThemeMainService,
): Promise<void> {
	// The terminal launcher first, and its path into DevHub's own environment
	// before any window exists: the patched workbench reads `DEVHUB_TERMINAL`
	// synchronously as it builds its terminal profile service, and a window
	// created before this line would build one without an answer. That is why
	// `bootstrapShell` runs before `startup()`. See `codeMain.ts`,
	// `terminal/launcher.ts` and `loginEnvironment.ts`.
	const launcherPath = installTerminalLauncher(
		terminalLauncherPath(userDataPath),
		{
			// The binary running this process is the app's own Electron, in a
			// checkout and in a bundle alike — the same fact the `devhub` CLI's
			// launcher is written with.
			execPath: process.execPath,
			entryScript: join(
				APP_ROOT,
				"out",
				"main",
				"terminal",
				"devhubTerminal.js",
			),
			socketPath: controlSocketPath(userDataPath),
		},
	);
	exportTerminalLauncher(process.env, launcherPath);
	const settingsProblem = ensureWorkbenchDefaults(userDataPath);

	// The colour theme comes first, before the page is servable and before the
	// window exists, because both are created wearing it. VS Code stores the
	// last workbench's window splash for exactly this purpose — it paints its
	// own windows from it while they load — so the shell around them starts in
	// the same colours and never changes colour as the first workbench comes up.
	const palette = shellTheme().restore(
		themeMainService.getWindowSplash(undefined),
		() => shellWindowIfCreated()?.revealedView()?.id,
	);

	const preloadPath = join(APP_ROOT, "out", "preload", "preload.js");
	registerShellPageProtocol(join(APP_ROOT, "dist", "shell"), () =>
		shellTheme().palette(),
	);
	// The window is created first — the controller is built around it, and it
	// paints in the restored palette while the rest of startup happens — but its
	// *page* is not run until the runtimes it will ask for exist. The page asks
	// for its terminal the moment it mounts, and a request that arrives before
	// the handler that answers it produced "No handler registered for
	// 'devhub:terminal:attach'" in the log and a pane saying the connection was
	// unavailable, on a machine where everything was installed and reachable.
	// The race was always there; asking the login shell for its environment
	// (which is part of starting the runtimes) turned it from unlucky into
	// normal. Ordering is the fix, not speed.
	createShellWindow(preloadPath, `${SHELL_ORIGIN}/index.html`, palette);
	const controller = await createAppController(userDataPath, cliArgs);
	if (settingsProblem) {
		controller.noteStartupFailure(
			unreadableSettingsError(userDataPath, settingsProblem),
		);
	}
	shellWindowIfCreated()?.onWindowFocusChanged((focused) => {
		controller.windowFocusChanged(focused);
	});
	shellTheme().onDidChange((next) => {
		shellWindowIfCreated()?.applyPalette(next);
		controller.publishTheme(next);
	});
	await controller.startRuntimes(userDataPath);
	openShellPage();

	// The desktop's door, opened at the same moment and onto the same room.
	// `open-file` has been collecting paths since before `ready` (see
	// `openFromFinder.ts`); this is the point where there is a DevHub to open
	// them in, and what opens them is `openFromCli` — the `devhub` command's own
	// entry point, one line below where the socket is handed the same function.
	answerFinderOpens(finderOpen(controller), (error) =>
		controller.noteFailure(error),
	);

	// DevHub's own front door. It is opened here, once the model and the
	// runtimes behind it exist, because every request it accepts is answered by
	// them — and it is a startup failure rather than a warning if the socket
	// cannot be taken, since a `devhub` command that silently does nothing is
	// worse than one that says DevHub is not running.
	const socketPath = controlSocketPath(userDataPath);

	const control = await startControlServer(socketPath, {
		activate: () => controller.activateFromCli(),
		open: (path, cwd, position, waitMarkerPath) =>
			controller.openFromCli(path, cwd, position, waitMarkerPath),
		waitEnded: (waitMarkerPath) => controller.waitEndedFromCli(waitMarkerPath),
		addAgent: (profileId, args, cwd) =>
			controller.addAgentFromCli(profileId, args, cwd),
		installExtensions: (targets, force, cwd) =>
			controller.installExtensionsFromCli(targets, force, cwd),
		uninstallExtensions: (ids, force) =>
			controller.uninstallExtensionsFromCli(ids, force),
		listExtensions: (showVersions) =>
			controller.listExtensionsFromCli(showVersions),
		version: () => controller.versionFromCli(),
		metrics: () => controller.metricsFromCli(),
		terminalProfile: (root) => controller.terminalProfileFor(root),
		installCli: () =>
			Promise.resolve(
				installLauncher({
					// The binary running this process is the app's own Electron,
					// in a checkout and in a bundle alike, and it is what the
					// launcher runs the CLI with as Node.
					execPath: process.execPath,
					cliScript: join(APP_ROOT, "out", "main", "cli", "devhubCli.js"),
					socketPath,
					commandName: activeProfile().cliCommandName,
					profile: activeProfile().profile,
					home: homedir(),
					pathValue: process.env["PATH"] ?? "",
				}).message,
			),
	});

	// macOS: the dock icon brings the shell back after its window was hidden.
	// DevHub is the app, not the window, and the window it comes back to is the
	// same one, with every workbench, terminal and agent still in it.
	//
	// What that means for a window that is already showing is
	// `ShellWindow.raiseFromAppActivation`, which is where every rule about
	// DevHub coming to the front lives.
	electron.app.on("activate", () => {
		const shell = shellWindowIfCreated();
		if (shell) {
			shell.raiseFromAppActivation();
			return;
		}
		// A window rebuilt after its own was closed has the whole app behind it
		// already, so its page runs at once.
		createShellWindow(
			preloadPath,
			`${SHELL_ORIGIN}/index.html`,
			shellTheme().palette(),
		);
		openShellPage();
	});

	// The state file records that this run ended on purpose, which is what the
	// next launch reads to tell a clean exit from a crash.
	//
	// The wait is bounded because a quit that does not quit is worse than any
	// tidying it was waiting for: a runtime that will not let go leaves the
	// person with an app they cannot close, and the state has already been
	// written by the time the deadline matters.
	//
	// It hangs off `before-quit` rather than `will-quit` because `will-quit`
	// comes after every window has agreed to close, and a workbench view can
	// hold that negotiation open — which leaves the person with an app that
	// will not quit. `before-quit` always fires, so the state is always
	// written and the deadline always applies.
	let quitting = false;
	electron.app.on("before-quit", (event) => {
		if (quitting) return;
		quitting = true;
		// From here the shell window is allowed to close: until now it answered
		// a close by hiding.
		beginQuit();
		event.preventDefault();
		// Nothing new may be accepted from here: the model behind every request
		// is about to be torn down.
		void control.close();
		const deadline = new Promise<void>((resolve) => {
			setTimeout(() => {
				console.warn("[devhub] quit: shutdown did not finish in time");
				resolve();
			}, SHUTDOWN_DEADLINE_MS);
		});
		void Promise.race([controller.shutdown(), deadline]).finally(() => {
			electron.app.exit(0);
		});
	});

	installSettingsWindow({
		store: controller.configStore,
		logDirectory: logDirectoryFor(userDataPath),
		preloadPath,
		previousExit: () => controller.previousExit(),
		launchEnvironment: () => controller.launchEnvironmentValue(),
		loginEnvironment: () => controller.loginEnvironmentValue(),
		adopt: (config) => {
			controller.adoptConfig(config);
		},
		preflightSocket: async (name) => {
			const preflight = await controller.preflightTerminalSocket(name);
			return {
				requestedSocketName: preflight.requestedSocketName,
				state: preflight.state,
				ownedSessionCount: preflight.ownedSessionCount,
				unknownSessionCount: preflight.unknownSessionCount,
			};
		},
		changeSocket: (name) => controller.changeTerminalSocket(name),
	});

	controller.installChords();
	controller.installMenuBar();
	// A Mac menu bar describes the key window, so it is rebuilt when the key
	// window changes as well as when the model does.
	electron.app.on("browser-window-focus", refreshMenu);
	electron.app.on("browser-window-blur", refreshMenu);
}
