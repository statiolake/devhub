/**
 * A package of the VS Code submodule's `node_modules`, required from any of
 * DevHub's processes.
 *
 * DevHub takes native packages (node-pty) from the submodule rather than
 * declaring its own, so their ABI is the submodule's Electron's
 * (`terminal/pty.ts`). In a checkout that is a plain `vscode/node_modules`.
 * In a packaged app it is `code-oss-dev/node_modules.asar`
 * (scripts/package-nightly.py), which Node's resolver finds only through VS
 * Code's bootstrap (`enableASARSupport`, bootstrap-node.ts) — installed in
 * main, and in no utility process (the pty host, the conversation engine,
 * the Neovim and process hosts). So the archive is named here outright when
 * the plain require fails: Electron reads an archive in any of its
 * processes, and a package's native files come from
 * `node_modules.asar.unpacked` as they do in main.
 *
 * Every require of a submodule package from DevHub's own code goes through
 * here, so no process depends on which bootstrap it ran.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let fromSubmodule: { require: NodeJS.Require; root: string } | undefined;

function submodule(): { require: NodeJS.Require; root: string } {
	if (fromSubmodule !== undefined) return fromSubmodule;
	// Resolved *from* the submodule's package.json, so a package's own
	// dependencies come from the submodule as well.
	const manifest = createRequire(import.meta.url).resolve(
		"code-oss-dev/package.json",
	);
	fromSubmodule = { require: createRequire(manifest), root: dirname(manifest) };
	return fromSubmodule;
}

function messageOf(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}

/** `name` from the submodule's `node_modules`, or its `node_modules.asar`. */
export function requireFromSubmodule(name: string): unknown {
	const { require, root } = submodule();
	try {
		return require(name);
	} catch (failure: unknown) {
		const archived = join(root, "node_modules.asar", name);
		try {
			return require(archived);
		} catch (second: unknown) {
			throw new Error(
				`${name} could not be loaded: ${messageOf(failure)}; nor from ${archived}: ${messageOf(second)}`,
				{ cause: failure },
			);
		}
	}
}
