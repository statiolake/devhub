/**
 * Bring up the App Shell before the first workbench asks for a window.
 *
 * Ordering matters and is the whole reason this is a separate step: the shim
 * turns `new BrowserWindow(workbench options)` into a view *inside* the shell,
 * so the shell has to exist first.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeParsedArgs } from "code-oss-dev/out/vs/platform/environment/common/argv.js";
import { createAppController } from "./appController.js";
import {
	registerShellPageProtocol,
	SHELL_ORIGIN,
} from "./shellPageProtocol.js";
import { electron } from "../electron.js";
import { createShellWindow, shellWindowIfCreated } from "./shellWindow.js";
import { installSettingsWindow, logDirectoryFor } from "./settingsWindow.js";
import { refreshMenu } from "./menu.js";

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
 * A workbench view is chrome inside DevHub's own window, so it must not draw a
 * title bar of its own. These are written once, and only where the person has
 * not already said otherwise.
 */
const WORKBENCH_DEFAULTS: Readonly<Record<string, string | boolean>> = {
	"window.titleBarStyle": "custom",
	"window.customTitleBarVisibility": "never",
	// The workbench forces the title bar back to 'auto' whenever something that
	// lives in it is enabled — the command centre and the layout controls both
	// count — so asking for 'never' means turning those off as well.
	"window.commandCenter": false,
	"workbench.layoutControl.enabled": false,
};

function ensureWorkbenchDefaults(userDataPath: string): void {
	const file = join(userDataPath, "User", "settings.json");

	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(file, "utf8")) as Record<
			string,
			unknown
		>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		settings = {};
	}

	const missing = Object.entries(WORKBENCH_DEFAULTS).filter(
		([key]) => !(key in settings),
	);
	if (missing.length === 0) {
		return;
	}

	for (const [key, value] of missing) {
		settings[key] = value;
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(settings, undefined, "\t")}\n`);
	console.log(
		`[devhub] wrote workbench defaults: ${missing.map(([key]) => key).join(", ")}`,
	);
}

export async function bootstrapShell(
	userDataPath: string,
	cliArgs: NativeParsedArgs,
): Promise<void> {
	ensureWorkbenchDefaults(userDataPath);

	const preloadPath = join(APP_ROOT, "out", "preload", "preload.js");
	registerShellPageProtocol(join(APP_ROOT, "dist", "shell"));
	createShellWindow(preloadPath, `${SHELL_ORIGIN}/index.html`);
	const controller = await createAppController(userDataPath, cliArgs);
	await controller.startRuntimes(userDataPath);

	// macOS: the dock icon brings the shell back after its window was closed.
	// DevHub is the app, not the window, so closing the window is not quitting.
	electron.app.on("activate", () => {
		if (shellWindowIfCreated()) {
			shellWindowIfCreated()?.window.show();
			return;
		}
		createShellWindow(preloadPath, `${SHELL_ORIGIN}/index.html`);
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
		event.preventDefault();
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

	controller.installMenuBar();
	// A Mac menu bar describes the key window, so it is rebuilt when the key
	// window changes as well as when the model does.
	electron.app.on("browser-window-focus", refreshMenu);
	electron.app.on("browser-window-blur", refreshMenu);
}
