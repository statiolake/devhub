/**
 * The first thing the main process does.
 *
 * This module exists only so that `main.ts` can put the `BrowserWindow` shim
 * ahead of every other import, including its own `from 'electron'`. ES module
 * dependencies are evaluated in declaration order, so by the time anything
 * else runs the shim is in.
 */

import { electron } from "./electron.js";
import { installBrowserWindowShim } from "./shell/browserWindowShim.js";
import { letAgentsPageDictate } from "./voice/microphonePermission.js";

installBrowserWindowShim();

// Registered here so it runs before `main.ts`'s own `ready` listener, and so
// before VS Code installs its permission handlers on the default session:
// see `voice/microphonePermission.ts`.
electron.app.once("ready", () => {
	letAgentsPageDictate(electron.session.defaultSession);
});
