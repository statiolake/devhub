/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub's init.ts: `import { defineCommand } from "devhub"`.
// DevHub writes this file into <config dir>/.types/ on every start; edits to
// that copy are overwritten.

declare module 'devhub' {

	/** How a command shows in "DevHub: Run init.ts Command…". */
	export interface CommandOptions {
		/** The name in the list; the id when not given. */
		readonly title?: string;
	}

	/**
	 * Defines the command `id` (it is `user.<name>`: letters, digits, `_`, `.`,
	 * `-`) for keybindings.json, `devhub.vim.exCommands`, `executeCommand` and
	 * "DevHub: Run init.ts Command…". `handler` gets the command's arguments (a
	 * keybinding's `args`) and its value is the command's.
	 *
	 * Only while init.ts runs (not later, not in a callback). When init.ts is
	 * saved, the commands of the previous run go away and the new run's take
	 * their place; a run that throws changes nothing.
	 */
	export function defineCommand(id: `user.${string}`, handler: (...args: any[]) => unknown, options?: CommandOptions): void;
}

/** Node's require, from the config directory (untyped: there are no Node types here). */
declare function require(id: string): any;
