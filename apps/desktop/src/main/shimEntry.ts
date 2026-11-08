/**
 * The first thing the main process does.
 *
 * `main.ts` imports this ahead of everything else. ES module dependencies are
 * evaluated in declaration order, so what is installed here is in place
 * before any other module runs.
 *
 * (It used to install a `BrowserWindow` shim that turned VS Code's workbench
 * windows into views inside the shell, hence the name; DevHub has no VS Code
 * any more and the shim is in `retired-vscode/`.)
 */

import { electron } from "./electron.js";
import { letAgentsPageDictate } from "./voice/microphonePermission.js";
import { installQuitTrace } from "./shell/quitTrace.js";

// Before anything can quit: every way out says who asked (`quitTrace.ts`).
installQuitTrace(electron.app, process);

// Registered here so it runs before `main.ts`'s own `ready` listener: see
// `voice/microphonePermission.ts`.
electron.app.once("ready", () => {
	letAgentsPageDictate(electron.session.defaultSession);
});
