import { describe, expect, it } from "vitest";
import { URI } from "code-oss-dev/out/vs/base/common/uri.js";
import { DevHubWorkspacesHistoryMainService } from "./devhubWorkspacesHistoryMainService.js";

describe("VS Code's recently opened list in DevHub", () => {
	it("is empty", async () => {
		const history = new DevHubWorkspacesHistoryMainService();
		expect(await history.getRecentlyOpened()).toEqual({
			workspaces: [],
			files: [],
		});
	});

	it("stays empty after a workbench opens a folder, a workspace and a file", async () => {
		const history = new DevHubWorkspacesHistoryMainService();
		await history.addRecentlyOpened([
			{ folderUri: URI.file("/projects/one") },
			{
				workspace: {
					id: "w",
					configPath: URI.file("/projects/two.code-workspace"),
				},
			},
			{ fileUri: URI.file("/projects/one/README.md") },
		]);

		expect(await history.getRecentlyOpened()).toEqual({
			workspaces: [],
			files: [],
		});
	});

	it("has nothing to remove and nothing to clear", async () => {
		const history = new DevHubWorkspacesHistoryMainService();
		await history.removeRecentlyOpened([URI.file("/projects/one")]);
		// `confirm` would put a modal dialog on screen upstream; there is nothing
		// to confirm, so nothing is shown and nothing is asked of the user.
		await history.clearRecentlyOpened({ confirm: true });

		expect(await history.getRecentlyOpened()).toEqual({
			workspaces: [],
			files: [],
		});
	});

	it("never announces a change, because there is no state to change", () => {
		const history = new DevHubWorkspacesHistoryMainService();
		let fired = 0;
		history.onDidChangeRecentlyOpened(() => fired++);
		expect(fired).toBe(0);
	});
});
