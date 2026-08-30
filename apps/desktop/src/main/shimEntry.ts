/**
 * The first thing the main process does.
 *
 * This module exists only so that `main.ts` can put the `BrowserWindow`
 * replacement ahead of every other import, including its own `from 'electron'`.
 * ES module dependencies are evaluated in declaration order, and a top-level
 * `await` keeps that order, so by the time anything else runs the shim is in.
 */

import { installBrowserWindowShim } from './shell/browserWindowShim.js';

await installBrowserWindowShim();
