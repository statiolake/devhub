/**
 * VS Code's "recently opened" list, empty by construction.
 *
 * DevHub owns the history of what was opened. Its sidebar and its workspace
 * picker are that history, and they are the only place it lives — a DevHub
 * window hosts many workbenches at once, so a list kept *inside* VS Code would
 * be a second, per-workbench answer to a question DevHub has already answered,
 * and the two would drift apart the moment either one was edited.
 *
 * So the feature is not present in DevHub, and this class says exactly that:
 * the list is always empty, and adding to it is a no-op. This is not an error
 * being swallowed — nothing failed, and nothing is being retried elsewhere.
 * "Open Recent" is empty here the same way it is empty in a fresh install.
 * (Fence unit 6 / item D5 of the global API fence audit. The OS-side half —
 * `app.addRecentDocument` and the Windows jump list — is fenced separately by
 * unit 3, `shell/appFence.ts`.)
 *
 * Written against the interface rather than derived from
 * `WorkspacesHistoryMainService`, because a subclass would still be the
 * upstream object: it would read the stored list on construction, install the
 * jump list at the `Eventually` phase, and schedule the macOS recent-documents
 * updater. An empty history has no state and nothing to schedule. A side
 * effect of that is the one this file also has to guarantee: a list left in
 * the application storage of an existing install is never read back.
 *
 * Registered for `IWorkspacesHistoryMainService` in `devhubApplication.ts`, in
 * place of upstream's own registration in `CodeApplication.initServices` —
 * that line, and this interface's shape, are what a VS Code bump has to
 * re-check.
 */

import { Event } from "code-oss-dev/out/vs/base/common/event.js";
import type { URI } from "code-oss-dev/out/vs/base/common/uri.js";
import type {
	IRecent,
	IRecentlyOpened,
} from "code-oss-dev/out/vs/platform/workspaces/common/workspaces.js";
import type { IWorkspacesHistoryMainService } from "code-oss-dev/out/vs/platform/workspaces/electron-main/workspacesHistoryMainService.js";

export class DevHubWorkspacesHistoryMainService
	implements IWorkspacesHistoryMainService
{
	declare readonly _serviceBrand: undefined;

	/** Empty is the only state, so there is no change to announce. */
	readonly onDidChangeRecentlyOpened = Event.None;

	async addRecentlyOpened(_recents: IRecent[]): Promise<void> {
		// Nothing to add to. DevHub recorded this in its own model before the
		// workbench was ever asked to open anything.
	}

	async getRecentlyOpened(): Promise<IRecentlyOpened> {
		return { workspaces: [], files: [] };
	}

	async removeRecentlyOpened(_paths: URI[]): Promise<void> {
		// Nothing to remove from.
	}

	async clearRecentlyOpened(_options?: { confirm?: boolean }): Promise<void> {
		// Already clear. Not even the confirmation dialog: there is nothing a
		// person could be agreeing to lose.
	}
}
