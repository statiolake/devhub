import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WindowsMainService } from "code-oss-dev/out/vs/platform/windows/electron-main/windowsMainService.js";
import {
	OpenContext,
	type IOpenEmptyConfiguration,
} from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import type { ICodeWindow } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import { DevHubWindowsMainService } from "./devhubWindowsMainService.js";

/** What upstream was asked to open, with the opening itself stubbed out. */
const asked: IOpenEmptyConfiguration[] = [];
const upstream = WindowsMainService.prototype.openEmptyWindow;
WindowsMainService.prototype.openEmptyWindow = function (openConfig) {
	asked.push(openConfig);
	return Promise.resolve([] as ICodeWindow[]);
};
afterEach(() => {
	asked.length = 0;
});
// Left as it was found, for anything else in this process.
afterAll(() => {
	WindowsMainService.prototype.openEmptyWindow = upstream;
});

/** The override reads only `context`, so the prototype can be driven directly. */
const openEmpty = (context: OpenContext): Promise<ICodeWindow[]> =>
	DevHubWindowsMainService.prototype.openEmptyWindow.call(
		Object.create(
			DevHubWindowsMainService.prototype,
		) as DevHubWindowsMainService,
		{ context },
	);

describe("who answers the Dock", () => {
	it("does not grow a workbench when the Dock icon is clicked", () => {
		// The App Shell window hides rather than closes, so Electron reports no
		// visible windows and VS Code's own `activate` handler asks for an empty
		// one. DevHub's answer — bring the window back, with everything still in
		// it — is the only answer, so upstream is never asked.
		void openEmpty(OpenContext.DOCK);
		expect(asked).toEqual([]);
	});

	it("still opens an empty window for everything that is not the Dock", () => {
		void openEmpty(OpenContext.MENU);
		void openEmpty(OpenContext.API);
		void openEmpty(OpenContext.DESKTOP);
		expect(asked.map((request) => request.context)).toEqual([
			OpenContext.MENU,
			OpenContext.API,
			OpenContext.DESKTOP,
		]);
	});
});
