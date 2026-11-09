/**
 * Electron, taken from the CommonJS module object rather than through an ESM
 * import.
 *
 * Every main-process file DevHub owns goes through here, which is also the
 * one module a test replaces (`vi.mock("../electron.js")`) to run main's code
 * without an app.
 *
 * Types come from the global `Electron` namespace and need no import at all.
 */

import { createRequire } from "node:module";

export const electron: typeof import("electron") = createRequire(
	import.meta.url,
)("electron");
