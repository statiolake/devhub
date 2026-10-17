/**
 * Which DevHub terminal a workbench window is opened with.
 *
 * DevHub names it in the `cli` of its own `open` call, which upstream spreads
 * into the window configuration; a reload or a reopen DevHub did not ask for
 * carries over the one the window it replaces had. See `windowTerminal.ts`.
 *
 * A file of its own for the reason
 * `devhubWindowsMainService.extensionDevelopmentHost.test.ts` is: the module
 * under test captures upstream's `openInBrowserWindow` when it loads, so the
 * stub has to be in place before the (dynamic) import.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { URI } from "code-oss-dev/out/vs/base/common/uri.js";
import { WindowsMainService } from "code-oss-dev/out/vs/platform/windows/electron-main/windowsMainService.js";
import type { ICodeWindow } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import {
	cliWithWindowTerminal,
	inheritWindowTerminal,
	type WindowTerminal,
} from "./windowTerminal.js";

interface Internals {
	openInBrowserWindow(options: unknown): Promise<ICodeWindow>;
	getWindowById(id: number): ICodeWindow | undefined;
	getWindows(): ICodeWindow[];
	getLastActiveWindow(): ICodeWindow | undefined;
}

/** The `cli` upstream was handed, with the opening itself stubbed out. */
const upstreamCli: unknown[] = [];
const opened = { id: 41 } as ICodeWindow;
(WindowsMainService.prototype as unknown as Internals).openInBrowserWindow =
	function (options) {
		upstreamCli.push((options as { cli?: unknown }).cli);
		return Promise.resolve(opened);
	};

const controller = {
	viewIdForEditorKey: vi.fn((): number | undefined => undefined),
	bindEditorKeyView: vi.fn(),
	noteLocation: vi.fn(),
	assertArrangement: vi.fn(),
};
vi.mock("../shell/appController.js", () => ({
	appController: () => controller,
}));

const { DevHubWindowsMainService } = await import(
	"./devhubWindowsMainService.js"
);

const LAUNCHER = "/Users/me/.devhub/bin/devhub-terminal";
const LOCAL = { cwd: "/Users/me/src/app", args: ["--workspace", "w1"] };
const folder = (path: string) => ({
	id: `id:${path}`,
	uri: URI.file(path),
});
const windowOf = (id: number, config: object): ICodeWindow =>
	({ id, config }) as unknown as ICodeWindow;

/** The override, on a service whose window list is `windows`. */
function service(windows: ICodeWindow[], lastActive?: ICodeWindow) {
	const self = Object.create(DevHubWindowsMainService.prototype) as Internals;
	self.getWindows = () => windows;
	self.getLastActiveWindow = () => lastActive;
	self.getWindowById = (id) => windows.find((w) => w.id === id);
	return (options: object) =>
		(
			DevHubWindowsMainService.prototype as unknown as Internals
		).openInBrowserWindow.call(self, options);
}

beforeEach(() => {
	upstreamCli.length = 0;
	vi.clearAllMocks();
});

describe("the window's DevHub terminal", () => {
	it("is what DevHub's own open names, in cli", async () => {
		const open = service([]);
		const cli = cliWithWindowTerminal(
			{ _: [] },
			{ devhubTerminalLauncher: LAUNCHER, devhubTerminalLocal: LOCAL },
		);
		await open({ workspace: folder("/src/app"), forceNewWindow: true, cli });
		expect(upstreamCli).toEqual([
			{ _: [], devhubTerminalLauncher: LAUNCHER, devhubTerminalLocal: LOCAL },
		]);
	});

	it("is none when DevHub's own open says none, whatever the window before had", async () => {
		// The open that decides it is the only one that does: "none on this
		// machine" is an answer, not a gap to fill from another window.
		const before = windowOf(3, {
			workspace: folder("/src/app"),
			devhubTerminalLauncher: LAUNCHER,
		});
		const open = service([before], before);
		const cli = cliWithWindowTerminal(
			{},
			{ devhubTerminalLauncher: undefined },
		);
		await open({ workspace: folder("/src/app"), windowToUse: before, cli });
		expect(upstreamCli).toEqual([{ devhubTerminalLauncher: undefined }]);
	});

	it("survives a reload through open, which builds a fresh configuration", async () => {
		// Remote - SSH resolves its authority by reopening the window it runs
		// in through `open`: `windowToUse` is that window, and `cli` is the
		// process's arguments, which name no launcher.
		const reloading = windowOf(5, {
			workspace: folder("/old"),
			devhubTerminalLauncher: LAUNCHER,
		});
		const open = service([reloading], reloading);
		await open({
			workspace: folder("/src/app"),
			windowToUse: reloading,
			cli: { _: [], verbose: false },
		});
		expect(upstreamCli).toEqual([
			{ _: [], verbose: false, devhubTerminalLauncher: LAUNCHER },
		]);
	});

	it("survives a reuse of the last active window, upstream's other reuse", async () => {
		const active = windowOf(6, {
			devhubTerminalLauncher: LAUNCHER,
			devhubTerminalLocal: LOCAL,
		});
		const open = service([active], active);
		await open({ workspace: folder("/src/app"), cli: {} });
		expect(upstreamCli).toEqual([
			{ devhubTerminalLauncher: LAUNCHER, devhubTerminalLocal: LOCAL },
		]);
	});

	it("survives a reopen after the renderer died", async () => {
		// `CodeWindow.destroyWindow` asks for a new window for the same
		// workspace while the dead one is still in the list.
		const dead = windowOf(8, {
			workspace: folder("/src/app"),
			devhubTerminalLauncher: LAUNCHER,
			devhubTerminalLocal: LOCAL,
		});
		const other = windowOf(9, {
			workspace: folder("/elsewhere"),
			devhubTerminalLauncher: "/other",
		});
		const open = service([other, dead], other);
		await open({
			workspace: folder("/src/app"),
			forceNewWindow: true,
			cli: { _: [] },
		});
		expect(upstreamCli).toEqual([
			{ _: [], devhubTerminalLauncher: LAUNCHER, devhubTerminalLocal: LOCAL },
		]);
	});

	it("is not taken from an agent sessions window or an unrelated new window", async () => {
		const sessions = windowOf(10, {
			isSessionsWindow: true,
			devhubTerminalLauncher: LAUNCHER,
		});
		await service(
			[sessions],
			sessions,
		)({
			workspace: folder("/src/app"),
			cli: { _: [] },
		});
		const unrelated = windowOf(11, {
			workspace: folder("/elsewhere"),
			devhubTerminalLauncher: LAUNCHER,
		});
		await service(
			[unrelated],
			unrelated,
		)({
			workspace: folder("/src/app"),
			forceNewWindow: true,
			cli: { _: [] },
		});
		expect(upstreamCli).toEqual([{ _: [] }, { _: [] }]);
	});
});

describe("inheritWindowTerminal", () => {
	const options = { cli: { _: [] as string[] } };

	it("leaves a request alone when there is nothing to inherit", () => {
		expect(inheritWindowTerminal(options, undefined)).toBe(options);
		expect(inheritWindowTerminal(options, { config: {} })).toBe(options);
	});

	it("never overrides a request DevHub made", () => {
		const own = {
			cli: cliWithWindowTerminal({}, { devhubTerminalLauncher: "/mine" }),
		};
		const from: WindowTerminal = { devhubTerminalLauncher: LAUNCHER };
		expect(inheritWindowTerminal(own, { config: from })).toBe(own);
	});

	it("does not change the request it was given", () => {
		const result = inheritWindowTerminal(options, {
			config: { devhubTerminalLauncher: LAUNCHER },
		});
		expect(result).not.toBe(options);
		expect(options.cli).toEqual({ _: [] });
	});
});
