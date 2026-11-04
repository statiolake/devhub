/**
 * The orchestrator's folder on this Mac: `~` expanded, and made when the
 * window's Start asks for the default (`[orchestrator] root`, `~/orchestrator`)
 * and it is not there yet. `devhub --tell orchestrator start --root` never
 * makes one: a typo on a command line must not become a folder.
 */

import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function expandOrchestratorRoot(
	root: string,
	home: string = homedir(),
): string {
	if (root === "~") return home;
	if (root.startsWith("~/")) return join(home, root.slice(2));
	return root;
}

/**
 * The folder, absolute, once it is there. `create`: make it (and its
 * parents) when it is missing; otherwise a missing folder is refused.
 */
export function ensureOrchestratorRoot(
	root: string,
	options: { readonly create: boolean; readonly home?: string },
): string {
	const path = expandOrchestratorRoot(root, options.home);
	let isFolder = false;
	let exists = false;
	try {
		const stat = statSync(path);
		exists = true;
		isFolder = stat.isDirectory();
	} catch {
		exists = false;
	}
	if (!exists && options.create) {
		mkdirSync(path, { recursive: true });
		return path;
	}
	if (!isFolder)
		throw new Error(
			`the orchestrator's folder ${path} is not a folder on this Mac. Make it, or set orchestrator.root to one.`,
		);
	return path;
}
