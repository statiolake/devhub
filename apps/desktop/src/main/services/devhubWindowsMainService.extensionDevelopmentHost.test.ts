/**
 * The requests with no folder that are not Scratch: an Extension Development
 * Host, the one open request DevHub does not place, and an empty window in
 * place of a dev container's workbench, which is Reopen Folder Locally.
 *
 * A file of its own because the module under test captures upstream's
 * `openInBrowserWindow` off the prototype the moment it loads, so the stub that
 * stands in for "upstream opened a window" has to be installed *before* the
 * import — which means the import cannot be a static one, and a static import
 * of the same module anywhere in the file would hoist above it.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { WindowsMainService } from "code-oss-dev/out/vs/platform/windows/electron-main/windowsMainService.js";
import type { ICodeWindow } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";

interface Internals {
	openInBrowserWindow(options: unknown): Promise<ICodeWindow>;
	getWindowById(id: number): ICodeWindow | undefined;
}

/** What upstream was handed, with the opening itself stubbed out. */
const upstreamAsked: unknown[] = [];
const upstreamWindow = { id: 41 } as ICodeWindow;
(WindowsMainService.prototype as unknown as Internals).openInBrowserWindow =
	function (options) {
		upstreamAsked.push(options);
		return Promise.resolve(upstreamWindow);
	};

const scratch = { id: 7 } as ICodeWindow;
/** The view ids bound to a Workspace whose editor is in a dev container. */
const inContainer = new Set<number>();
const controller = {
	reopenLocallyInsteadOfEmpty: vi.fn((viewId: number) =>
		inContainer.has(viewId),
	),
	scratchWorkbench: vi.fn(() => Promise.resolve(scratch)),
	sendFilesToWorkbench: vi.fn(),
};
vi.mock("../shell/appController.js", () => ({
	appController: () => controller,
}));

const { DevHubWindowsMainService } = await import(
	"./devhubWindowsMainService.js"
);

const openInBrowserWindow = (options: unknown): Promise<ICodeWindow> =>
	(
		DevHubWindowsMainService.prototype as unknown as Internals
	).openInBrowserWindow.call(
		Object.create(DevHubWindowsMainService.prototype) as Internals,
		options,
	);

beforeEach(() => {
	upstreamAsked.length = 0;
	inContainer.clear();
	vi.clearAllMocks();
});

describe("an Extension Development Host is a window of its own", () => {
	it("hands a debug session's request to upstream untouched", async () => {
		// F5 in an extension repository: the debug adapter asks main for a
		// window carrying `extensionDevelopmentPath`, and with no folder of its
		// own. Read as a DevHub open, "no folder" means Scratch — which is where
		// this used to end, with nothing for the debugger to attach to.
		const request = {
			forceNewWindow: true,
			cli: {
				extensionDevelopmentPath: ["/somewhere/extension"],
				debugId: "debug-1",
			},
		};
		expect(await openInBrowserWindow(request)).toBe(upstreamWindow);
		expect(upstreamAsked).toEqual([request]);
	});

	it("stays out of the way even when the request names a folder", async () => {
		// `args: ["${workspaceFolder}"]` in a launch configuration: the folder
		// belongs to the dev-host window, not to DevHub's sidebar, so the
		// Workspace placement below must not see this request either.
		const request = {
			forceNewWindow: true,
			workspace: { id: "w", uri: { scheme: "file", fsPath: "/somewhere" } },
			cli: { extensionDevelopmentPath: ["/somewhere/extension"] },
		};
		expect(await openInBrowserWindow(request)).toBe(upstreamWindow);
		expect(upstreamAsked).toEqual([request]);
	});

	it("does not claim an ordinary request that carries no development path", async () => {
		// The guard is the presence of a development path and nothing else: an
		// empty list is upstream's own "not a development host".
		expect(
			await openInBrowserWindow({ cli: { extensionDevelopmentPath: [] } }),
		).toBe(scratch);
		expect(upstreamAsked).toEqual([]);
	});
});

describe("an empty window in place of a dev container's workbench", () => {
	// Upstream's Close Remote Connection — and anything else that reopens the
	// window it runs in with no folder and no remote — arrives with no
	// workspace and `windowToUse` set to the window that asked. Read as an
	// ordinary empty window it was Scratch: DevHub switched to Scratch and the
	// editor stayed in its container.
	it("reopens that Workspace's editor locally and keeps Scratch out of it", async () => {
		inContainer.add(12);
		const asking = { id: 12 };
		expect(await openInBrowserWindow({ windowToUse: asking })).toBe(asking);
		expect(controller.reopenLocallyInsteadOfEmpty).toHaveBeenCalledWith(12);
		expect(controller.scratchWorkbench).not.toHaveBeenCalled();
		expect(upstreamAsked).toEqual([]);
	});

	it("is still Scratch in place of a workbench on its own machine", async () => {
		expect(await openInBrowserWindow({ windowToUse: { id: 3 } })).toBe(scratch);
		expect(controller.reopenLocallyInsteadOfEmpty).toHaveBeenCalledWith(3);
		expect(controller.scratchWorkbench).toHaveBeenCalledOnce();
	});

	it("is still Scratch when no window is being replaced", async () => {
		expect(await openInBrowserWindow({ forceNewWindow: true })).toBe(scratch);
		expect(controller.reopenLocallyInsteadOfEmpty).not.toHaveBeenCalled();
	});

	it("is still Scratch when the request carries files", async () => {
		inContainer.add(12);
		const filesToOpen = { filesToOpenOrCreate: [] };
		expect(
			await openInBrowserWindow({ windowToUse: { id: 12 }, filesToOpen }),
		).toBe(scratch);
		expect(controller.reopenLocallyInsteadOfEmpty).not.toHaveBeenCalled();
		expect(controller.sendFilesToWorkbench).toHaveBeenCalledWith(
			scratch,
			filesToOpen,
		);
	});
});
