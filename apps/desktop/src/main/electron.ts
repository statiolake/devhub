/**
 * Electron, taken from the CommonJS module object rather than through an ESM
 * import.
 *
 * This is not a style preference. `import { BrowserWindow } from 'electron'`
 * snapshots the module's properties into the ESM namespace the first time
 * anything imports it that way, and DevHub replaces `BrowserWindow` on that
 * module (see `shell/browserWindowShim.ts`). Every main-process file DevHub
 * owns therefore goes through here, so that nothing mints the ESM namespace
 * before the replacement is in place.
 *
 * Types come from the global `Electron` namespace and need no import at all.
 */

import { createRequire } from "node:module";

export const electron: typeof import("electron") = createRequire(
	import.meta.url,
)("electron");
