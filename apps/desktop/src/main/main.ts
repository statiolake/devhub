/**
 * The file Electron runs (apps/desktop/package.json "main", and the packaged
 * app's `Resources/app/package.json`): DevHub's main process, from the first
 * line.
 *
 * It used to be a copy of VS Code's `src/main.ts`, which booted VS Code's
 * main process — its ESM bootstrap, its DI container, its single-instance
 * server — with DevHub's shell started inside it. DevHub no longer has VS
 * Code (docs/without-vscode.md); the copy is in `retired-vscode/`. What is
 * left is what was DevHub's in it, in the order it has to happen:
 *
 *   1. `./shimEntry.js` first: the quit trace and the microphone permission,
 *      before anything can quit or ask.
 *   2. The profile's user-data directory, its one-time migration, the main
 *      log and the event-loop monitor — before anything derives a path or
 *      writes a line.
 *   3. The app's name and `userData` path, then the single-instance lock,
 *      which Electron takes in that directory: two DevHubs of one profile are
 *      one DevHub, two profiles are two.
 *   4. `devhub-app:`, the pages' scheme, registered as privileged before
 *      `ready`, as Electron requires.
 *   5. Finder's `open-file` and the system's `open-url` (a `devhub:` link
 *      from Slack or a browser), listened for before `ready` (they fire
 *      earlier), and the `devhub` scheme claimed for this DevHub.
 *   6. On `ready`: the process host, then the shell (`bootstrapShell`), then
 *      the shell is told it may serve everything (`markReady`), and the
 *      links that waited are followed.
 */

// The quit trace and the microphone permission. MUST stay the first import.
import "./shimEntry.js";

import minimist from "minimist";
import { electron } from "./electron.js";
import { migrateUserDataDirectory } from "./userDataMigration.js";
import { installMainLog, mainLogPath } from "./diagnostics/mainLog.js";
import { startEventLoopLagMonitor } from "./diagnostics/eventLoopLag.js";
import { processHostRunner } from "./processHost/client.js";
import { setChildRunner } from "./terminal/command.js";
import { setStreamRunner } from "./runtime/byteStream.js";
import { watchForFinderOpens } from "./shell/openFromFinder.js";
import {
	answerDevhubUrls,
	claimDevhubScheme,
	offerDevhubUrls,
	watchForDevhubUrls,
} from "./shell/openFromUrl.js";
import { bootstrapShell } from "./shell/bootstrapShell.js";
import { appController } from "./shell/appController.js";
import { shellWindowIfCreated } from "./shell/shellWindow.js";
import { activeProfile } from "../model/profile.js";

const { app, protocol, Menu } = electron;

const args = minimist(process.argv.slice(1), {
	string: ["user-data-dir"],
});

// 2. Which DevHub this is (model/profile.ts derives every location from it).
// An explicit --user-data-dir still wins, for the scratch runs that pass one.
const profile = activeProfile();
const userDataPath =
	typeof args["user-data-dir"] === "string" && args["user-data-dir"] !== ""
		? args["user-data-dir"]
		: profile.userDataDirectory;
migrateUserDataDirectory(userDataPath);
// Main's console goes to <userData>/logs/devhub-main.log as well, from here
// on — a packaged app's stdout is nobody's (diagnostics/mainLog.ts).
installMainLog(mainLogPath(userDataPath));
// A line in that log whenever main's event loop was held up, and by what.
startEventLoopLagMonitor();

// 3. Electron's name for the app. The menu bar, the Dock and the window
// switcher read the running bundle's Info.plist instead, which is DevHub's in
// both modes: the packaged app (scripts/package-nightly.py) and, on a Mac,
// the branded clone of npm's Electron a source run boots (dev.sh).
app.setName(profile.applicationName);
app.setPath("userData", userDataPath);

if (!app.requestSingleInstanceLock()) {
	// Another DevHub of this profile is running: it is the one the person
	// means. The `devhub` command reaches it over its control socket; a second
	// launch from the Dock or a shell brings it to the front (below) and ends.
	console.log(
		"[devhub] another DevHub of this profile is running; handing over to it",
	);
	app.exit(0);
} else {
	app.on("second-instance", (_event, argv) => {
		shellWindowIfCreated()?.raiseFromAppActivation();
		// A link opened by launching DevHub with it (not macOS, which sends
		// the running app `open-url` instead): followed here.
		offerDevhubUrls(argv);
	});

	// No default menu: the shell sets DevHub's own (`shell/menu.ts`).
	Menu.setApplicationMenu(null);

	// 4. The pages' own scheme, served from one directory only
	// (shell/shellPageProtocol.ts).
	protocol.registerSchemesAsPrivileged([
		{
			scheme: "devhub-app",
			privileges: {
				secure: true,
				standard: true,
				supportFetchAPI: true,
				corsEnabled: true,
				codeCache: true,
			},
		},
	]);

	// 5. macOS: a file dropped on a DevHub that is not running yet arrives as
	// `open-file` before `ready`; `openFromFinder.ts` queues it until there is
	// a shell to open it in.
	watchForFinderOpens();
	// And a `devhub:` link, the same way (`openFromUrl.ts`).
	watchForDevhubUrls(process.argv.slice(1));
	claimDevhubScheme(profile.isDefault);

	// DevHub is the app, not its window: closing the window hides it on macOS
	// (`shellWindow.ts`), and the app stays until it is quit. Elsewhere the
	// last window closing is the end, as Electron's default would have it.
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});

	app.once("ready", () => {
		void onReady().catch((error: unknown) => {
			console.error("[devhub] startup failed:", error);
			app.exit(1);
		});
	});
}

async function onReady(): Promise<void> {
	// tmux, git and the Agents' host scripts are started by a utility process
	// from here on, not on main's thread (processHost/client.ts), and so are
	// the long-lived streams, a remote Agent's journal among them, unless
	// `DEVHUB_BYTESTREAMS_IN_MAIN=1`. Let go of it last: what shutting down
	// still runs starts in main again.
	const processHost = processHostRunner();
	setChildRunner(processHost);
	if (process.env["DEVHUB_BYTESTREAMS_IN_MAIN"] !== "1") {
		setStreamRunner(processHost);
	}
	app.once("quit", () => {
		setChildRunner(undefined);
		setStreamRunner(undefined);
		processHost.dispose();
	});

	await bootstrapShell(userDataPath);
	// Everything the shell projects is available once its runtimes are. Until
	// then the page shows "Connecting…" rather than an empty shell that looks
	// like a state.
	appController().markReady();
	// A link that launched DevHub, or arrived while it started, is followed
	// now that there is a model to find its place in.
	const controller = appController();
	answerDevhubUrls(
		(url) => controller.openDevhubUrl(url),
		(error) => {
			controller.noteFailure(error);
		},
	);
}
